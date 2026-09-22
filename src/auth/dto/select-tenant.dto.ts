import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class SelectTenantDto {
  @ApiProperty({ description: 'Short-lived selection token returned by POST /auth/login' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(512)
  selectionToken!: string;

  @ApiProperty({ description: 'ID of the tenant the user wants to enter' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(36)
  tenantId!: string;
}
