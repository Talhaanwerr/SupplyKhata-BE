import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({ example: 'SaaS Boilerplate' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  appName?: string;

  @ApiPropertyOptional({ example: 'support@example.com' })
  @IsOptional()
  @IsEmail()
  @MaxLength(200)
  supportEmail?: string;

  @ApiPropertyOptional({ example: 'UTC' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  defaultTimezone?: string;

  @ApiPropertyOptional({ example: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  defaultCurrency?: string;
}
