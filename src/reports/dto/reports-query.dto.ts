import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

export class DailySalesQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;
}

export class MonthlySummaryQueryDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}

export class DateRangeQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;
}

export class CustomerLedgerReportQueryDto extends DateRangeQueryDto {
  @IsString()
  customerId!: string;
}

export class RiderCollectionQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsString()
  riderId?: string;
}

export class VehiclePerformanceQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsString()
  vehicleId?: string;
}

export class CollectionPerformanceQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsString()
  collectorId?: string;

  @IsOptional()
  @IsString()
  areaId?: string;
}

export class ExpensesReportQueryDto extends DateRangeQueryDto {
  /** Free-text title contains filter (no category enum). */
  @IsOptional()
  @IsString()
  search?: string;
}

export class ReportExportQueryDto {
  @IsString()
  type!: string;

  @IsOptional()
  @IsString()
  format?: 'csv' | 'pdf';

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  to?: string;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  month?: number;

  @Type(() => Number)
  @IsOptional()
  @IsInt()
  year?: number;

  @IsOptional()
  @IsString()
  customerId?: string;

  @IsOptional()
  @IsString()
  riderId?: string;

  @IsOptional()
  @IsString()
  search?: string;
}
