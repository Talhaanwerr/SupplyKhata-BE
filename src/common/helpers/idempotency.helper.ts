import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

const MAX_KEY_LEN = 128;

/**
 * Run `fn` at most once per (tenantId, scope, key).
 * Missing / empty key → run normally (no idempotency).
 */
export async function runIdempotent<T>(
  prisma: PrismaService,
  args: { tenantId: string; scope: string; key?: string | null },
  fn: () => Promise<T>,
): Promise<T> {
  const key = args.key?.trim() || '';
  if (!key) return fn();
  if (key.length > MAX_KEY_LEN) {
    throw new BadRequestException(`Idempotency-Key must be at most ${MAX_KEY_LEN} characters`);
  }

  const existing = await prisma.idempotencyKey.findUnique({
    where: {
      tenantId_scope_key: {
        tenantId: args.tenantId,
        scope: args.scope,
        key,
      },
    },
  });
  if (existing?.responseJson != null) {
    return existing.responseJson as T;
  }
  if (existing && existing.responseJson == null) {
    throw new ConflictException('A request with this Idempotency-Key is already in progress');
  }

  try {
    await prisma.idempotencyKey.create({
      data: {
        tenantId: args.tenantId,
        scope: args.scope,
        key,
        responseJson: Prisma.JsonNull,
      },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const again = await prisma.idempotencyKey.findUnique({
        where: {
          tenantId_scope_key: {
            tenantId: args.tenantId,
            scope: args.scope,
            key,
          },
        },
      });
      if (again?.responseJson != null) return again.responseJson as T;
      throw new ConflictException('A request with this Idempotency-Key is already in progress');
    }
    throw err;
  }

  try {
    const result = await fn();
    const responseJson = JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
    await prisma.idempotencyKey.update({
      where: {
        tenantId_scope_key: {
          tenantId: args.tenantId,
          scope: args.scope,
          key,
        },
      },
      data: { responseJson },
    });
    return result;
  } catch (err) {
    await prisma.idempotencyKey
      .delete({
        where: {
          tenantId_scope_key: {
            tenantId: args.tenantId,
            scope: args.scope,
            key,
          },
        },
      })
      .catch(() => undefined);
    throw err;
  }
}
