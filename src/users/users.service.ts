import {
  Injectable,
  Logger,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogsService } from '../audit-logs/audit-logs.service';
import { MailService } from '../mail/mail.service';
import { getPaginationParams, buildPaginationMeta } from '../common/helpers/pagination.helper';
import { PaginatedData } from '../common/types/api-response.type';
import { MemberStatus } from '../common/enums/user-status.enum';
import { InviteUserDto } from './dto/invite-user.dto';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { ListUsersQueryDto } from './dto/list-users-query.dto';
import { AssignUserRolesDto } from './dto/assign-user-roles.dto';
import { ListStaffQueryDto } from './dto/list-staff-query.dto';

// Fields selected from User table when building list / detail responses.
const USER_FIELDS_FROM_USER = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  emailVerified: true,
  emailVerifiedAt: true,
  avatarUrl: true,
  timezone: true,
  isSuperAdmin: true,
  createdAt: true,
  updatedAt: true,
} as const;

type UserListRole = {
  id: string;
  name: string;
  slug: string;
  isSystem: boolean;
};

type UserListItem = {
  id: string;
  tenantId: string;
  email: string;
  firstName: string;
  lastName: string;
  status: MemberStatus;
  emailVerified: boolean;
  avatarUrl: string | null;
  timezone: string | null;
  isSuperAdmin: boolean;
  invitedById: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Roles assigned in this tenant (included on tenant user list). */
  roles?: UserListRole[];
  memberships?: Array<{
    tenantId: string;
    tenantName: string;
    tenantSlug: string;
    status: MemberStatus;
    roles: UserListRole[];
  }>;
};

/** Detail endpoint: assignment metadata + role fields (matches FE UserRoleInfo). */
type UserDetailRole = UserListRole & {
  assignmentId: string;
  assignedAt: Date;
};

type UserDetail = Omit<UserListItem, 'roles'> & {
  emailVerifiedAt: Date | null;
  roles: UserDetailRole[];
};

