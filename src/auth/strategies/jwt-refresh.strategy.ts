import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { JwtRefreshPayload, AuthenticatedUser } from '../types/jwt-payload.type';

/** Name of the httpOnly cookie that carries the refresh token. */
export const REFRESH_COOKIE = 'rt';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
  constructor(configService: ConfigService) {
    super({
      // 1. Try httpOnly cookie; 2. Fall back to body field (Swagger / curl compat)
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: Request) => {
          const cookies = req.cookies as Record<string, string> | undefined;
          return cookies?.[REFRESH_COOKIE] ?? null;
        },
        ExtractJwt.fromBodyField('refreshToken'),
      ]),
      secretOrKey: configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  validate(
    req: Request,
    payload: JwtRefreshPayload,
  ): AuthenticatedUser & { rawRefreshToken: string } {
    // Prefer cookie; body is the Swagger/curl fallback
    const cookies = req.cookies as Record<string, string> | undefined;
    const rawRefreshToken =
      cookies?.[REFRESH_COOKIE] ??
      (req.body as { refreshToken?: string } | undefined)?.refreshToken;

    if (!rawRefreshToken) {
      throw new UnauthorizedException('Refresh token missing');
    }

    return {
      id: payload.sub,
      email: payload.email,
      tenantId: payload.tenantId,
      isSuperAdmin: payload.isSuperAdmin,
      sessionId: payload.sessionId,
      rawRefreshToken,
    };
  }
}
