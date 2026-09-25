import { IsEnum, IsOptional, IsString, Matches } from 'class-validator';

export enum CollectionBucket {
  DUE_TODAY = 'DUE_TODAY',
  OVERDUE = 'OVERDUE',
  DUE_SOON = 'DUE_SOON',
  ALL = 'ALL',
}

export class CollectionsListQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  date?: string;

  @IsOptional()
  @IsString()
  riderId?: string;

  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @IsEnum(CollectionBucket)
  bucket?: CollectionBucket;

  @IsOptional()
  @IsString()
  search?: string;
}
