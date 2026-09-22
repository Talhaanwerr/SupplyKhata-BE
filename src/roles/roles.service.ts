import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AssignPermissionsDto } from './dto/assign-permissions.dto';
import { AssignRoleToUserDto } from './dto/assign-role-to-user.dto';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { ListRolesQueryDto } from './dto/list-roles-query.dto';

/** System roles visible inside a tenant workspace (never super_admin). */
const TENANT_SYSTEM_ROLE_SLUGS = ['tenant_owner', 'tenant_admin', 'manager', 'rider'] as const;

/** Permission modules only Super Admin may manage / assign. */
const SA_ONLY_PERMISSION_MODULES = ['tenants', 'subscriptions', 'feature-flags'] as const;

/** Activity Logs: tenants may only assign read (not create/update/delete/manage). */
const TENANT_ALLOWED_AUDIT_ACTIONS = ['read'] as const;

function tenantPermissionWhere() {
  return {
    OR: [
      { module: { notIn: [...SA_ONLY_PERMISSION_MODULES, 'audit-logs'] } },
      { module: 'audit-logs', action: { in: [...TENANT_ALLOWED_AUDIT_ACTIONS] } },
    ],
  };
}

const ROLE_SELECT = {
  id: true,
  tenantId: true,
  name: true,
  slug: true,
  description: true,
  isSystem: true,
  createdAt: true,
  updatedAt: true,
  permissions: {
    select: {
      permission: {
        select: { id: true, module: true, action: true, description: true },
      },
    },
  },
  _count: { select: { userRoles: true } },
} as const;

