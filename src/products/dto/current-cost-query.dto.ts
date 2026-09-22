import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class CurrentCostQueryDto {
  @ApiPropertyOptional({
    description: 'Resolve cost as of this ISO date (defaults to today)',
    example: '2026-09-17',
  })
  @IsOptional()
  @IsDateString()
  date?: string;
}
