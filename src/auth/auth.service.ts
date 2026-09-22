import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as argon2 from 'argon2';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as speakeasy from 'speakeasy';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { LoginDto } from './dto/login.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { SwitchTenantDto } from './dto/switch-tenant.dto';
import { TotpCodeDto } from './dto/totp-code.dto';
import { TotpVerifyLoginDto } from './dto/totp-verify-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import {
  JwtPayload,
  JwtRefreshPayload,
  JwtSelectionPayload,
  AuthenticatedUser,
} from './types/jwt-payload.type';

@Injectable()
export class AuthService {
  private readonly maxAttempts: number;
  private readonly lockoutMinutes: number;
  private readonly frontendUrl: string;
  private readonly uploadDir: string;
  private readonly apiPublicBase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {
    this.maxAttempts = this.configService.getOrThrow<number>('LOGIN_MAX_ATTEMPTS');
    this.lockoutMinutes = this.configService.getOrThrow<number>('LOGIN_LOCKOUT_MINUTES');
    this.frontendUrl = this.configService.getOrThrow<string>('FRONTEND_URL');
    this.uploadDir = path.resolve(this.configService.get<string>('UPLOAD_DIR', './uploads'));
    this.apiPublicBase = this.configService.getOrThrow<string>('API_PUBLIC_URL').replace(/\/$/, '');
  }

  // ─── Login ──────────────────────────────────────────────────

  async login(dto: LoginDto, ipAddress?: string, userAgent?: string) {
    const { email, password } = dto;

    await this.checkLoginLockout(email);

    const user = await this.prisma.user.findUnique({
      where: { email, deletedAt: null },
      select: {
        id: true,
        email: true,
        passwordHash: true,
        emailVerified: true,
        isSuperAdmin: true,
        firstName: true,
        lastName: true,
        totpEnabled: true,
      },
    });

    const isValid = user ? await argon2.verify(user.passwordHash, password) : false;

    await this.recordLoginAttempt(email, user?.id ?? null, ipAddress, isValid);

    if (!user || !isValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    if (!user.emailVerified) {
      throw new ForbiddenException('Please verify your email before logging in');
    }

    // ── TOTP challenge: if enabled, pause and require code ───
    if (user.totpEnabled) {
      const totpToken = this.signTotpChallengeToken(user.id, user.email, user.isSuperAdmin);
      return { totpRequired: true as const, totpToken };
    }

    // ── Super admin: direct login, no tenant required ────────
    if (user.isSuperAdmin) {
      const tokens = await this.generateTokens(
        { id: user.id, email: user.email, isSuperAdmin: true },
        null,
        ipAddress,
        userAgent,
      );
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          tenantId: null as string | null,
          isSuperAdmin: true,
        },
      };
    }