type PlatformUserRecord = {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  emailVerified: boolean;
  avatarUrl: string | null;
  timezone: string | null;
  isSuperAdmin: boolean;
  createdAt: Date;
  updatedAt: Date;
  memberships: Array<{
    tenantId: string;
    status: MemberStatus;
    invitedById: string | null;
    createdAt: Date;
    updatedAt: Date;
    tenant: { name: string; slug: string; deletedAt: Date | null };
  }>;
};

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);
  private readonly frontendUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditLogsService,
    private readonly mail: MailService,
    private readonly configService: ConfigService,
  ) {
    this.frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
  }

  // ─── Invite ────────────────────────────────────────────────────────────
  // Invite flow has two paths:
  //   A) Existing global user  → create TenantMember only + send "join workspace" email
  //   B) New user              → create User + TenantMember + send invite/set-password email

  async invite(
    dto: InviteUserDto,
    tenantId: string,
    actorId: string,
  ): Promise<UserListItem & { emailSent: boolean }> {
    const email = dto.email.toLowerCase();

    // Enforce allowed email domains from tenant settings (empty = allow any)
    const settings = await this.prisma.tenantSettings.findUnique({
      where: { tenantId },
      select: { allowedDomains: true },
    });
    const allowed = Array.isArray(settings?.allowedDomains)
      ? (settings!.allowedDomains as unknown[]).filter((d): d is string => typeof d === 'string')
      : [];
    if (allowed.length > 0) {
      const domain = email.split('@')[1] ?? '';
      if (!allowed.includes(domain)) {
        throw new BadRequestException(
          `Invites are restricted to these email domains: ${allowed.join(', ')}`,
        );
      }
    }

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        deletedAt: true,
      },
    });

    // Soft-deleted account with same email → restore, then invite like a new user
    if (existingUser?.deletedAt) {
      await this.prisma.user.update({
        where: { id: existingUser.id },
        data: {
          deletedAt: null,
          firstName: dto.firstName,
          lastName: dto.lastName,
        },
      });

      const alreadyMember = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId: existingUser.id, tenantId } },
      });
      if (alreadyMember) {
        await this.prisma.tenantMember.update({
          where: { userId_tenantId: { userId: existingUser.id, tenantId } },
          data: {
            status: MemberStatus.INVITED,
            invitedById: actorId,
            joinedAt: null,
          },
        });
      } else {
        await this.prisma.tenantMember.create({
          data: {
            userId: existingUser.id,
            tenantId,
            status: MemberStatus.INVITED,
            invitedById: actorId,
          },
        });
      }

      if (dto.roleIds?.length) {
        await this.syncRoles(existingUser.id, tenantId, dto.roleIds, actorId);
      }

      const emailSent = await this.sendInviteToken(
        existingUser.id,
        tenantId,
        email,
        dto.firstName,
        actorId,
      );

      await this.audit.write({
        tenantId,
        actorId,
        module: 'users',
        action: 'INVITE',
        entityId: existingUser.id,
        newValue: { email, type: 'restored-user', emailSent },
      });

      const user = await this.findOne(existingUser.id, tenantId);
      return { ...user, emailSent };
    }

    if (existingUser) {
      const alreadyMember = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId: existingUser.id, tenantId } },
      });
      if (alreadyMember) {
        throw new ConflictException('This email is already a member of this workspace');
      }

      // Existing active global user — enroll immediately (they already have a password)
      await this.prisma.tenantMember.create({
        data: {
          userId: existingUser.id,
          tenantId,
          status: MemberStatus.ACTIVE,
          invitedById: actorId,
          joinedAt: new Date(),
        },
      });

      if (dto.roleIds?.length) {
        await this.syncRoles(existingUser.id, tenantId, dto.roleIds, actorId);
      }

      const emailSent = await this.sendJoinWorkspaceNotification(
        existingUser.id,
        tenantId,
        existingUser.email,
        existingUser.firstName,
        actorId,
      );

      await this.audit.write({
        tenantId,
        actorId,
        module: 'users',
        action: 'INVITE',
        entityId: existingUser.id,
        newValue: { email: existingUser.email, type: 'existing-user', emailSent },
      });

      const user = await this.findOne(existingUser.id, tenantId);
      return { ...user, emailSent };
    }

    // Brand-new user — create globally and add membership
    const placeholderHash = await argon2.hash(crypto.randomBytes(32).toString('hex'));

    const newUser = await this.prisma.user.create({
      data: {
        email,
        firstName: dto.firstName,
        lastName: dto.lastName,
        passwordHash: placeholderHash,
      },
    });

    await this.prisma.tenantMember.create({
      data: { userId: newUser.id, tenantId, status: MemberStatus.INVITED, invitedById: actorId },
    });

    if (dto.roleIds?.length) {
      await this.syncRoles(newUser.id, tenantId, dto.roleIds, actorId);
    }

    const emailSent = await this.sendInviteToken(
      newUser.id,
      tenantId,
      email,
      dto.firstName,
      actorId,
    );

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'INVITE',
      entityId: newUser.id,
      newValue: {
        email: newUser.email,
        firstName: newUser.firstName,
        lastName: newUser.lastName,
        emailSent,
      },
    });

    const user = await this.findOne(newUser.id, tenantId);
    return { ...user, emailSent };
  }

  // ─── Create ────────────────────────────────────────────────────────────

  async create(dto: CreateUserDto, tenantId: string, actorId: string): Promise<UserListItem> {
    const email = dto.email.toLowerCase();

    const existingUser = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, deletedAt: true },
    });
    if (existingUser && !existingUser.deletedAt) {
      const alreadyMember = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId: existingUser.id, tenantId } },
      });
      if (alreadyMember) {
        throw new ConflictException('This email is already a member of this workspace');
      }
    }

    const passwordHash = await argon2.hash(dto.password);

    let userId: string;

    if (existingUser) {
      userId = existingUser.id;
      // Restore soft-deleted accounts, then enroll
      await this.prisma.user.update({
        where: { id: userId },
        data: {
          deletedAt: null,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      await this.prisma.tenantMember.create({
        data: {
          userId,
          tenantId,
          status: MemberStatus.ACTIVE,
          invitedById: actorId,
          joinedAt: new Date(),
        },
      });
    } else {
      const newUser = await this.prisma.user.create({
        data: {
          email,
          firstName: dto.firstName,
          lastName: dto.lastName,
          passwordHash,
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      });
      userId = newUser.id;
      await this.prisma.tenantMember.create({
        data: {
          userId,
          tenantId,
          status: MemberStatus.ACTIVE,
          invitedById: actorId,
          joinedAt: new Date(),
        },
      });
    }

    if (dto.roleIds?.length) {
      await this.syncRoles(userId, tenantId, dto.roleIds, actorId);
    }

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'CREATE',
      entityId: userId,
      newValue: { email, firstName: dto.firstName, lastName: dto.lastName },
    });

    return this.findOne(userId, tenantId);
  }

  // ─── Platform list (Super Admin) ───────────────────────────────────────

  /**
   * Lists all non-deleted users across the platform (no tenant scope).
   * Super Admin appears here; tenant users appear once each (not once per membership).
   */
  async findAllPlatform(query: ListUsersQueryDto): Promise<PaginatedData<UserListItem>> {
    const { skip, take } = getPaginationParams(query);

    const where: {
      deletedAt: null;
      OR?: Array<
        | { email: { contains: string } }
        | { firstName: { contains: string } }
        | { lastName: { contains: string } }
      >;
    } = { deletedAt: null };

    if (query.search?.trim()) {
      const s = query.search.trim();
      where.OR = [
        { email: { contains: s } },
        { firstName: { contains: s } },
        { lastName: { contains: s } },
      ];
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        select: {
          ...USER_FIELDS_FROM_USER,
          memberships: {
            orderBy: [{ createdAt: 'desc' }],
            select: {
              tenantId: true,
              status: true,
              invitedById: true,
              createdAt: true,
              updatedAt: true,
              tenant: { select: { name: true, slug: true, deletedAt: true } },
            },
          },
        },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }) as Promise<PlatformUserRecord[]>,
      this.prisma.user.count({ where }),
    ]);

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: { in: users.map((user) => user.id) } },
      select: {
        userId: true,
        tenantId: true,
        role: { select: { id: true, name: true, slug: true, isSystem: true } },
      },
    });

    const rolesByUserTenant = new Map<
      string,
      Array<{ id: string; name: string; slug: string; isSystem: boolean }>
    >();
    for (const assignment of userRoles) {
      const key = `${assignment.userId}:${assignment.tenantId}`;
      const existing = rolesByUserTenant.get(key) ?? [];
      existing.push(assignment.role);
      rolesByUserTenant.set(key, existing);
    }

    const items: UserListItem[] = users.map((u) => {
      const activeMemberships = u.memberships.filter(
        (membership) => membership.tenant.deletedAt === null,
      );
      const m = activeMemberships[0];
      const memberships = activeMemberships.map((membership) => ({
        tenantId: membership.tenantId,
        tenantName: membership.tenant.name,
        tenantSlug: membership.tenant.slug,
        status: membership.status as MemberStatus,
        roles: rolesByUserTenant.get(`${u.id}:${membership.tenantId}`) ?? [],
      }));

      return {
        id: u.id,
        email: u.email,
        firstName: u.firstName,
        lastName: u.lastName,
        emailVerified: u.emailVerified,
        avatarUrl: u.avatarUrl,
        timezone: u.timezone,
        isSuperAdmin: u.isSuperAdmin,
        tenantId: m?.tenantId ?? '',
        status: (m?.status as MemberStatus) ?? MemberStatus.ACTIVE,
        invitedById: m?.invitedById ?? null,
        createdAt: m?.createdAt ?? u.createdAt,
        updatedAt: m?.updatedAt ?? u.updatedAt,
        memberships,
      };
    });

    return { items, meta: buildPaginationMeta(total, query.page, query.limit) };
  }

  // ─── List ──────────────────────────────────────────────────────────────

  async findAll(tenantId: string, query: ListUsersQueryDto): Promise<PaginatedData<UserListItem>> {
    const { skip, take } = getPaginationParams(query);

    const userFilter: {
      deletedAt: null;
      OR?: Array<
        | { email: { contains: string } }
        | { firstName: { contains: string } }
        | { lastName: { contains: string } }
      >;
    } = { deletedAt: null };

    if (query.search?.trim()) {
      const s = query.search.trim();
      userFilter.OR = [
        { email: { contains: s } },
        { firstName: { contains: s } },
        { lastName: { contains: s } },
      ];
    }

    const where = {
      tenantId,
      user: userFilter,
      ...(query.status ? { status: query.status as MemberStatus } : {}),
    };

    const [members, total] = await Promise.all([
      this.prisma.tenantMember.findMany({
        where,
        include: { user: { select: USER_FIELDS_FROM_USER } },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenantMember.count({ where }),
    ]);

    const userIds = members.map((m) => m.userId);
    const roleRows =
      userIds.length === 0
        ? []
        : await this.prisma.userRole.findMany({
            where: { tenantId, userId: { in: userIds } },
            select: {
              userId: true,
              role: { select: { id: true, name: true, slug: true, isSystem: true } },
            },
          });

    const rolesByUser = new Map<string, UserListRole[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.userId) ?? [];
      list.push(row.role);
      rolesByUser.set(row.userId, list);
    }

    const items: UserListItem[] = members.map((m) => ({
      ...m.user,
      tenantId: m.tenantId,
      status: m.status as MemberStatus,
      invitedById: m.invitedById,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      roles: rolesByUser.get(m.userId) ?? [],
    }));

    return { items, meta: buildPaginationMeta(total, query.page, query.limit) };
  }

  /**
   * Staff directory filtered by role slug (e.g. rider).
   * Used by /staff?role=RIDER for riders page and delivery dropdowns.
   */
  async listStaff(
    tenantId: string,
    query: ListStaffQueryDto,
  ): Promise<PaginatedData<UserListItem>> {
    const { skip, take } = getPaginationParams(query);
    const roleSlug = query.role?.trim().toLowerCase();

    const userFilter: {
      deletedAt: null;
      OR?: Array<
        | { email: { contains: string } }
        | { firstName: { contains: string } }
        | { lastName: { contains: string } }
      >;
      roles?: { some: { tenantId: string; role: { slug: string } } };
    } = { deletedAt: null };

    if (query.search?.trim()) {
      const s = query.search.trim();
      userFilter.OR = [
        { email: { contains: s } },
        { firstName: { contains: s } },
        { lastName: { contains: s } },
      ];
    }

    if (roleSlug) {
      userFilter.roles = {
        some: {
          tenantId,
          role: { slug: roleSlug },
        },
      };
    }

    const where = {
      tenantId,
      user: userFilter,
      ...(query.status
        ? { status: query.status as MemberStatus }
        : { status: MemberStatus.ACTIVE }),
    };

    const [members, total] = await Promise.all([
      this.prisma.tenantMember.findMany({
        where,
        include: { user: { select: USER_FIELDS_FROM_USER } },
        skip,
        take,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.tenantMember.count({ where }),
    ]);

    const userIds = members.map((m) => m.userId);
    const roleRows =
      userIds.length === 0
        ? []
        : await this.prisma.userRole.findMany({
            where: {
              tenantId,
              userId: { in: userIds },
              ...(roleSlug ? { role: { slug: roleSlug } } : {}),
            },
            select: {
              userId: true,
              role: { select: { id: true, name: true, slug: true, isSystem: true } },
            },
          });

    const rolesByUser = new Map<string, UserListRole[]>();
    for (const row of roleRows) {
      const list = rolesByUser.get(row.userId) ?? [];
      list.push(row.role);
      rolesByUser.set(row.userId, list);
    }

    const items: UserListItem[] = members.map((m) => ({
      ...m.user,
      tenantId: m.tenantId,
      status: m.status as MemberStatus,
      invitedById: m.invitedById,
      createdAt: m.createdAt,
      updatedAt: m.updatedAt,
      roles: rolesByUser.get(m.userId) ?? [],
    }));

    return { items, meta: buildPaginationMeta(total, query.page, query.limit) };
  }

  // ─── Detail ────────────────────────────────────────────────────────────

  async findOne(id: string, tenantId: string): Promise<UserDetail> {
    const member = await this.prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: id, tenantId } },
      include: { user: { select: USER_FIELDS_FROM_USER } },
    });

    if (!member) throw new NotFoundException('User not found in this workspace');

    const userRoles = await this.prisma.userRole.findMany({
      where: { userId: id, tenantId },
      select: {
        id: true,
        createdAt: true,
        role: { select: { id: true, name: true, slug: true, isSystem: true } },
      },
    });

    const roles: UserDetailRole[] = userRoles.map((ur) => ({
      assignmentId: ur.id,
      assignedAt: ur.createdAt,
      ...ur.role,
    }));

    return {
      ...member.user,
      tenantId: member.tenantId,
      status: member.status as MemberStatus,
      invitedById: member.invitedById,
      createdAt: member.createdAt,
      updatedAt: member.updatedAt,
      emailVerifiedAt: member.user.emailVerifiedAt,
      roles,
    };
  }

  // ─── Update ────────────────────────────────────────────────────────────

  async update(
    id: string,
    dto: UpdateUserDto,
    tenantId: string,
    actorId: string,
  ): Promise<UserListItem> {
    const existing = await this.findTenantMemberOrThrow(id, tenantId);

    const data: {
      firstName?: string;
      lastName?: string;
      avatarUrl?: string | null;
      timezone?: string;
      passwordHash?: string;
    } = {};

    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.password) data.passwordHash = await argon2.hash(dto.password);

    await this.prisma.user.update({ where: { id }, data });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'UPDATE',
      entityId: id,
      oldValue: {
        firstName: existing.user.firstName,
        lastName: existing.user.lastName,
        avatarUrl: existing.user.avatarUrl,
        timezone: existing.user.timezone,
      },
      newValue: {
        firstName: dto.firstName,
        lastName: dto.lastName,
        avatarUrl: dto.avatarUrl,
        timezone: dto.timezone,
        passwordChanged: Boolean(dto.password),
      },
    });

    return this.findOne(id, tenantId);
  }

  // ─── Deactivate / Reactivate ───────────────────────────────────────────

  async deactivate(id: string, tenantId: string, actorId: string): Promise<UserListItem> {
    const member = await this.findTenantMemberOrThrow(id, tenantId);

    if (member.userId === actorId) {
      throw new BadRequestException('You cannot deactivate your own account');
    }
    if (member.status === MemberStatus.INACTIVE) {
      throw new BadRequestException('User is already inactive');
    }

    await this.prisma.tenantMember.update({
      where: { userId_tenantId: { userId: id, tenantId } },
      data: { status: MemberStatus.INACTIVE },
    });

    // Revoke sessions for this user in this tenant only
    await this.prisma.userSession.deleteMany({ where: { userId: id, tenantId } });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'DEACTIVATE',
      entityId: id,
      oldValue: { status: member.status },
      newValue: { status: MemberStatus.INACTIVE },
    });

    return this.findOne(id, tenantId);
  }

  async reactivate(id: string, tenantId: string, actorId: string): Promise<UserListItem> {
    const member = await this.findTenantMemberOrThrow(id, tenantId);

    if (member.status === MemberStatus.ACTIVE) {
      throw new BadRequestException('User is already active');
    }
    if (member.status === MemberStatus.INVITED) {
      throw new BadRequestException('Invited users must accept their invite first');
    }

    await this.prisma.tenantMember.update({
      where: { userId_tenantId: { userId: id, tenantId } },
      data: { status: MemberStatus.ACTIVE },
    });

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'REACTIVATE',
      entityId: id,
      oldValue: { status: member.status },
      newValue: { status: MemberStatus.ACTIVE },
    });

    return this.findOne(id, tenantId);
  }

  // ─── Platform delete (Super Admin) ─────────────────────────────────────

  /**
   * Soft-deletes a global user account and strips all workspace memberships.
   * Used when Super Admin cleans up orphan accounts after tenant deletion, etc.
   */
  async deletePlatformUser(id: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new BadRequestException('You cannot delete your own account');
    }

    const user = await this.prisma.user.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.isSuperAdmin) {
      throw new ForbiddenException('Cannot delete a Super Admin account');
    }

    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: id } }),
      this.prisma.userSession.deleteMany({ where: { userId: id } }),
      this.prisma.tenantMember.deleteMany({ where: { userId: id } }),
      this.prisma.tenant.updateMany({
        where: { ownerUserId: id },
        data: { ownerUserId: null },
      }),
      this.prisma.user.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
    ]);

    await this.audit.write({
      tenantId: null,
      actorId,
      module: 'users',
      action: 'PLATFORM_DELETE',
      entityId: id,
      oldValue: {
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
      },
    });
  }

  // ─── Remove from Tenant ─────────────────────────────────────────────────

  async removeMember(id: string, tenantId: string, actorId: string): Promise<void> {
    const member = await this.findTenantMemberOrThrow(id, tenantId);

    if (member.userId === actorId) {
      throw new BadRequestException('You cannot remove yourself from the workspace');
    }

    // Check if user is the tenant owner
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { ownerUserId: true },
    });
    if (tenant?.ownerUserId === id) {
      throw new ForbiddenException('Cannot remove the tenant owner');
    }

    // Remove roles, sessions, and membership for this tenant
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId: id, tenantId } }),
      this.prisma.userSession.deleteMany({ where: { userId: id, tenantId } }),
      this.prisma.tenantMember.delete({
        where: { userId_tenantId: { userId: id, tenantId } },
      }),
    ]);

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'REMOVE_MEMBER',
      entityId: id,
      oldValue: {
        email: member.user.email,
        firstName: member.user.firstName,
        lastName: member.user.lastName,
        status: member.status,
      },
    });
  }

  // ─── Roles ─────────────────────────────────────────────────────────────

  async assignRoles(userId: string, dto: AssignUserRolesDto, tenantId: string, actorId: string) {
    await this.findTenantMemberOrThrow(userId, tenantId);
    await this.assertRolesAssignable(dto.roleIds, tenantId);

    // Replace: remove roles not in the new set, then upsert selected ones
    await this.prisma.userRole.deleteMany({
      where: {
        userId,
        tenantId,
        ...(dto.roleIds.length > 0 ? { roleId: { notIn: dto.roleIds } } : {}),
      },
    });

    await Promise.all(
      dto.roleIds.map((roleId) =>
        this.prisma.userRole.upsert({
          where: { userId_roleId_tenantId: { userId, roleId, tenantId } },
          update: {},
          create: { userId, roleId, tenantId, assignedById: actorId },
        }),
      ),
    );

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'ASSIGN_ROLES',
      entityId: userId,
      newValue: { roleIds: dto.roleIds },
    });

    return this.findOne(userId, tenantId);
  }

  async removeRole(
    userId: string,
    roleId: string,
    tenantId: string,
    actorId: string,
  ): Promise<void> {
    await this.findTenantMemberOrThrow(userId, tenantId);

    const deleted = await this.prisma.userRole.deleteMany({
      where: { userId, roleId, tenantId },
    });

    if (deleted.count === 0) {
      throw new NotFoundException('Role assignment not found');
    }

    await this.audit.write({
      tenantId,
      actorId,
      module: 'users',
      action: 'REMOVE_ROLE',
      entityId: userId,
      oldValue: { roleId },
    });
  }

  // ─── Private Helpers ───────────────────────────────────────────────────

  private async findTenantMemberOrThrow(userId: string, tenantId: string) {
    const member = await this.prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId, tenantId } },
      include: { user: { select: USER_FIELDS_FROM_USER } },
    });
    if (!member) throw new NotFoundException('User not found in this workspace');
    return member;
  }

  private async assertRolesAssignable(roleIds: string[], tenantId: string): Promise<void> {
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, OR: [{ tenantId: null }, { tenantId }] },
      select: { id: true, slug: true },
    });

    if (roles.length !== roleIds.length) {
      throw new BadRequestException('One or more role IDs are invalid for this tenant');
    }

    if (roles.some((r) => r.slug === 'super_admin')) {
      throw new ForbiddenException('Cannot assign super_admin role');
    }
  }

  private async syncRoles(
    userId: string,
    tenantId: string,
    roleIds: string[],
    actorId: string,
  ): Promise<void> {
    await this.assertRolesAssignable(roleIds, tenantId);
    await Promise.all(
      roleIds.map((roleId) =>
        this.prisma.userRole.upsert({
          where: { userId_roleId_tenantId: { userId, roleId, tenantId } },
          update: {},
          create: { userId, roleId, tenantId, assignedById: actorId },
        }),
      ),
    );
  }

  private async sendInviteToken(
    userId: string,
    tenantId: string,
    email: string,
    firstName: string,
    actorId: string,
  ): Promise<boolean> {
    const [actor, tenant] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true },
      }),
    ]);

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.prisma.userSession.create({
      data: {
        userId,
        tenantId,
        refreshTokenHash: `invite:${tokenHash}`,
        expiresAt,
      },
    });

    const inviterName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'A team admin';

    const sent = await this.mail.sendInviteEmail(email, {
      firstName,
      inviterName,
      tenantName: tenant?.name ?? 'your workspace',
      inviteLink: `${this.frontendUrl}/reset-password?token=${rawToken}&invite=1`,
    });

    if (!sent) {
      this.logger.warn(`Invite email could not be sent to ${email} for tenant ${tenantId}`);
    }
    return sent;
  }

  private async sendJoinWorkspaceNotification(
    userId: string,
    tenantId: string,
    email: string,
    firstName: string,
    actorId: string,
  ): Promise<boolean> {
    const [actor, tenant] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: actorId },
        select: { firstName: true, lastName: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true },
      }),
    ]);

    const inviterName = actor ? `${actor.firstName} ${actor.lastName}`.trim() : 'A team admin';

    const sent = await this.mail.sendJoinWorkspaceEmail(email, {
      firstName,
      inviterName,
      tenantName: tenant?.name ?? 'your workspace',
      loginLink: `${this.frontendUrl}/login`,
    });

    if (!sent) {
      this.logger.warn(`Join workspace email could not be sent to ${email} for tenant ${tenantId}`);
    }
    return sent;
  }
}
