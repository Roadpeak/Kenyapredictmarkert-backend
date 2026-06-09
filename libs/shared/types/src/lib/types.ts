// ─── Enums ────────────────────────────────────────────────────────────────────

export enum Role {
  USER = 'USER',
  MODERATOR = 'MODERATOR',
  ADMIN = 'ADMIN',
  SUPER_ADMIN = 'SUPER_ADMIN',
}

export enum OtpPurpose {
  PHONE_VERIFY = 'PHONE_VERIFY',
  LOGIN = 'LOGIN',
  WITHDRAWAL_CONFIRM = 'WITHDRAWAL_CONFIRM',
  PASSWORD_RESET = 'PASSWORD_RESET',
  KYC_STEP = 'KYC_STEP',
}

export enum KycStatus {
  NONE = 'NONE',
  PENDING = 'PENDING',
  PHONE_VERIFIED = 'PHONE_VERIFIED',
  ID_SUBMITTED = 'ID_SUBMITTED',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum MarketStatus {
  DRAFT = 'DRAFT',
  ACTIVE = 'ACTIVE',
  CLOSED = 'CLOSED',
  RESOLVED = 'RESOLVED',
  CANCELLED = 'CANCELLED',
  DISPUTED = 'DISPUTED',
}

export enum Outcome {
  YES = 'YES',
  NO = 'NO',
}

export enum TradeStatus {
  PENDING = 'PENDING',
  CONFIRMED = 'CONFIRMED',
  SETTLED = 'SETTLED',
  REFUNDED = 'REFUNDED',
  FAILED = 'FAILED',
}

export enum PaymentType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
}

export enum PaymentStatus {
  INITIATED = 'INITIATED',
  PENDING_MPESA = 'PENDING_MPESA',
  PROCESSING = 'PROCESSING',
  COMPLETED = 'COMPLETED',
  FAILED = 'FAILED',
  CANCELLED = 'CANCELLED',
  REFUNDED = 'REFUNDED',
}

export enum LedgerType {
  DEPOSIT = 'DEPOSIT',
  WITHDRAWAL = 'WITHDRAWAL',
  TRADE_RESERVE = 'TRADE_RESERVE',
  TRADE_RELEASE = 'TRADE_RELEASE',
  TRADE_DEBIT = 'TRADE_DEBIT',
  PAYOUT = 'PAYOUT',
  REFUND = 'REFUND',
  RAKE_DEBIT = 'RAKE_DEBIT',
  BONUS_CREDIT = 'BONUS_CREDIT',
  REFERRAL_BONUS = 'REFERRAL_BONUS',
}

export enum Direction {
  CREDIT = 'CREDIT',
  DEBIT = 'DEBIT',
}

export enum NotificationType {
  TRADE_CONFIRMED = 'TRADE_CONFIRMED',
  TRADE_SETTLED = 'TRADE_SETTLED',
  MARKET_RESOLVED = 'MARKET_RESOLVED',
  DEPOSIT_CONFIRMED = 'DEPOSIT_CONFIRMED',
  WITHDRAWAL_COMPLETED = 'WITHDRAWAL_COMPLETED',
  WITHDRAWAL_FAILED = 'WITHDRAWAL_FAILED',
  MARKET_CLOSING_SOON = 'MARKET_CLOSING_SOON',
  KYC_APPROVED = 'KYC_APPROVED',
  KYC_REJECTED = 'KYC_REJECTED',
  GENERAL = 'GENERAL',
}

export enum NotificationChannel {
  SMS = 'SMS',
  PUSH = 'PUSH',
  IN_APP = 'IN_APP',
}

// ─── JWT Payload ──────────────────────────────────────────────────────────────

export interface JwtPayload {
  sub: string;
  phone: string;
  role: Role;
  kycTier: number;
  iat?: number;
  exp?: number;
  jti?: string;
}

// ─── Kafka Event Payloads ─────────────────────────────────────────────────────

export interface UserRegisteredPayload {
  userId: string;
  phone: string;
  createdAt: string;
}

export interface UserVerifiedPayload {
  userId: string;
  phone: string;
}

export interface MarketResolvedPayload {
  marketId: string;
  marketTitle: string;
  outcome: Outcome;
  totalPoolKes: number;
  rake: number;
  resolvedAt: string;
}

export interface MarketCancelledPayload {
  marketId: string;
  cancelledAt: string;
}

export interface TradeConfirmedPayload {
  tradeId: string;
  userId: string;
  marketId: string;
  marketTitle: string;
  outcome: Outcome;
  amountKes: number;
  sharesCount: number;
  sharesReceived: number;
  pricePerShare: number;
}

export interface MarketSettledPayload {
  marketId: string;
  marketTitle: string;
  winningOutcome: Outcome;
  userId: string;
  outcome: Outcome;
  payoutKes: number;
  sharesHeld: number;
}

export interface DepositCompletedPayload {
  paymentId: string;
  userId: string;
  amountKes: number;
  mpesaReceiptNumber: string;
}

export interface WithdrawalCompletedPayload {
  paymentId: string;
  userId: string;
  amountKes: number;
  phone: string;
  mpesaReceiptNumber: string;
}

export interface WithdrawalFailedPayload {
  paymentId: string;
  userId: string;
  amountKes: number;
  reason: string;
}

export interface SendSmsPayload {
  userId: string;
  phone: string;
  message: string;
  notificationType: NotificationType;
}

export interface SendPushPayload {
  userId: string;
  title: string;
  body: string;
  data?: Record<string, string>;
  notificationType: NotificationType;
}

// ─── WebSocket Event Payloads ─────────────────────────────────────────────────

export interface WsMarketPriceUpdate {
  marketId: string;
  yesPrice: number;
  noPrice: number;
  poolYesKes: number;
  poolNoKes: number;
  totalVolume: number;
  tradeCount: number;
  timestamp: number;
}

export interface WsMarketStatusChange {
  marketId: string;
  status: MarketStatus;
  resolvedOutcome?: Outcome;
  timestamp: number;
}

export interface WsRecentTrade {
  marketId: string;
  outcome: Outcome;
  amountKes: number;
  priceAtTrade: number;
  timestamp: number;
}

export interface WsWalletUpdate {
  availableBalance: number;
  reservedBalance: number;
  timestamp: number;
}

export interface WsPaymentUpdate {
  paymentId: string;
  status: PaymentStatus;
  amountKes: number;
  type: PaymentType;
  mpesaReceiptNumber?: string;
  timestamp: number;
}

// ─── API Response Wrappers ────────────────────────────────────────────────────

export interface ApiResponse<T> {
  success: boolean;
  data: T;
  message?: string;
}

export interface PaginatedResponse<T> {
  success: boolean;
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}
