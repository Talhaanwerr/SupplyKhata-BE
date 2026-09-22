import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional } from 'class-validator';

export class AssignRoleToUserDto {
  @ApiProperty({ example: 'role-cuid' })
  @IsString()
  @IsNotEmpty()
  roleId!: string;

  @ApiPropertyOptional({ example: 'tenant-cuid' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  tenantId?: string;
}
