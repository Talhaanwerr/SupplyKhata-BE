import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export enum FileVisibility {
  PUBLIC = 'PUBLIC',
  PRIVATE = 'PRIVATE',
}

export class ListFilesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ example: 'report' })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: FileVisibility, example: FileVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(FileVisibility)
  visibility?: FileVisibility;
}
