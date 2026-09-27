import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  IsArray,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { TenantFeatureFlagInputDto } from './tenant-feature-flag-input.dto';

export class CreateTenantDto {
  @ApiProperty({ example: 'Acme Corp' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({
    example: 'acme-corp',
    description: 'URL-safe slug, lowercase letters, digits, and hyphens',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(3)
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase letters, digits, and hyphens only',
  })
  slug!: string;

  @ApiPropertyOptional({ example: 'acme.com' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(100)
  domain?: string;

  @ApiPropertyOptional({ example: 'acme' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(60)
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'subdomain must be lowercase letters, digits, and hyphens only',
  })
  subdomain?: string;

  @ApiPropertyOptional({ example: 'user-cuid' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;

  @ApiPropertyOptional({ example: 'plan-cuid' })
  @IsOptional()
  @IsString()
  planId?: string;

  @ApiPropertyOptional({ example: 'Asia/Karachi' })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ example: 'PKR' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png' })
  @IsOptional()
  @IsString()
  logo?: string;

  /** Owner who will receive the invite email and become tenant_owner. Required for onboard. */
  @ApiProperty({ example: 'owner@acme.com' })
  @IsEmail()
  @IsNotEmpty()
  ownerEmail!: string;

  @ApiProperty({ example: 'Jane' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  ownerFirstName!: string;

  @ApiProperty({ example: 'Doe' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  ownerLastName!: string;

  @ApiPropertyOptional({ example: '+923001234567' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' && value.trim() === '' ? undefined : value,
  )
  @IsOptional()
  @IsString()
  @MaxLength(30)
  ownerPhone?: string;

  /**
   * Optional feature overrides at create time.
   * Each entry writes a TenantFeature row (enable/disable for this workspace).
   */
  @ApiPropertyOptional({ type: [TenantFeatureFlagInputDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => TenantFeatureFlagInputDto)
  featureFlags?: TenantFeatureFlagInputDto[];
}
