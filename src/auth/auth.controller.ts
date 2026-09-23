import {
  Controller,
  Post,
  Get,
  Patch,
  Delete,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  Version,
  UseInterceptors,
  UploadedFile,
  ParseFilePipe,
  MaxFileSizeValidator,
  FileTypeValidator,
  BadRequestException,
} from '@nestjs/common';
import type { Response } from 'express';
import { FileInterceptor } from '@nestjs/platform-express';
import { memoryStorage } from 'multer';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiResponse } from '@nestjs/swagger';
import { ThrottlerGuard } from '@nestjs/throttler';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto } from './dto/login.dto';
import { RefreshTokenDto } from './dto/refresh-token.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetPasswordDto } from './dto/reset-password.dto';
import { ChangePasswordDto } from './dto/change-password.dto';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ResendVerificationDto } from './dto/resend-verification.dto';
import { SelectTenantDto } from './dto/select-tenant.dto';
import { SwitchTenantDto } from './dto/switch-tenant.dto';
import { TotpCodeDto } from './dto/totp-code.dto';
import { TotpVerifyLoginDto } from './dto/totp-verify-login.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { JwtRefreshGuard } from './guards/jwt-refresh.guard';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import { AuthenticatedUser } from './types/jwt-payload.type';
import { REFRESH_COOKIE } from './strategies/jwt-refresh.strategy';

/** 7 days in milliseconds — must match the JWT refresh expiry in auth.service */
const REFRESH_COOKIE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Shared cookie options for the httpOnly refresh-token cookie. */
function rtCookieOptions(isProduction: boolean) {
  return {
    httpOnly: true,
    // Cross-origin FE (Vercel) → BE (Railway) needs SameSite=None + Secure
    // so the browser stores/sends the cookie on credentialed fetch.
    // Localhost same-site keeps Lax.
    secure: isProduction,
    sameSite: (isProduction ? 'none' : 'lax') as 'none' | 'lax',
    maxAge: REFRESH_COOKIE_TTL_MS,
    path: '/api/v1/auth', // limit scope to auth endpoints only
  };
}

