import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, Matches, MaxLength } from 'class-validator';

export class CreateRoleDto {
  @ApiProperty({ example: 'Billing Manager' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  name!: string;

  /** Optional — derived from name when omitted. */
  @ApiPropertyOptional({
    example: 'billing_manager',
    description: 'Lowercase letters, numbers and underscores only. Derived from name when omitted.',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  @Matches(/^[a-z0-9_]+$/, {
    message: 'slug must be lowercase letters, numbers and underscores only',
  })
  slug?: string;

  @ApiPropertyOptional({ example: 'Can manage invoices and payment settings' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;
}
