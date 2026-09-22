import { ApiProperty } from '@nestjs/swagger';
import { IsArray, IsString, IsNotEmpty, ArrayMinSize } from 'class-validator';

export class AssignPermissionsDto {
  @ApiProperty({
    example: ['perm-cuid-1', 'perm-cuid-2'],
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  permissionIds!: string[];
}
