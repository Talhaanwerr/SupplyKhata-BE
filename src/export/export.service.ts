import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ─── CSV helpers ──────────────────────────────────────────────────────────────

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows: Record<string, unknown>[], fallbackHeaders?: string[]): string {
  if (rows.length === 0) {
    return (fallbackHeaders ?? []).join(',');
  }
  const headers = Object.keys(rows[0]);
  const lines = [
    headers.join(','),
    ...rows.map((r) => headers.map((h) => escapeCell(r[h])).join(',')),
  ];
  return lines.join('\r\n');
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class ExportService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Users ──────────────────────────────────────────────────────────────────

  async exportUsers(tenantId: string): Promise<Record<string, unknown>[]> {
    const members = await this.prisma.tenantMember.findMany({
      where: { tenantId, user: { deletedAt: null } },
      select: {
        status: true,
        joinedAt: true,
        createdAt: true,
        user: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            emailVerified: true,
            timezone: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    return members.map((m) => ({
      id: m.user.id,
      email: m.user.email,
      firstName: m.user.firstName,
      lastName: m.user.lastName,
      status: m.status,
      emailVerified: m.user.emailVerified,
      timezone: m.user.timezone ?? '',
      avatarUrl: m.user.avatarUrl ?? '',
      joinedAt: m.joinedAt?.toISOString() ?? '',
      memberSince: m.createdAt.toISOString(),
    }));
  }

  // ── Audit logs ─────────────────────────────────────────────────────────────

  async exportAuditLogs(tenantId: string): Promise<Record<string, unknown>[]> {
    const logs = await this.prisma.auditLog.findMany({
      where: { tenantId },
      select: {
        id: true,
        module: true,
        action: true,
        entityId: true,
        oldValue: true,
        newValue: true,
        ipAddress: true,
        createdAt: true,
        user: { select: { email: true, firstName: true, lastName: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: 10_000, // guard against enormous exports
    });

    return logs.map((l) => ({
      id: l.id,
      module: l.module,
      action: l.action,
      entityId: l.entityId ?? '',
      actorEmail: l.user?.email ?? 'system',
      actorName: l.user ? `${l.user.firstName} ${l.user.lastName}`.trim() : 'system',
      oldValue: l.oldValue ? JSON.stringify(l.oldValue) : '',
      newValue: l.newValue ? JSON.stringify(l.newValue) : '',
      ipAddress: l.ipAddress ?? '',
      createdAt: l.createdAt.toISOString(),
    }));
  }
}