    // ── Regular user: resolve active memberships on ACTIVE tenants only ──
    const memberships = await this.prisma.tenantMember.findMany({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        tenant: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        tenantId: true,
        tenant: { select: { id: true, name: true, slug: true, logo: true } },
      },
    });

    if (memberships.length === 0) {
      throw new UnauthorizedException(await this.noActiveWorkspaceMessage(user.id));
    }

    // ── Single tenant: issue full tokens immediately ─────────
    if (memberships.length === 1) {
      const tenantId = memberships[0].tenantId;
      const tokens = await this.generateTokens(
        { id: user.id, email: user.email, isSuperAdmin: false },
        tenantId,
        ipAddress,
        userAgent,
      );
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          tenantId,
          isSuperAdmin: false,
        },
      };
    }

    // ── Multiple tenants: return selection token ─────────────
    const selectionToken = this.jwtService.sign(
      { sub: user.id, type: 'selection' } satisfies JwtSelectionPayload,
      {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: '3m',
      },
    );

    return {
      requiresTenantSelection: true as const,
      selectionToken,
      tenants: memberships.map((m) => ({
        id: m.tenant.id,
        name: m.tenant.name,
        slug: m.tenant.slug,
        logoUrl: m.tenant.logo ?? null,
      })),
    };
  }

  // ─── Select Tenant ──────────────────────────────────────────

  async selectTenant(dto: SelectTenantDto, ipAddress?: string, userAgent?: string) {
    let payload: JwtSelectionPayload;
    try {
      payload = this.jwtService.verify<JwtSelectionPayload>(dto.selectionToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Selection token is invalid or expired');
    }

    if (payload.type !== 'selection') {
      throw new UnauthorizedException('Invalid token type');
    }

    const member = await this.prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: payload.sub, tenantId: dto.tenantId } },
      select: {
        status: true,
        userId: true,
        tenant: { select: { status: true, deletedAt: true } },
      },
    });

    if (!member || member.status !== 'ACTIVE') {
      throw new UnauthorizedException('Not an active member of this workspace');
    }
    if (member.tenant.deletedAt || member.tenant.status !== 'ACTIVE') {
      throw new UnauthorizedException('This workspace is not available');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, email: true, firstName: true, lastName: true, isSuperAdmin: true },
    });

    if (!user) throw new UnauthorizedException('User not found');

    const tokens = await this.generateTokens(
      { id: user.id, email: user.email, isSuperAdmin: user.isSuperAdmin },
      dto.tenantId,
      ipAddress,
      userAgent,
    );

    return {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        tenantId: dto.tenantId,
        isSuperAdmin: user.isSuperAdmin,
      },
    };
  }

  // ─── Switch Tenant ──────────────────────────────────────────

  async switchTenant(
    currentUser: AuthenticatedUser,
    dto: SwitchTenantDto,
    ipAddress?: string,
    userAgent?: string,
  ) {
    if (dto.tenantId === currentUser.tenantId) {
      throw new BadRequestException('Already in this workspace');
    }

    const member = await this.prisma.tenantMember.findUnique({
      where: { userId_tenantId: { userId: currentUser.id, tenantId: dto.tenantId } },
      select: {
        status: true,
        tenant: { select: { status: true, deletedAt: true } },
      },
    });

    if (!member || member.status !== 'ACTIVE') {
      throw new ForbiddenException('Not an active member of this workspace');
    }
    if (member.tenant.deletedAt || member.tenant.status !== 'ACTIVE') {
      throw new ForbiddenException('This workspace is not available');
    }

    const tokens = await this.generateTokens(
      { id: currentUser.id, email: currentUser.email, isSuperAdmin: currentUser.isSuperAdmin },
      dto.tenantId,
      ipAddress,
      userAgent,
    );

    return { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
  }

  // ─── Logout ─────────────────────────────────────────────────

  async logout(sessionId: string | undefined, userId?: string): Promise<void> {
    if (sessionId) {
      await this.prisma.userSession.deleteMany({ where: { id: sessionId } });
    } else if (userId) {
      await this.prisma.userSession.deleteMany({ where: { userId } });
    }
  }

  // ─── Refresh Token ──────────────────────────────────────────

  async refreshTokens(user: AuthenticatedUser & { rawRefreshToken: string }) {
    const session = await this.prisma.userSession.findFirst({
      where: { id: user.sessionId, userId: user.id },
    });

    if (!session || session.expiresAt < new Date()) {
      throw new UnauthorizedException('Session expired. Please log in again');
    }

    // Block refresh into a suspended / cancelled / deleted workspace
    if (session.tenantId) {
      const tenant = await this.prisma.tenant.findFirst({
        where: { id: session.tenantId },
        select: { status: true, deletedAt: true },
      });
      if (!tenant || tenant.deletedAt || tenant.status !== 'ACTIVE') {
        await this.prisma.userSession.deleteMany({ where: { id: session.id } });
        throw new UnauthorizedException('This workspace is not available. Please log in again');
      }
    }

    const isValid = await argon2.verify(session.refreshTokenHash, user.rawRefreshToken);
    if (!isValid) {
      // Drop only this session — wiping every session for the user breaks
      // concurrent tabs and races a legitimate rotation against a stale cookie.
      await this.prisma.userSession.deleteMany({ where: { id: session.id } });
      throw new UnauthorizedException('Invalid refresh token');
    }

    const dbUser = await this.prisma.user.findUnique({
      where: { id: user.id, deletedAt: null },
      select: { id: true, email: true, isSuperAdmin: true },
    });

    if (!dbUser) {
      throw new UnauthorizedException('User is not authorized');
    }

    await this.prisma.userSession.delete({ where: { id: session.id } });
    return this.generateTokens(
      { id: dbUser.id, email: dbUser.email, isSuperAdmin: dbUser.isSuperAdmin },
      session.tenantId,
    );
  }

  // ─── Current User ───────────────────────────────────────────

  async getCurrentUser(userId: string, tenantId: string | null) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true,
        emailVerified: true,
        avatarUrl: true,
        timezone: true,
        createdAt: true,
      },
    });

    if (!user) throw new NotFoundException('User not found');

    const [userRoles, memberships] = await Promise.all([
      tenantId
        ? this.prisma.userRole.findMany({
            where: { userId, tenantId },
            select: {
              role: {
                select: {
                  id: true,
                  name: true,
                  slug: true,
                  permissions: {
                    select: {
                      permission: { select: { module: true, action: true } },
                    },
                  },
                },
              },
            },
          })
        : Promise.resolve([]),
      this.prisma.tenantMember.findMany({
        where: {
          userId,
          status: 'ACTIVE',
          tenant: { deletedAt: null, status: 'ACTIVE' },
        },
        select: {
          tenantId: true,
          tenant: { select: { id: true, name: true, slug: true, logo: true } },
        },
      }),
    ]);

    const permissions = user.isSuperAdmin
      ? []
      : userRoles.flatMap((ur) =>
          ur.role.permissions.map((rp) => `${rp.permission.module}:${rp.permission.action}`),
        );

    const roles = user.isSuperAdmin
      ? [{ id: 'super_admin', name: 'Super Admin', slug: 'super_admin' }]
      : userRoles.map((ur) => ({
          id: ur.role.id,
          name: ur.role.name,
          slug: ur.role.slug,
        }));

    const tenants = memberships.map((m) => ({
      id: m.tenant.id,
      name: m.tenant.name,
      slug: m.tenant.slug,
      logoUrl: m.tenant.logo ?? null,
    }));

    const activeTenant = tenants.find((t) => t.id === tenantId) ?? null;

    // For non-SA users include the TenantMember status as the user's status field
    let status: string = 'ACTIVE';
    if (!user.isSuperAdmin && tenantId) {
      const member = memberships.find((m) => m.tenantId === tenantId);
      status = member ? 'ACTIVE' : 'INACTIVE';
    }

    return { ...user, tenantId, status, permissions, roles, tenants, activeTenant };
  }

  // ─── Forgot Password ────────────────────────────────────────

  async forgotPassword(dto: ForgotPasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email, deletedAt: null },
      select: { id: true, email: true, firstName: true },
    });

    // Always respond generically — never reveal if email exists
    if (!user) return;

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        tenantId: null, // reset tokens are tenant-independent
        refreshTokenHash: `reset:${tokenHash}`,
        expiresAt,
      },
    });

    await this.mailService.sendPasswordResetEmail(user.email, {
      firstName: user.firstName,
      resetLink: `${this.frontendUrl}/reset-password?token=${rawToken}`,
    });
  }

  // ─── Reset Password ─────────────────────────────────────────

  async resetPassword(dto: ResetPasswordDto): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');

    const session = await this.prisma.userSession.findFirst({
      where: {
        OR: [
          { refreshTokenHash: `reset:${tokenHash}` },
          { refreshTokenHash: `invite:${tokenHash}` },
        ],
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) throw new BadRequestException('Reset token is invalid or expired');

    const passwordHash = await argon2.hash(dto.password);
    const isInvite = session.refreshTokenHash.startsWith('invite:');

    const nameParts = dto.name?.trim().split(/\s+/).filter(Boolean) ?? [];
    const firstName = nameParts[0];
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined;

    await this.prisma.user.update({
      where: { id: session.userId },
      data: {
        passwordHash,
        ...(isInvite ? { emailVerified: true, emailVerifiedAt: new Date() } : {}),
        ...(isInvite && firstName ? { firstName } : {}),
        ...(isInvite && lastName ? { lastName } : {}),
      },
    });

    // Activate the TenantMember when the user accepts an invite
    if (isInvite && session.tenantId) {
      await this.prisma.tenantMember.updateMany({
        where: { userId: session.userId, tenantId: session.tenantId, status: 'INVITED' },
        data: { status: 'ACTIVE', joinedAt: new Date() },
      });
    }

    // Revoke all sessions so the user must log in fresh
    await this.prisma.userSession.deleteMany({ where: { userId: session.userId } });
  }

  // ─── Email Verification ─────────────────────────────────────

  async sendVerificationEmailByAddress(email: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { email: email.toLowerCase().trim(), deletedAt: null },
      select: { id: true, emailVerified: true },
    });
    // Always silent — never reveal whether the email exists
    if (!user || user.emailVerified) return;

    const membership = await this.prisma.tenantMember.findFirst({
      where: { userId: user.id, status: { in: ['ACTIVE', 'INVITED'] } },
      select: { tenantId: true },
    });

    await this.sendVerificationEmail(user.id, membership?.tenantId ?? null);
  }

  async sendVerificationEmail(userId: string, tenantId: string | null): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true, email: true, firstName: true, emailVerified: true },
    });

    if (!user) throw new NotFoundException('User not found');
    if (user.emailVerified) throw new BadRequestException('Email is already verified');

    const rawToken = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.prisma.userSession.create({
      data: {
        userId: user.id,
        tenantId,
        refreshTokenHash: `verify:${tokenHash}`,
        expiresAt,
      },
    });

    await this.mailService.sendVerificationEmail(user.email, {
      firstName: user.firstName,
      verifyLink: `${this.frontendUrl}/verify-email?token=${rawToken}`,
    });
  }

  async verifyEmail(dto: VerifyEmailDto): Promise<void> {
    const tokenHash = crypto.createHash('sha256').update(dto.token).digest('hex');

    const session = await this.prisma.userSession.findFirst({
      where: {
        refreshTokenHash: `verify:${tokenHash}`,
        expiresAt: { gt: new Date() },
      },
    });

    if (!session) throw new BadRequestException('Verification token is invalid or expired');

    await this.prisma.user.update({
      where: { id: session.userId },
      data: { emailVerified: true, emailVerifiedAt: new Date() },
    });

    // Activate TenantMember when email verification is used for onboarding
    if (session.tenantId) {
      await this.prisma.tenantMember.updateMany({
        where: { userId: session.userId, tenantId: session.tenantId, status: 'INVITED' },
        data: { status: 'ACTIVE', joinedAt: new Date() },
      });
    }

    await this.prisma.userSession.delete({ where: { id: session.id } });
  }

  // ─── Change Password ────────────────────────────────────────

  async changePassword(userId: string, dto: ChangePasswordDto): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId, deletedAt: null },
      select: { id: true, passwordHash: true },
    });

    if (!user) throw new NotFoundException('User not found');

    const isValid = await argon2.verify(user.passwordHash, dto.currentPassword);
    if (!isValid) throw new BadRequestException('Current password is incorrect');

    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('New password must be different from current password');
    }

    const passwordHash = await argon2.hash(dto.newPassword);

    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.prisma.userSession.deleteMany({ where: { userId } }),
    ]);
  }

  // ─── Private Helpers ────────────────────────────────────────

  private async generateTokens(
    user: { id: string; email: string; isSuperAdmin: boolean },
    tenantId: string | null,
    ipAddress?: string,
    userAgent?: string,
  ) {
    const refreshExpiresIn = this.configService.getOrThrow<string>('JWT_REFRESH_EXPIRES_IN');
    const expiresAt = new Date(Date.now() + this.parseDuration(refreshExpiresIn));

    // Create session first so we can embed sessionId in the refresh JWT.
    // Hash is updated after signing — we must hash the same string the client stores.
    const session = await this.prisma.userSession.create({
      data: {
        userId: user.id,
        tenantId,
        refreshTokenHash: 'pending',
        ipAddress: ipAddress ?? null,
        userAgent: userAgent ?? null,
        expiresAt,
      },
    });

    const payload: JwtPayload = {
      sub: user.id,
      email: user.email,
      tenantId,
      isSuperAdmin: user.isSuperAdmin,
    };

    const refreshPayload: JwtRefreshPayload = {
      ...payload,
      sessionId: session.id,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(refreshPayload, {
      secret: this.configService.getOrThrow<string>('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiresIn as `${number}${'s' | 'm' | 'h' | 'd'}`,
    });

    // Cookie / body carries this JWT; DB must hash THIS value (not a separate random secret).
    await this.prisma.userSession.update({
      where: { id: session.id },
      data: { refreshTokenHash: await argon2.hash(refreshToken) },
    });

    return { accessToken, refreshToken };
  }

  private async checkLoginLockout(email: string): Promise<void> {
    const since = new Date(Date.now() - this.lockoutMinutes * 60 * 1000);

    const failedAttempts = await this.prisma.loginAttempt.count({
      where: { email, success: false, createdAt: { gte: since } },
    });

    if (failedAttempts >= this.maxAttempts) {
      throw new ForbiddenException(
        `Account temporarily locked due to too many failed attempts. Try again in ${this.lockoutMinutes} minutes.`,
      );
    }
  }

  private async recordLoginAttempt(
    email: string,
    userId: string | null,
    ipAddress: string | undefined,
    success: boolean,
  ): Promise<void> {
    await this.prisma.loginAttempt.create({
      data: { email, userId, ipAddress: ipAddress ?? null, success },
    });
  }

  // ─── Self-profile update (SA + tenant users) ─────────────────

  /**
   * Update the calling user's own profile fields.
   * Works for super admins (no tenant context) and regular tenant users alike.
   */
  async updateMyProfile(userId: string, dto: UpdateProfileDto) {
    const data: {
      firstName?: string;
      lastName?: string;
      timezone?: string;
      avatarUrl?: string | null;
    } = {};
    if (dto.firstName !== undefined) data.firstName = dto.firstName;
    if (dto.lastName !== undefined) data.lastName = dto.lastName;
    if (dto.timezone !== undefined) data.timezone = dto.timezone;
    if (dto.avatarUrl !== undefined) data.avatarUrl = dto.avatarUrl;

    return this.prisma.user.update({
      where: { id: userId, deletedAt: null },
      data,
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        timezone: true,
        avatarUrl: true,
        isSuperAdmin: true,
      },
    });
  }

  /**
   * Upload avatar for any authenticated user (including Super Admin without tenant).
   * Stores under uploads/platform/users/{userId}/ and serves via public download path.
   */
  async uploadMyAvatar(userId: string, file: Express.Multer.File) {
    const ext = path.extname(file.originalname || '').toLowerCase() || '.png';
    const safeExt = ['.jpg', '.jpeg', '.png', '.webp'].includes(ext) ? ext : '.png';
    const storedName = `${crypto.randomBytes(16).toString('hex')}${safeExt}`;
    const relativeKey = path.join('platform', 'users', userId, storedName);
    const fullPath = path.join(this.uploadDir, relativeKey);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, file.buffer);

    const urlPath = `uploads/${relativeKey.replace(/\\/g, '/')}`;
    const avatarUrl = `${this.apiPublicBase}/api/v1/files/download?path=${encodeURIComponent(urlPath)}`;

    return this.updateMyProfile(userId, { avatarUrl });
  }

  async clearMyAvatar(userId: string) {
    return this.updateMyProfile(userId, { avatarUrl: null });
  }

  // ─── TOTP ────────────────────────────────────────────────────

  /**
   * Step 1 of TOTP setup: generates a new secret and stores it (not yet enabled).
   * Returns the base32 secret and OTP Auth URI so the frontend can render a QR code.
   */
  async setupTotp(userId: string): Promise<{ secret: string; otpAuthUri: string }> {
    const appName = this.configService.get<string>('APP_NAME') ?? 'SaaSApp';
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    const generated = speakeasy.generateSecret({ length: 20, name: `${appName}:${user.email}` });
    const base32Secret = generated.base32;
    const otpAuthUri = speakeasy.otpauthURL({
      secret: base32Secret,
      label: user.email,
      issuer: appName,
      encoding: 'base32',
    });

    // Persist secret but keep totpEnabled=false until user verifies
    await this.prisma.user.update({
      where: { id: userId },
      data: { totpSecret: base32Secret },
    });

    return { secret: base32Secret, otpAuthUri };
  }

  /**
   * Step 2 of TOTP setup: verifies the first code and activates TOTP.
   */
  async enableTotp(userId: string, dto: TotpCodeDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabled: true },
    });

    if (!user.totpSecret) {
      throw new BadRequestException('Run TOTP setup first (POST /auth/totp/setup)');
    }
    if (user.totpEnabled) {
      throw new BadRequestException('TOTP is already enabled');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: dto.code,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: true },
    });
  }

  /**
   * Disables TOTP after verifying the current code.
   */
  async disableTotp(userId: string, dto: TotpCodeDto): Promise<void> {
    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { totpSecret: true, totpEnabled: true },
    });

    if (!user.totpEnabled || !user.totpSecret) {
      throw new BadRequestException('TOTP is not enabled on this account');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: dto.code,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { totpEnabled: false, totpSecret: null },
    });
  }

  /**
   * Step 2 of TOTP-protected login.
   * Validates the short-lived TOTP challenge token + the 6-digit code,
   * then completes the normal login flow (returns access/refresh tokens or
   * a tenant-selection response for multi-tenant users).
   */
  async verifyTotpLogin(dto: TotpVerifyLoginDto, ipAddress?: string, userAgent?: string) {
    // Verify the TOTP challenge token
    let payload: { sub: string; email: string; isSuperAdmin: boolean; purpose: string };
    try {
      payload = this.jwtService.verify(dto.totpToken, {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('TOTP session token is invalid or expired');
    }

    if (payload.purpose !== 'totp') {
      throw new UnauthorizedException('Invalid token type');
    }

    // Load user and verify TOTP code
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub, deletedAt: null },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        isSuperAdmin: true,
        totpSecret: true,
        totpEnabled: true,
      },
    });

    if (!user || !user.totpEnabled || !user.totpSecret) {
      throw new UnauthorizedException('TOTP not configured for this account');
    }

    const isValid = speakeasy.totp.verify({
      secret: user.totpSecret,
      encoding: 'base32',
      token: dto.code,
      window: 1,
    });
    if (!isValid) {
      throw new UnauthorizedException('Invalid TOTP code');
    }

    // TOTP verified — issue full tokens using the same logic as normal login

    if (user.isSuperAdmin) {
      const tokens = await this.generateTokens(
        { id: user.id, email: user.email, isSuperAdmin: true },
        null,
        ipAddress,
        userAgent,
      );
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          tenantId: null as string | null,
          isSuperAdmin: true,
        },
      };
    }

    const memberships = await this.prisma.tenantMember.findMany({
      where: {
        userId: user.id,
        status: 'ACTIVE',
        tenant: { deletedAt: null, status: 'ACTIVE' },
      },
      select: {
        tenantId: true,
        tenant: { select: { id: true, name: true, slug: true, logo: true } },
      },
    });

    if (memberships.length === 0) {
      throw new UnauthorizedException(await this.noActiveWorkspaceMessage(user.id));
    }

    if (memberships.length === 1) {
      const tenantId = memberships[0].tenantId;
      const tokens = await this.generateTokens(
        { id: user.id, email: user.email, isSuperAdmin: false },
        tenantId,
        ipAddress,
        userAgent,
      );
      return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        user: {
          id: user.id,
          email: user.email,
          firstName: user.firstName,
          lastName: user.lastName,
          tenantId,
          isSuperAdmin: false,
        },
      };
    }

    // Multi-tenant: issue selection token (same pattern as normal login)
    const selectionToken = this.jwtService.sign(
      { sub: user.id, type: 'selection' } satisfies JwtSelectionPayload,
      { secret: this.configService.getOrThrow<string>('JWT_SECRET'), expiresIn: '3m' },
    );
    return {
      requiresTenantSelection: true as const,
      selectionToken,
      tenants: memberships.map((m) => ({
        id: m.tenant.id,
        name: m.tenant.name,
        slug: m.tenant.slug,
        logoUrl: m.tenant.logo ?? null,
      })),
    };
  }

  // ─── Private: TOTP challenge token ────────────────────────────────────────

  private signTotpChallengeToken(userId: string, email: string, isSuperAdmin: boolean): string {
    return this.jwtService.sign(
      { sub: userId, email, isSuperAdmin, purpose: 'totp' },
      {
        secret: this.configService.getOrThrow<string>('JWT_SECRET'),
        expiresIn: '5m',
      },
    );
  }

  /** Clearer login error when the only memberships are on non-ACTIVE tenants. */
  private async noActiveWorkspaceMessage(userId: string): Promise<string> {
    const blocked = await this.prisma.tenantMember.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        tenant: { deletedAt: null, status: { in: ['PENDING', 'SUSPENDED', 'CANCELLED'] } },
      },
      select: { tenant: { select: { status: true } } },
    });

    if (blocked?.tenant.status === 'PENDING') {
      return 'Your workspace is pending activation. An administrator must activate it before you can sign in.';
    }
    if (blocked?.tenant.status === 'SUSPENDED') {
      return 'Your workspace has been suspended. Contact your administrator.';
    }
    if (blocked?.tenant.status === 'CANCELLED') {
      return 'Your workspace has been cancelled. Contact your administrator.';
    }
    return 'No active workspace found. Contact your administrator.';
  }

  private parseDuration(duration: string): number {
    const units: Record<string, number> = {
      s: 1000,
      m: 60 * 1000,
      h: 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
    };
    const match = duration.match(/^(\d+)([smhd])$/);
    if (!match) {
      throw new Error(`Invalid JWT_REFRESH_EXPIRES_IN format: ${duration}`);
    }
    return parseInt(match[1], 10) * (units[match[2]] ?? 1000);
  }
}
