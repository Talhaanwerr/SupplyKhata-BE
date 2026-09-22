import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsBoolean, MaxLength, Matches } from 'class-validator';

export class CreateFeatureFlagDto {
  @ApiProperty({ example: 'New Dashboard' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ example: 'new-dashboard' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  @Matches(/^[a-z0-9_-]+$/, {
    message: 'slug must be lowercase letters, numbers, hyphens and underscores only',
  })
  slug!: string;

  @ApiPropertyOptional({ example: 'Enables the redesigned dashboard UI' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  description?: string;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  isGlobal?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
