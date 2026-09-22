import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsNotEmpty, ArrayMinSize } from 'class-validator';

export class AssignUserRolesDto {
  @ApiProperty({
    example: ['role-cuid-1', 'role-cuid-2'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  roleIds!: string[];
}
