import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class SwitchTenantDto {
  @ApiProperty({ description: 'ID of the tenant to switch to' })
  @IsString()
  @IsNotEmpty()
  tenantId!: string;
}
