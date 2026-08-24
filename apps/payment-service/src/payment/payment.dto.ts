import { IsString, IsNotEmpty, IsNumber, IsOptional, Min, Matches } from 'class-validator';

export class InitiateDepositDto {
  @IsNumber()
  @Min(10, { message: 'Minimum deposit is KES 10' })
  declare amountKes: number;

  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+?254|0)[71]\d{8}$/, {
    message: 'Phone must be a valid Kenyan number',
  })
  declare phone: string;
}

export class InitiateWithdrawalDto {
  @IsNumber()
  @Min(100, { message: 'Minimum withdrawal is KES 100' })
  declare amountKes: number;

  /**
   * Ignored — payouts go to the phone on the caller's JWT, never to a
   * client-supplied number. Kept optional (rather than removed) so a stale
   * frontend bundle still in someone's browser doesn't fail validation
   * mid-deploy; it can be dropped once no old clients remain.
   */
  @IsOptional()
  @IsString()
  declare phone?: string;

  @IsString()
  @IsNotEmpty()
  declare otp: string;
}

export class ConfirmWithdrawalDto {
  @IsString()
  @IsNotEmpty()
  declare paymentId: string;

  @IsString()
  @IsNotEmpty()
  declare otp: string;
}
