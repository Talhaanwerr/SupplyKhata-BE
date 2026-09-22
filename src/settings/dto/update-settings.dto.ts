import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  MaxLength,
  Matches,
  IsArray,
  ArrayMaxSize,
  ValidateIf,
} from 'class-validator';

export class UpdateSettingsDto {
  @ApiPropertyOptional({ example: 'Acme Corp' })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  orgName?: string;

  @ApiPropertyOptional({ example: 'https://example.com/logo.png', nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsString()
  @MaxLength(1000)
  logo?: string | null;

  @ApiPropertyOptional({ example: 'Asia/Karachi' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  @ApiPropertyOptional({ example: 'PKR' })
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string;

  @ApiPropertyOptional({ example: 'DD/MM/YYYY' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  dateFormat?: string;

  @ApiPropertyOptional({ example: 'INV-' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  invoicePrefix?: string;

  @ApiPropertyOptional({ example: '+92 300 1234567' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @ApiPropertyOptional({ example: 'Shop 12, Main Market, Karachi' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  address?: string;

  @ApiPropertyOptional({ example: '#FF5733' })
  @IsOptional()
  @IsString()
  @MaxLength(9)
  @Matches(/^#([A-Fa-f0-9]{6}|[A-Fa-f0-9]{3})$/, {
    message: 'themeColor must be a valid hex color (e.g. #FF5733)',
  })
  themeColor?: string;

  @ApiPropertyOptional({
    example: ['acme.com', 'partner.org'],
    description: 'Email domains allowed to join this workspace. Empty array = any domain.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  allowedDomains?: string[];
}
