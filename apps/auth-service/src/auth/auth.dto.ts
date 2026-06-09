import {
  IsString,
  IsNotEmpty,
  IsOptional,
  IsEmail,
  MinLength,
  Matches,
} from 'class-validator';

export class RegisterDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(\+?254|0)[71]\d{8}$/, {
    message: 'Phone must be a valid Kenyan number (e.g. 0712345678 or +254712345678)',
  })
  declare phone: string;

  @IsString()
  @MinLength(8, { message: 'Password must be at least 8 characters' })
  declare password: string;

  @IsOptional()
  @IsEmail()
  declare email?: string;
}

export class VerifyPhoneDto {
  @IsString()
  @IsNotEmpty()
  declare phone: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  declare otp: string;
}

export class LoginDto {
  @IsString()
  @IsNotEmpty()
  declare phone: string;

  @IsString()
  @IsNotEmpty()
  declare password: string;
}

export class RefreshTokenDto {
  @IsString()
  @IsNotEmpty()
  declare refreshToken: string;
}

export class RequestOtpDto {
  @IsString()
  @IsNotEmpty()
  declare phone: string;

  @IsString()
  @IsNotEmpty()
  declare purpose: string;
}

export class ResetPasswordRequestDto {
  @IsString()
  @IsNotEmpty()
  declare phone: string;
}

export class ResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  declare phone: string;

  @IsString()
  @Matches(/^\d{6}$/, { message: 'OTP must be 6 digits' })
  declare otp: string;

  @IsString()
  @MinLength(8)
  declare newPassword: string;
}
