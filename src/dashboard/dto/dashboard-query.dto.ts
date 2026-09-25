import { IsOptional, IsDateString, Matches } from 'class-validator';

export class DashboardQueryDto {
  @IsOptional()
  @IsDateString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: 'date must be YYYY-MM-DD' })
  date?: string;
}
