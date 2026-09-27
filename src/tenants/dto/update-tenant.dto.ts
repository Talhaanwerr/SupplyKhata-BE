import { ApiPropertyOptional, OmitType, PartialType } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CreateTenantDto } from './create-tenant.dto';

export class UpdateTenantDto extends PartialType(
  OmitType(CreateTenantDto, [
    'slug',
    'ownerEmail',
    'ownerFirstName',
    'ownerLastName',
    'ownerPhone',
    'featureFlags',
  ] as const),
) {
  @ApiPropertyOptional({ example: 'user-cuid' })
  @IsOptional()
  @IsString()
  ownerUserId?: string;
}
