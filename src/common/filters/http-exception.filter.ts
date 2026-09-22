import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Request, Response } from 'express';
import { ApiResponse } from '../types/api-response.type';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    const mapped = this.mapPrismaException(exception);
    const isHttpException = exception instanceof HttpException;
    const statusCode = mapped
      ? mapped.statusCode
      : isHttpException
        ? exception.getStatus()
        : HttpStatus.INTERNAL_SERVER_ERROR;

    const exceptionResponse = isHttpException ? exception.getResponse() : null;
    const message = mapped ? mapped.message : this.resolveMessage(exceptionResponse, statusCode);

    if (statusCode >= 500) {
      this.logger.error(
        `[${request.method}] ${this.maskUrl(request.url)} — ${statusCode}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(
        `[${request.method}] ${this.maskUrl(request.url)} — ${statusCode}: ${message}`,
      );
    }

    const clientMessage = statusCode >= 500 ? 'Internal server error' : message;

    const body: ApiResponse<null> = {
      success: false,
      statusCode,
      message: clientMessage,
      data: null,
      timestamp: new Date().toISOString(),
      path: this.maskUrl(request.url),
    };

    response.status(statusCode).json(body);
  }

  /**
   * Map common Prisma errors to client-safe HTTP responses so FK / unique
   * violations do not leak as raw 500s.
   */
  private mapPrismaException(exception: unknown): { statusCode: number; message: string } | null {
    if (!(exception instanceof Prisma.PrismaClientKnownRequestError)) {
      return null;
    }

    switch (exception.code) {
      case 'P2002': {
        const target = (exception.meta?.['target'] as string[] | string | undefined) ?? 'field';
        const fields = Array.isArray(target) ? target.join(', ') : String(target);
        return {
          statusCode: HttpStatus.CONFLICT,
          message: `A record with this ${fields} already exists`,
        };
      }
      case 'P2003': {
        const field = String(exception.meta?.['field_name'] ?? 'referenced id');
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          message: `Invalid reference: ${field} does not exist or is not allowed`,
        };
      }
      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          message: 'Record not found',
        };
      default:
        return null;
    }
  }

  private maskUrl(url: string): string {
    return url.replace(/([?&])(token|key|secret|password|apikey)=[^&]*/gi, '$1$2=***');
  }

  private resolveMessage(exceptionResponse: string | object | null, statusCode: number): string {
    if (!exceptionResponse) {
      return statusCode >= 500 ? 'Internal server error' : 'An error occurred';
    }

    if (typeof exceptionResponse === 'string') {
      return this.humanizeValidationMessage(exceptionResponse);
    }

    if (typeof exceptionResponse === 'object' && 'message' in exceptionResponse) {
      const msg = (exceptionResponse as Record<string, unknown>)['message'];
      if (Array.isArray(msg)) {
        return msg.map((m) => this.humanizeValidationMessage(String(m))).join(', ');
      }
      if (typeof msg === 'string') return this.humanizeValidationMessage(msg);
    }

    return 'An error occurred';
  }

  /** Turn Nest ParseFilePipe / FileTypeValidator noise into readable copy. */
  private humanizeValidationMessage(message: string): string {
    if (
      /expected type is \/?\^?image/i.test(message) ||
      /file type is application\//i.test(message)
    ) {
      return 'Please upload a JPEG, PNG, or WebP image.';
    }
    if (/maxFileSize|File is larger than|expected size is/i.test(message)) {
      return 'Image must be 2 MB or smaller.';
    }
    return message;
  }
}
