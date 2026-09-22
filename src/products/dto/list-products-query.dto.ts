import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class ListProductsQueryDto {
  @ApiPropertyOptional({ description: 'Search by product name' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;

  @ApiPropertyOptional({
    description: 'Filter by active status as "true" | "false". Omit for both.',
    enum: ['true', 'false'],
  })
  @IsOptional()
  @Transform(({ value }) => {
    // Keep string form — Boolean("false") === true breaks inactive filter
    if (value === true || value === 'true' || value === '1') return 'true';
    if (value === false || value === 'false' || value === '0') return 'false';
    return value;
  })
  @IsIn(['true', 'false'])
  isActive?: 'true' | 'false';
}
