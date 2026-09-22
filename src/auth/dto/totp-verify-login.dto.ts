import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/** Body for POST /auth/totp/verify — step 2 of TOTP-protected login. */
export class TotpVerifyLoginDto {
  /** Short-lived JWT returned by POST /auth/login when totpRequired is true. */
  @ApiProperty({
    example: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...',
    description: 'Short-lived JWT returned by POST /auth/login when totpRequired is true',
  })
  @IsString()
  totpToken!: string;

  /** 6-digit TOTP code from the authenticator app. */
  @ApiProperty({ example: '123456', description: '6-digit TOTP code from the authenticator app' })
  @IsString()
  @Length(6, 6, { message: 'code must be exactly 6 digits' })
  code!: string;
}
