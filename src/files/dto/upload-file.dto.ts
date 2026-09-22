import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { FileVisibility } from './list-files-query.dto';

export class UploadFileDto {
  @ApiPropertyOptional({ enum: FileVisibility, example: FileVisibility.PRIVATE })
  @IsOptional()
  @IsEnum(FileVisibility)
  visibility?: FileVisibility;
}
