import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  StreamableFile,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Request } from 'express';
import { ApiResponse } from '../types/api-response.type';

@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | StreamableFile> {
  intercept(
    context: ExecutionContext,
    next: CallHandler<T>,
  ): Observable<ApiResponse<T> | StreamableFile> {
    const request = context.switchToHttp().getRequest<Request>();
    const statusCode = context.switchToHttp().getResponse<{ statusCode: number }>().statusCode;

    return next.handle().pipe(
      map((data) => {
        // Binary / file downloads must not be wrapped in the JSON envelope
        if (data instanceof StreamableFile) return data;

        return {
          success: true,
          statusCode,
          message: this.resolveMessage(request.method),
          data: data ?? null,
          timestamp: new Date().toISOString(),
          path: request.url,
        };
      }),
    );
  }

  private resolveMessage(method: string): string {
    const messages: Record<string, string> = {
      GET: 'Data retrieved successfully',
      POST: 'Created successfully',
      PUT: 'Updated successfully',
      PATCH: 'Updated successfully',
      DELETE: 'Deleted successfully',
    };
    return messages[method] ?? 'Success';
  }
}
