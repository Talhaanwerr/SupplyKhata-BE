import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';

export class ExportQueryDto {
  @ApiPropertyOptional({
    enum: ['csv', 'json'],
    example: 'csv',
    default: 'csv',
  })
  @IsOptional()
  @IsIn(['csv', 'json'])
  format?: 'csv' | 'json' = 'csv';
}
