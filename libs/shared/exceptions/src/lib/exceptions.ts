import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

// ─── HTTP Exception Filter ────────────────────────────────────────────────────

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(GlobalExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let message = 'Internal server error';
    let errors: unknown = null;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const res = exception.getResponse();
      if (typeof res === 'string') {
        message = res;
      } else if (typeof res === 'object') {
        const r = res as Record<string, unknown>;
        message = (r['message'] as string) ?? message;
        errors = r['errors'] ?? null;
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(`Unhandled exception: ${exception.message}`, exception.stack);
    }

    response.status(status).json({
      success: false,
      statusCode: status,
      message,
      errors,
      path: request.url,
      timestamp: new Date().toISOString(),
    });
  }
}

// ─── Domain Exceptions ────────────────────────────────────────────────────────

import { BadRequestException, ConflictException, NotFoundException, ForbiddenException, UnauthorizedException } from '@nestjs/common';

export class PhoneAlreadyExistsException extends ConflictException {
  constructor() {
    super('A user with this phone number already exists');
  }
}

export class InvalidOtpException extends BadRequestException {
  constructor() {
    super('Invalid or expired OTP code');
  }
}

export class InvalidCredentialsException extends UnauthorizedException {
  constructor() {
    super('Invalid phone number or password');
  }
}

export class MarketNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(`Market ${id} not found`);
  }
}

export class MarketNotActiveException extends BadRequestException {
  constructor() {
    super('This market is not currently accepting trades');
  }
}

export class MarketClosedException extends BadRequestException {
  constructor() {
    super('This market has closed for trading');
  }
}

export class InsufficientBalanceException extends BadRequestException {
  constructor(available: number, required: number) {
    super(
      `Insufficient balance. Available: KES ${available.toFixed(2)}, Required: KES ${required.toFixed(2)}`,
    );
  }
}

export class DailyLimitExceededException extends BadRequestException {
  constructor(type: 'deposit' | 'withdrawal', limit: number) {
    super(`Daily ${type} limit of KES ${limit.toFixed(2)} exceeded`);
  }
}

export class KycRequiredException extends ForbiddenException {
  constructor(requiredTier: number) {
    super(`KYC Tier ${requiredTier} verification required for this action`);
  }
}

export class PaymentNotFoundException extends NotFoundException {
  constructor(id: string) {
    super(`Payment ${id} not found`);
  }
}

export class DuplicateTradeException extends ConflictException {
  constructor() {
    super('Duplicate trade detected. Please use a unique idempotency key.');
  }
}

export class TradingMarketBusyException extends ConflictException {
  constructor() {
    super('Market is busy, please retry your trade in a moment');
  }
}
