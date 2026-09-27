import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean, IsNotEmpty, IsString, MaxLength } from 'class-validator';

/** Per-flag enable/disable when Super Admin creates a tenant. */
export class TenantFeatureFlagInputDto {
  @ApiProperty({ example: 'returnable-containers' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  slug!: string;

  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;
}