function slugifyRoleName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  if (!slug) throw new BadRequestException('Could not derive a valid slug from role name');
  return slug;
}

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
  ) {}

  // ─── Roles CRUD ────────────────────────────────────────────────────────

  async listRoles(tenantId: string, isSuperAdmin: boolean, query: ListRolesQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const { skip, take } = getPaginationParams({ page, limit });

    const search = query.search?.trim();
    const scopeOr = isSuperAdmin
      ? [{ tenantId: null as string | null }, { tenantId }]
      : [
          { tenantId },
          {
            tenantId: null as string | null,
            slug: { in: [...TENANT_SYSTEM_ROLE_SLUGS] },
          },
        ];

    const where = {
      OR: scopeOr,
      ...(search
        ? {
            AND: [
              {
                OR: [
                  { name: { contains: search } },
                  { slug: { contains: search } },
                  { description: { contains: search } },
                ],
              },
            ],
          }
        : {}),
    };

    const [roles, total] = await Promise.all([
      this.prisma.role.findMany({
        where,
        select: ROLE_SELECT,
        orderBy: [{ isSystem: 'desc' }, { name: 'asc' }],
        skip,
        take,
      }),
      this.prisma.role.count({ where }),
    ]);

    return {
      items: roles.map(this.formatRole),
      meta: buildPaginationMeta(total, page, limit),
    };
  }

  async getRole(id: string, tenantId: string, isSuperAdmin: boolean) {
    const role = await this.prisma.role.findUnique({
      where: { id },
      select: ROLE_SELECT,
    });

    if (!role) throw new NotFoundException('Role not found');
    this.assertRoleAccess(role, tenantId, isSuperAdmin);
    return this.formatRole(role);
  }

  async createRole(dto: CreateRoleDto, tenantId: string, actorId: string) {
    const slug = dto.slug?.trim() || slugifyRoleName(dto.name);

    const existing = await this.prisma.role.findFirst({
      where: { tenantId, slug },
    });
    if (existing) throw new ConflictException(`Role slug '${slug}' already exists`);

    const role = await this.prisma.role.create({
      data: {
        tenantId,
        name: dto.name,
        slug,
        description: dto.description,
        isSystem: false,
      },
      select: ROLE_SELECT,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'CREATE',
      entityId: role.id,
      newValue: { name: role.name, slug: role.slug },
    });

    return this.formatRole(role);
  }

  async updateRole(
    id: string,
    dto: UpdateRoleDto,
    tenantId: string,
    isSuperAdmin: boolean,
    actorId: string,
  ) {
    const role = await this.prisma.role.findUnique({ where: { id }, select: ROLE_SELECT });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('System roles cannot be modified');
    this.assertRoleAccess(role, tenantId, isSuperAdmin);

    const updated = await this.prisma.role.update({
      where: { id },
      data: dto,
      select: ROLE_SELECT,
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'UPDATE',
      entityId: id,
      oldValue: { name: role.name, description: role.description },
      newValue: dto,
    });

    return this.formatRole(updated);
  }

  async deleteRole(id: string, tenantId: string, isSuperAdmin: boolean, actorId: string) {
    const role = await this.prisma.role.findUnique({ where: { id } });
    if (!role) throw new NotFoundException('Role not found');
    if (role.isSystem) throw new ForbiddenException('System roles cannot be deleted');
    this.assertRoleAccess(role, tenantId, isSuperAdmin);

    const assignedUsers = await this.prisma.userRole.count({ where: { roleId: id } });
    if (assignedUsers > 0) {
      throw new ConflictException(
        `Cannot delete role: it is assigned to ${assignedUsers} user(s). Unassign it first.`,
      );
    }

    await this.prisma.role.delete({ where: { id } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'DELETE',
      entityId: id,
      oldValue: { name: role.name, slug: role.slug },
    });
  }

  // ─── Permissions ───────────────────────────────────────────────────────

  async listPermissions(isSuperAdmin: boolean) {
    const perms = await this.prisma.permission.findMany({
      where: isSuperAdmin ? undefined : tenantPermissionWhere(),
      orderBy: [{ module: 'asc' }, { action: 'asc' }],
    });
    return perms;
  }

  /**
   * Replaces the permission set on a role (set-based sync).
   * For tenants: only syncs non-platform modules; existing SA-only grants stay untouched.
   */
  async assignPermissions(
    roleId: string,
    dto: AssignPermissionsDto,
    tenantId: string,
    isSuperAdmin: boolean,
    actorId: string,
  ) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    this.assertRoleAccess(role, tenantId, isSuperAdmin);
    if (!isSuperAdmin && role.slug === 'super_admin') {
      throw new ForbiddenException('Cannot modify Super Admin permissions');
    }

    const [existing, catalog] = await Promise.all([
      this.prisma.rolePermission.findMany({ where: { roleId }, select: { permissionId: true } }),
      this.prisma.permission.findMany({
        where: isSuperAdmin ? undefined : tenantPermissionWhere(),
        select: { id: true },
      }),
    ]);

    const catalogIds = new Set(catalog.map((p) => p.id));
    const incoming = dto.permissionIds.filter((id) => catalogIds.has(id));

    if (isSuperAdmin) {
      const found = await this.prisma.permission.findMany({
        where: { id: { in: dto.permissionIds } },
        select: { id: true },
      });
      if (found.length !== dto.permissionIds.length) {
        throw new BadRequestException('One or more permission IDs are invalid');
      }
    } else if (dto.permissionIds.some((id) => !catalogIds.has(id))) {
      throw new ForbiddenException(
        'Cannot assign platform-only permissions (tenants, subscriptions, feature-flags, or non-read audit-logs)',
      );
    }

    const syncableExisting = existing
      .map((e) => e.permissionId)
      .filter((id) => isSuperAdmin || catalogIds.has(id));
    const existingSet = new Set(syncableExisting);
    const incomingSet = new Set(isSuperAdmin ? dto.permissionIds : incoming);
    const finalIncoming = isSuperAdmin ? dto.permissionIds : incoming;

    const toAdd = finalIncoming.filter((id) => !existingSet.has(id));
    const toRemove = [...existingSet].filter((id) => !incomingSet.has(id));

    await this.prisma.$transaction([
      ...(toRemove.length
        ? [
            this.prisma.rolePermission.deleteMany({
              where: { roleId, permissionId: { in: toRemove } },
            }),
          ]
        : []),
      ...(toAdd.length
        ? [
            this.prisma.rolePermission.createMany({
              data: toAdd.map((permissionId) => ({ roleId, permissionId })),
              skipDuplicates: true,
            }),
          ]
        : []),
    ]);

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'ASSIGN_PERMISSIONS',
      entityId: roleId,
      newValue: { permissionIds: finalIncoming },
    });
  }

  async removePermission(
    roleId: string,
    permissionId: string,
    tenantId: string,
    isSuperAdmin: boolean,
    actorId: string,
  ) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Role not found');
    this.assertRoleAccess(role, tenantId, isSuperAdmin);

    await this.prisma.rolePermission.deleteMany({ where: { roleId, permissionId } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'REMOVE_PERMISSION',
      entityId: roleId,
      oldValue: { permissionId },
    });
  }

  // ─── User–Role assignment ──────────────────────────────────────────────

  async assignRoleToUser(
    userId: string,
    dto: AssignRoleToUserDto,
    actorId: string,
    actorTenantId: string,
    isSuperAdmin: boolean,
  ) {
    const targetTenantId = isSuperAdmin && dto.tenantId ? dto.tenantId : actorTenantId;

    const [member, role] = await Promise.all([
      this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId, tenantId: targetTenantId } },
        select: { userId: true },
      }),
      this.prisma.role.findUnique({ where: { id: dto.roleId } }),
    ]);

    if (!member) throw new NotFoundException('User not found in this tenant');
    if (!role) throw new NotFoundException('Role not found');

    // Prevent assigning Super Admin or roles outside the target tenant scope
    if (!isSuperAdmin && role.slug === 'super_admin') {
      throw new ForbiddenException('Cannot assign the Super Admin role');
    }
    if (role.tenantId && role.tenantId !== targetTenantId) {
      throw new ForbiddenException('Cannot assign a role from a different tenant');
    }

    await this.prisma.userRole.upsert({
      where: { userId_roleId_tenantId: { userId, roleId: dto.roleId, tenantId: targetTenantId } },
      update: {},
      create: { userId, roleId: dto.roleId, tenantId: targetTenantId, assignedById: actorId },
    });

    await this.audit.write({
      tenantId: targetTenantId,
      actorId,
      module: 'roles',
      action: 'ASSIGN_ROLE_TO_USER',
      entityId: userId,
      newValue: { roleId: dto.roleId },
    });
  }

  async removeRoleFromUser(
    userId: string,
    roleId: string,
    actorId: string,
    actorTenantId: string,
    isSuperAdmin: boolean,
    targetTenantId?: string,
  ) {
    const tenantId = isSuperAdmin && targetTenantId ? targetTenantId : actorTenantId;

    await this.prisma.userRole.deleteMany({ where: { userId, roleId, tenantId } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'roles',
      action: 'REMOVE_ROLE_FROM_USER',
      entityId: userId,
      oldValue: { roleId },
    });
  }

  async getUserRoles(userId: string, tenantId: string, isSuperAdmin: boolean) {
    // Validate user is in the given tenant (or skip check for SA)
    if (!isSuperAdmin) {
      const member = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId, tenantId } },
        select: { userId: true },
      });
      if (!member) throw new NotFoundException('User not found');
    } else {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true },
      });
      if (!user) throw new NotFoundException('User not found');
    }

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId, tenantId },
      select: {
        id: true,
        tenantId: true,
        assignedById: true,
        createdAt: true,
        role: { select: { id: true, name: true, slug: true, isSystem: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    return userRoles;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Ensure a non-super-admin can only access roles that belong to their tenant or allowed system roles. */
  private assertRoleAccess(
    role: { tenantId: string | null; isSystem: boolean; slug?: string },
    tenantId: string,
    isSuperAdmin: boolean,
  ) {
    if (isSuperAdmin) return;
    if (role.slug === 'super_admin') {
      throw new ForbiddenException('Access to this role is not allowed');
    }
    if (role.tenantId !== null && role.tenantId !== tenantId) {
      throw new ForbiddenException('Access to this role is not allowed');
    }
    if (
      role.tenantId === null &&
      role.slug &&
      !(TENANT_SYSTEM_ROLE_SLUGS as readonly string[]).includes(role.slug)
    ) {
      throw new ForbiddenException('Access to this role is not allowed');
    }
  }

  private formatRole(role: {
    id: string;
    tenantId: string | null;
    name: string;
    slug: string;
    description: string | null;
    isSystem: boolean;
    createdAt: Date;
    updatedAt: Date;
    permissions: {
      permission: { id: string; module: string; action: string; description: string | null };
    }[];
    _count?: { userRoles: number };
  }) {
    return {
      id: role.id,
      tenantId: role.tenantId,
      name: role.name,
      slug: role.slug,
      description: role.description,
      isSystem: role.isSystem,
      createdAt: role.createdAt,
      updatedAt: role.updatedAt,
      permissions: role.permissions.map((rp) => rp.permission),
      _count: role._count ?? { userRoles: 0 },
    };
  }
}
