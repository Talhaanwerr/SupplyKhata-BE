import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtPayload, AuthenticatedUser } from '../types/jwt-payload.type';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, 'jwt') {
  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
      ignoreExpiration: false,
    });
  }

  async validate(payload: JwtPayload): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
      select: { id: true, email: true, isSuperAdmin: true },
    });

    if (!user) {
      throw new UnauthorizedException('User is not authorized');
    }

    // Validate membership + tenant is still usable for non-SA users with a tenant context
    if (!user.isSuperAdmin && payload.tenantId) {
      const member = await this.prisma.tenantMember.findUnique({
        where: { userId_tenantId: { userId: user.id, tenantId: payload.tenantId } },
        select: {
          status: true,
          tenant: { select: { status: true, deletedAt: true } },
        },
      });
      if (!member || member.status === 'INACTIVE') {
        throw new UnauthorizedException('User is not authorized for this workspace');
      }
      if (member.tenant.deletedAt || member.tenant.status !== 'ACTIVE') {
        throw new UnauthorizedException('This workspace is not available');
      }
    }

    return {
      id: user.id,
      email: user.email,
      tenantId: payload.tenantId,
      isSuperAdmin: user.isSuperAdmin,
    };
  }
}
