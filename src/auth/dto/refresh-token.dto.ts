import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';

/**
 * Refresh token is primarily read from the httpOnly `rt` cookie.
 * Body field is optional — kept only for Swagger / curl compatibility.
 */
export class RefreshTokenDto {
  @ApiPropertyOptional({
    description: 'Optional. Prefer the httpOnly refresh cookie; body is a fallback only.',
  })
  @IsOptional()
  @IsString()
  refreshToken?: string;
}
