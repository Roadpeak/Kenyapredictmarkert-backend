import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import type { AxiosRequestConfig } from 'axios';
import { IsString, IsNotEmpty, IsNumber, Min, IsOptional, IsIn, IsDateString } from 'class-validator';

// ─── DTOs ──────────────────────────────────────────────────────────────────────

export class CreateMarketDto {
  @IsString() @IsNotEmpty() declare title: string;
  @IsString() @IsNotEmpty() declare description: string;
  @IsDateString() declare closesAt: string;
  @IsNumber() @Min(0) declare seedYesKes: number;
  @IsNumber() @Min(0) declare seedNoKes: number;
  @IsOptional() @IsString() declare category?: string;
  @IsOptional() @IsString() declare imageUrl?: string;
}

export class ResolveMarketDto {
  @IsIn(['YES', 'NO']) declare outcome: 'YES' | 'NO';
}

export class ApproveKycDto {
  @IsString() @IsNotEmpty() declare userId: string;
}

export class RejectKycDto {
  @IsString() @IsNotEmpty() declare userId: string;
  @IsString() @IsNotEmpty() declare reason: string;
}

// ─── Service ──────────────────────────────────────────────────────────────────

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);
  private readonly internalKey: string;
  private readonly marketServiceUrl: string;
  private readonly userServiceUrl: string;

  constructor(
    config: ConfigService,
    private readonly http: HttpService,
  ) {
    this.internalKey = config.get('INTERNAL_API_KEY', 'changeme');
    this.marketServiceUrl = config.get('MARKET_SERVICE_URL', 'http://localhost:3003');
    this.userServiceUrl = config.get('USER_SERVICE_URL', 'http://localhost:3002');
  }

  // ─── Market management ────────────────────────────────────────────────────────

  async createMarket(dto: CreateMarketDto, token: string) {
    return this.post(`${this.marketServiceUrl}/api/admin/markets`, dto, token);
  }

  async activateMarket(marketId: string, token: string) {
    return this.put(`${this.marketServiceUrl}/api/admin/markets/${marketId}/activate`, {}, token);
  }

  async resolveMarket(marketId: string, dto: ResolveMarketDto, token: string) {
    return this.put(`${this.marketServiceUrl}/api/admin/markets/${marketId}/resolve`, dto, token);
  }

  async cancelMarket(marketId: string, token: string) {
    return this.put(`${this.marketServiceUrl}/api/admin/markets/${marketId}/cancel`, {}, token);
  }

  async listMarkets(status?: string, page = 1, limit = 20, token?: string) {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (status) params.set('status', status);
    return this.get(`${this.marketServiceUrl}/api/markets?${params}`, token);
  }

  // ─── KYC management ───────────────────────────────────────────────────────────

  async listPendingKyc(page = 1, limit = 20, token?: string) {
    return this.get(
      `${this.userServiceUrl}/api/admin/kyc/pending?page=${page}&limit=${limit}`,
      token,
    );
  }

  async approveKyc(userId: string, token: string) {
    return this.put(`${this.userServiceUrl}/api/admin/users/${userId}/kyc/approve`, {}, token);
  }

  async rejectKyc(userId: string, reason: string, token: string) {
    return this.put(`${this.userServiceUrl}/api/admin/users/${userId}/kyc/reject`, { note: reason }, token);
  }

  // ─── User management ──────────────────────────────────────────────────────────

  async listUsers(page = 1, limit = 20, token?: string) {
    return this.get(`${this.userServiceUrl}/api/admin/users?page=${page}&limit=${limit}`, token);
  }

  async getUser(userId: string, token?: string) {
    return this.get(`${this.userServiceUrl}/api/admin/users/${userId}`, token);
  }

  async suspendUser(userId: string, token: string) {
    return this.post(`${this.userServiceUrl}/api/admin/users/${userId}/suspend`, {}, token);
  }

  async unsuspendUser(userId: string, token: string) {
    return this.post(`${this.userServiceUrl}/api/admin/users/${userId}/unsuspend`, {}, token);
  }

  // ─── HTTP helpers ─────────────────────────────────────────────────────────────

  private headers(authToken?: string): AxiosRequestConfig['headers'] {
    return {
      'x-internal-key': this.internalKey,
      'content-type': 'application/json',
      ...(authToken ? { authorization: `Bearer ${authToken}` } : {}),
    };
  }

  private async get(url: string, authToken?: string) {
    try {
      const res = await firstValueFrom(
        this.http.get<unknown>(url, { headers: this.headers(authToken) }),
      );
      return res.data;
    } catch (err: unknown) {
      this.handleHttpError(err, url);
    }
  }

  private async post(url: string, data: unknown, authToken?: string) {
    try {
      const res = await firstValueFrom(
        this.http.post<unknown>(url, data, { headers: this.headers(authToken) }),
      );
      return res.data;
    } catch (err: unknown) {
      this.handleHttpError(err, url);
    }
  }

  private async put(url: string, data: unknown, authToken?: string) {
    try {
      const res = await firstValueFrom(
        this.http.put<unknown>(url, data, { headers: this.headers(authToken) }),
      );
      return res.data;
    } catch (err: unknown) {
      this.handleHttpError(err, url);
    }
  }

  private handleHttpError(err: unknown, url: string): never {
    const msg = err instanceof Error ? err.message : String(err);
    this.logger.error(`Admin HTTP call failed: ${url} — ${msg}`);
    // Re-throw with context
    throw new BadRequestException(`Downstream service error: ${msg}`);
  }
}
