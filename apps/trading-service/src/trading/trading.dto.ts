import { IsString, IsNotEmpty, IsNumber, IsIn, IsOptional, Min } from 'class-validator';

export class PlaceTradeDto {
  @IsString() @IsNotEmpty()
  declare marketId: string;

  @IsString() @IsIn(['YES', 'NO'])
  declare outcome: 'YES' | 'NO';

  @IsNumber() @Min(10, { message: 'Minimum trade is KES 10' })
  declare amountKes: number;

  @IsString() @IsNotEmpty()
  declare idempotencyKey: string;
}

export class TradeHistoryQueryDto {
  @IsOptional() @IsNumber()
  declare page?: number;

  @IsOptional() @IsNumber()
  declare limit?: number;

  @IsOptional() @IsString()
  declare marketId?: string;

  @IsOptional() @IsString()
  declare status?: string;
}
