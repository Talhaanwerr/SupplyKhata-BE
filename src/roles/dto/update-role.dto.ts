import { OmitType, PartialType } from '@nestjs/swagger';
import { CreateRoleDto } from './create-role.dto';

/** slug is immutable after creation */
export class UpdateRoleDto extends PartialType(OmitType(CreateRoleDto, ['slug'] as const)) {}
