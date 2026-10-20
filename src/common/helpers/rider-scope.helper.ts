import { PrismaService } from '../../prisma/prisma.service';

/**
 * True when the user's only role in this tenant is `rider`.
 * Office users with rider+manager (etc.) see everything; pure riders are scoped to self.
 */
export async function isRiderOnlyUser(
  prisma: PrismaService,
  tenantId: string,
  userId: string,
): Promise<boolean> {
  const roles = await prisma.userRole.findMany({
    where: { tenantId, userId },
    select: { role: { select: { slug: true } } },
  });
  const slugs = roles.map((r) => r.role.slug);
  if (slugs.length === 0) return false;
  return slugs.every((s) => s === 'rider');
}
