import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateTenantDto } from './create-tenant.dto';

export class UpdateTenantDto extends PartialType(OmitType(CreateTenantDto, ['slug'] as const)) {
  @ApiPropertyOptional({ example: 'user-cuid' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}
