import { IsString, IsNotEmpty, IsNumber, Min, Matches } from 'class-validator';

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

  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+?254|0)[71]\d{8}$/, {
    message: 'Phone must be a valid Kenyan number',
  })
  declare phone: string;

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
