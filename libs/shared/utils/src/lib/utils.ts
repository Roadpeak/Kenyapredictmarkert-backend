import { createHash } from 'crypto';
import { customAlphabet } from 'nanoid';

// ─── Phone Utils ──────────────────────────────────────────────────────────────

export function normalizePhone(phone: string): string {
  const cleaned = phone.replace(/\s+/g, '').replace(/^0/, '254');
  if (!cleaned.startsWith('254')) {
    return `254${cleaned}`;
  }
  return cleaned;
}

export function formatPhoneForDisplay(phone: string): string {
  const normalized = normalizePhone(phone);
  return `+${normalized}`;
}

export function isValidKenyanPhone(phone: string): boolean {
  const normalized = normalizePhone(phone);
  return /^254(7|1)\d{8}$/.test(normalized);
}

// ─── KES Formatting ───────────────────────────────────────────────────────────

export function formatKes(amount: number | string): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount;
  return `KES ${num.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function toKesDecimal(amount: number): string {
  return amount.toFixed(2);
}

// ─── Probability / Price Utils ────────────────────────────────────────────────

export function calcYesPrice(poolYes: number, poolNo: number): number {
  const total = poolYes + poolNo;
  if (total === 0) return 0.5;
  return poolYes / total;
}

export function calcNoPrice(poolYes: number, poolNo: number): number {
  return 1 - calcYesPrice(poolYes, poolNo);
}

export function calcSharesReceived(amountKes: number, sharePrice = 10): number {
  return amountKes / sharePrice;
}

export function calcPayoutPerShare(
  totalPoolKes: number,
  rake: number,
  winningShares: number,
): number {
  if (winningShares === 0) return 0;
  return (totalPoolKes * (1 - rake)) / winningShares;
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

export function generateSettlementId(marketId: string, userId: string, outcome: string): string {
  return createHash('sha256')
    .update(`${marketId}:${userId}:${outcome}`)
    .digest('hex');
}

export function generateIdempotencyKey(): string {
  const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz', 21);
  return nanoid();
}

export function generateReferralCode(): string {
  const nanoid = customAlphabet('0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', 8);
  return nanoid();
}

// ─── OTP ─────────────────────────────────────────────────────────────────────

export function generateOtp(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ─── Date Utils ───────────────────────────────────────────────────────────────

export function todayDateString(): string {
  return new Date().toISOString().split('T')[0];
}

export function isExpired(expiresAt: Date): boolean {
  return new Date() > expiresAt;
}
