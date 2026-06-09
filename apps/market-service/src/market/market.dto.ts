import { IsString, IsNotEmpty, IsOptional, IsDateString, IsNumber, IsArray, IsIn, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';

export class CreateMarketDto {
  @IsString() @IsNotEmpty()
  declare title: string;

  @IsString() @IsNotEmpty()
  declare description: string;

  @IsOptional() @IsString()
  declare longDescription?: string;

  @IsString() @IsNotEmpty()
  @IsIn(['politics', 'sports', 'crypto', 'finance', 'tech', 'kenya-local', 'entertainment', 'weather'])
  declare category: string;

  @IsOptional() @IsArray() @IsString({ each: true })
  declare tags?: string[];

  @IsOptional() @IsString()
  declare imageUrl?: string;

  @IsOptional() @IsString()
  declare sourceUrl?: string;

  @IsDateString()
  declare openAt: string;

  @IsDateString()
  declare closeAt: string;

  @IsOptional() @IsDateString()
  declare resolveAt?: string;

  @IsOptional() @IsNumber() @Min(0) @Max(0.2)
  declare rake?: number;

  @IsOptional() @IsNumber() @Min(0)
  declare seedYesKes?: number;

  @IsOptional() @IsNumber() @Min(0)
  declare seedNoKes?: number;
}

export class ResolveMarketDto {
  @IsString() @IsIn(['YES', 'NO'])
  declare outcome: 'YES' | 'NO';

  @IsOptional() @IsString()
  declare note?: string;
}

export class MarketQueryDto {
  @IsOptional() @IsString()
  category?: string;

  @IsOptional() @IsString()
  @IsIn(['DRAFT', 'ACTIVE', 'CLOSED', 'RESOLVED', 'CANCELLED', 'DISPUTED', 'all'])
  status?: string;

  @IsOptional() @IsString()
  @IsIn(['trending', 'volume', 'liquidity', 'newest', 'closing-soon'])
  sort?: string;

  @IsOptional() @Type(() => Number) @IsNumber()
  page?: number;

  @IsOptional() @Type(() => Number) @IsNumber()
  limit?: number;

  @IsOptional() @IsString()
  search?: string;
}