@ApiTags('Auth')
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  private readonly isProduction: boolean;

  constructor(private readonly authService: AuthService) {
    this.isProduction = process.env['NODE_ENV'] === 'production';
  }

  // POST /api/v1/auth/login
  @Post('login')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Login with email and password' })
  @ApiResponse({
    status: 200,
    description:
      'Single-tenant: returns access token + sets httpOnly refresh cookie. ' +
      'Multi-tenant: returns requiresTenantSelection=true + selectionToken + tenants array. ' +
      'TOTP-enabled: returns totpRequired=true + totpToken (short-lived, 5m).',
  })
  @ApiResponse({ status: 401, description: 'Invalid credentials or no active workspace' })
  @ApiResponse({ status: 403, description: 'Account locked or email not verified' })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const ipAddress = req.ip;
    const userAgent = req.headers['user-agent'];
    const result = await this.authService.login(dto, ipAddress, userAgent);

    if ('totpRequired' in result) {
      // TOTP flow: return a short-lived challenge token; no session cookie yet
      return result;
    }

    if ('requiresTenantSelection' in result) {
      // Multi-tenant flow: return selection token; no session cookie yet
      return result;
    }

    res.cookie(REFRESH_COOKIE, result.refreshToken, rtCookieOptions(this.isProduction));
    return { accessToken: result.accessToken, user: result.user };
  }

  // POST /api/v1/auth/select-tenant
  @Post('select-tenant')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Exchange selection token for full session tokens (multi-tenant login step 2)',
  })
  @ApiResponse({ status: 200, description: 'Access token issued + httpOnly refresh cookie set' })
  @ApiResponse({ status: 401, description: 'Invalid / expired selection token or not a member' })
  async selectTenant(
    @Body() dto: SelectTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.selectTenant(dto, req.ip, req.headers['user-agent']);
    res.cookie(REFRESH_COOKIE, result.refreshToken, rtCookieOptions(this.isProduction));
    return { accessToken: result.accessToken, user: result.user };
  }

  // POST /api/v1/auth/switch-tenant
  @Post('switch-tenant')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Switch active workspace without re-login' })
  @ApiResponse({ status: 200, description: 'New access token + rotated refresh cookie' })
  @ApiResponse({ status: 403, description: 'Not an active member of this workspace' })
  async switchTenant(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SwitchTenantDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.switchTenant(
      user,
      dto,
      req.ip,
      req.headers['user-agent'],
    );
    res.cookie(REFRESH_COOKIE, result.refreshToken, rtCookieOptions(this.isProduction));
    return { accessToken: result.accessToken };
  }

  // POST /api/v1/auth/logout
  @Post('logout')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Logout current session and clear refresh-token cookie' })
  async logout(
    @CurrentUser() user: AuthenticatedUser & { sessionId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user.sessionId, user.id);
    res.clearCookie(REFRESH_COOKIE, rtCookieOptions(this.isProduction));
    return { message: 'Logged out successfully' };
  }

  // POST /api/v1/auth/refresh
  @Post('refresh')
  @Public()
  @UseGuards(JwtRefreshGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Rotate refresh token and get new access token' })
  @ApiResponse({ status: 200, description: 'New access token + rotated refresh-token cookie' })
  @ApiResponse({ status: 401, description: 'Invalid or expired refresh token' })
  async refresh(
    @CurrentUser() user: AuthenticatedUser & { rawRefreshToken: string },
    @Res({ passthrough: true }) res: Response,
    @Body() _dto: RefreshTokenDto,
  ) {
    const result = await this.authService.refreshTokens(user);
    // Rotate the httpOnly cookie with the new refresh token
    res.cookie(REFRESH_COOKIE, result.refreshToken, rtCookieOptions(this.isProduction));
    return { accessToken: result.accessToken };
  }

  // GET /api/v1/auth/me
  @Get('me')
  @UseGuards(JwtAuthGuard)
  @Version('1')
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Get currently authenticated user' })
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getCurrentUser(user.id, user.tenantId);
  }

  // POST /api/v1/auth/forgot-password
  @Post('forgot-password')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Send password reset email' })
  async forgotPassword(@Body() dto: ForgotPasswordDto) {
    await this.authService.forgotPassword(dto);
    return { message: 'If this email exists, a reset link has been sent' };
  }

  // POST /api/v1/auth/reset-password
  @Post('reset-password')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reset password using token from email' })
  async resetPassword(@Body() dto: ResetPasswordDto) {
    await this.authService.resetPassword(dto);
    return { message: 'Password reset successfully' };
  }

  // POST /api/v1/auth/verify-email
  @Post('verify-email')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Verify email address using token' })
  async verifyEmail(@Body() dto: VerifyEmailDto) {
    await this.authService.verifyEmail(dto);
    return { message: 'Email verified successfully' };
  }

  // POST /api/v1/auth/resend-verification
  @Post('resend-verification')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Resend email verification link (public — pass email; always generic response)',
  })
  async resendVerification(@Body() dto: ResendVerificationDto) {
    await this.authService.sendVerificationEmailByAddress(dto.email);
    return { message: 'If this email needs verification, a new link has been sent' };
  }

  /**
   * PATCH /api/v1/auth/me
   * Update the calling user's own profile (firstName, lastName, timezone, avatarUrl).
   * Works for super admins and regular tenant users — no TenantGuard required.
   */
  @Patch('me')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Update own profile (SA-safe — no tenant context needed)' })
  async updateMe(@CurrentUser() user: AuthenticatedUser, @Body() dto: UpdateProfileDto) {
    return this.authService.updateMyProfile(user.id, dto);
  }

  @Post('me/avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @UseInterceptors(FileInterceptor('avatar', { storage: memoryStorage() }))
  @ApiOperation({ summary: 'Upload own avatar (works for Super Admin too)' })
  uploadMyAvatar(
    @CurrentUser() user: AuthenticatedUser,
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: 2 * 1024 * 1024 }),
          new FileTypeValidator({ fileType: /^image\/(jpeg|png|webp)$/ }),
        ],
        exceptionFactory: (error: string) => {
          if (/expected type|file type/i.test(error)) {
            return new BadRequestException('Please upload a JPEG, PNG, or WebP image.');
          }
          if (/larger than|maxFileSize|expected size/i.test(error)) {
            return new BadRequestException('Image must be 2 MB or smaller.');
          }
          return new BadRequestException(error || 'Invalid avatar file.');
        },
      }),
    )
    file: Express.Multer.File,
  ) {
    return this.authService.uploadMyAvatar(user.id, file);
  }

  @Delete('me/avatar')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Remove own avatar' })
  clearMyAvatar(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.clearMyAvatar(user.id);
  }

  // POST /api/v1/auth/change-password
  @Post('change-password')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Change password (requires current password)' })
  async changePassword(@CurrentUser() user: AuthenticatedUser, @Body() dto: ChangePasswordDto) {
    await this.authService.changePassword(user.id, dto);
    return { message: 'Password changed successfully' };
  }

  // ─── TOTP ──────────────────────────────────────────────────────────────────

  /**
   * POST /api/v1/auth/totp/setup
   * Generates a new TOTP secret and returns the OTP Auth URI.
   * The user must scan the QR code in their authenticator app and then call
   * POST /auth/totp/enable with a valid code to activate TOTP.
   */
  @Post('totp/setup')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Generate TOTP secret (step 1 of 2-factor setup)' })
  async totpSetup(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.setupTotp(user.id);
  }

  /**
   * POST /api/v1/auth/totp/enable
   * Verifies the first code from the authenticator app and activates TOTP.
   */
  @Post('totp/enable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Enable TOTP (step 2 of 2-factor setup)' })
  async totpEnable(@CurrentUser() user: AuthenticatedUser, @Body() dto: TotpCodeDto) {
    await this.authService.enableTotp(user.id, dto);
    return { message: 'Two-factor authentication enabled' };
  }

  /**
   * POST /api/v1/auth/totp/disable
   * Disables TOTP after verifying the current code.
   */
  @Post('totp/disable')
  @UseGuards(JwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({ summary: 'Disable TOTP (requires valid code)' })
  async totpDisable(@CurrentUser() user: AuthenticatedUser, @Body() dto: TotpCodeDto) {
    await this.authService.disableTotp(user.id, dto);
    return { message: 'Two-factor authentication disabled' };
  }

  /**
   * POST /api/v1/auth/totp/verify
   * Step 2 of TOTP-protected login. Accepts the challenge token from POST /auth/login
   * plus the 6-digit code. Returns full session tokens on success.
   */
  @Post('totp/verify')
  @Public()
  @UseGuards(ThrottlerGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Complete TOTP-protected login (step 2)' })
  @ApiResponse({ status: 200, description: 'Full session tokens issued' })
  @ApiResponse({ status: 401, description: 'Invalid or expired TOTP session / wrong code' })
  async totpVerify(
    @Body() dto: TotpVerifyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.authService.verifyTotpLogin(dto, req.ip, req.headers['user-agent']);

    if ('totpRequired' in result) return result;

    if ('requiresTenantSelection' in result) {
      return result;
    }

    res.cookie(REFRESH_COOKIE, result.refreshToken, rtCookieOptions(this.isProduction));
    return { accessToken: result.accessToken, user: result.user };
  }
}
