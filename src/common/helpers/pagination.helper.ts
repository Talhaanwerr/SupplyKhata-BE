import { PaginationMeta } from '../types/api-response.type';

export interface PaginationParams {
  page: number;
  limit: number;
}

export function getPaginationParams(params: PaginationParams): {
  skip: number;
  take: number;
} {
  const page = Math.max(1, params.page);
  const limit = Math.min(100, Math.max(1, params.limit));
  return { skip: (page - 1) * limit, take: limit };
}

export function buildPaginationMeta(total: number, page: number, limit: number): PaginationMeta {
  const totalPages = Math.ceil(total / limit);
  return {
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPrevPage: page > 1,
  };
}
