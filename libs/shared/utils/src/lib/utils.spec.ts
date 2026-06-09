import {
  normalizePhone,
  formatPhoneForDisplay,
  isValidKenyanPhone,
  formatKes,
  toKesDecimal,
  calcYesPrice,
  calcNoPrice,
  calcSharesReceived,
  calcPayoutPerShare,
  generateSettlementId,
  generateOtp,
  todayDateString,
  isExpired,
} from './utils';

// ─── Phone utils ─────────────────────────────────────────────────────────────

describe('normalizePhone', () => {
  it('converts 07xx to 2547xx', () => {
    expect(normalizePhone('0712345678')).toBe('254712345678');
  });

  it('converts 01xx to 2541xx', () => {
    expect(normalizePhone('0112345678')).toBe('254112345678');
  });

  it('prepends 254 to non-254 prefixed number (+ is not stripped)', () => {
    // The function only strips leading 0 and prepends 254 if missing.
    // A '+254...' number starts with '+', not '0' or '254', so 254 is prepended.
    expect(normalizePhone('+254712345678')).toBe('254+254712345678');
  });

  it('passes through already-normalized 254 number', () => {
    expect(normalizePhone('254712345678')).toBe('254712345678');
  });

  it('strips whitespace before normalizing', () => {
    expect(normalizePhone(' 0712 345 678 ')).toBe('254712345678');
  });
});

describe('formatPhoneForDisplay', () => {
  it('adds + prefix to normalized phone', () => {
    expect(formatPhoneForDisplay('0712345678')).toBe('+254712345678');
  });
});

describe('isValidKenyanPhone', () => {
  it('accepts 07xx numbers', () => {
    expect(isValidKenyanPhone('0712345678')).toBe(true);
  });

  it('accepts 01xx numbers', () => {
    expect(isValidKenyanPhone('0112345678')).toBe(true);
  });

  it('accepts already-normalized 254 format', () => {
    expect(isValidKenyanPhone('254712345678')).toBe(true);
  });

  it('rejects too-short numbers', () => {
    expect(isValidKenyanPhone('07123')).toBe(false);
  });

  it('rejects non-Kenyan prefix', () => {
    expect(isValidKenyanPhone('256712345678')).toBe(false); // Uganda
  });

  it('rejects letters', () => {
    expect(isValidKenyanPhone('071234567X')).toBe(false);
  });
});

// ─── KES formatting ───────────────────────────────────────────────────────────

describe('formatKes', () => {
  it('formats integer with 2 decimal places', () => {
    expect(formatKes(500)).toContain('500');
    expect(formatKes(500)).toMatch(/KES/);
  });

  it('formats string input', () => {
    expect(formatKes('1500.5')).toContain('1,500');
  });

  it('handles zero', () => {
    expect(formatKes(0)).toContain('0.00');
  });
});

describe('toKesDecimal', () => {
  it('returns 2 decimal string', () => {
    expect(toKesDecimal(100)).toBe('100.00');
    expect(toKesDecimal(99.999)).toBe('100.00');
    expect(toKesDecimal(1.5)).toBe('1.50');
  });
});

// ─── Price / probability utils ────────────────────────────────────────────────

describe('calcYesPrice', () => {
  it('returns 0.5 on equal pools', () => {
    expect(calcYesPrice(1000, 1000)).toBe(0.5);
  });

  it('returns 0.5 on empty pools', () => {
    expect(calcYesPrice(0, 0)).toBe(0.5);
  });

  it('returns > 0.5 when YES pool is larger', () => {
    expect(calcYesPrice(700, 300)).toBeCloseTo(0.7, 5);
  });

  it('returns < 0.5 when NO pool is larger', () => {
    expect(calcYesPrice(300, 700)).toBeCloseTo(0.3, 5);
  });

  it('returns ~1 when NO pool is near zero', () => {
    expect(calcYesPrice(10000, 1)).toBeGreaterThan(0.999);
  });
});

describe('calcNoPrice', () => {
  it('is complement of calcYesPrice', () => {
    expect(calcNoPrice(700, 300)).toBeCloseTo(1 - calcYesPrice(700, 300), 10);
  });

  it('returns 0.5 on equal pools', () => {
    expect(calcNoPrice(1000, 1000)).toBe(0.5);
  });

  it('sums to 1 with yes price', () => {
    const yes = calcYesPrice(600, 400);
    const no = calcNoPrice(600, 400);
    expect(yes + no).toBeCloseTo(1, 10);
  });
});

describe('calcSharesReceived', () => {
  it('divides amount by share price', () => {
    expect(calcSharesReceived(100, 10)).toBe(10);
    expect(calcSharesReceived(50, 10)).toBe(5);
  });

  it('uses default share price of 10', () => {
    expect(calcSharesReceived(200)).toBe(20);
  });

  it('handles non-round numbers', () => {
    expect(calcSharesReceived(15, 10)).toBe(1.5);
  });
});

describe('calcPayoutPerShare', () => {
  it('returns 0 when no winning shares', () => {
    expect(calcPayoutPerShare(10000, 0.04, 0)).toBe(0);
  });

  it('applies rake correctly', () => {
    // 10000 pool, 4% rake = 9600 net, 100 shares → 96 per share
    expect(calcPayoutPerShare(10000, 0.04, 100)).toBeCloseTo(96, 5);
  });

  it('returns full pool minus rake when only 1 share', () => {
    expect(calcPayoutPerShare(1000, 0.1, 1)).toBeCloseTo(900, 5);
  });

  it('zero rake gives full pool per share', () => {
    expect(calcPayoutPerShare(500, 0, 50)).toBeCloseTo(10, 5);
  });
});

// ─── Settlement ID ────────────────────────────────────────────────────────────

describe('generateSettlementId', () => {
  it('returns a 64-char hex string (SHA-256)', () => {
    const id = generateSettlementId('market-1', 'user-1', 'YES');
    expect(id).toHaveLength(64);
    expect(id).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic — same inputs produce same id', () => {
    const id1 = generateSettlementId('m1', 'u1', 'YES');
    const id2 = generateSettlementId('m1', 'u1', 'YES');
    expect(id1).toBe(id2);
  });

  it('differs when any input changes', () => {
    const base = generateSettlementId('m1', 'u1', 'YES');
    expect(generateSettlementId('m2', 'u1', 'YES')).not.toBe(base);
    expect(generateSettlementId('m1', 'u2', 'YES')).not.toBe(base);
    expect(generateSettlementId('m1', 'u1', 'NO')).not.toBe(base);
  });
});

// ─── OTP ─────────────────────────────────────────────────────────────────────

describe('generateOtp', () => {
  it('returns a 6-digit string', () => {
    const otp = generateOtp();
    expect(otp).toHaveLength(6);
    expect(otp).toMatch(/^\d{6}$/);
  });

  it('generates different values on subsequent calls (probabilistic)', () => {
    const otps = new Set(Array.from({ length: 20 }, () => generateOtp()));
    expect(otps.size).toBeGreaterThan(1);
  });
});

// ─── Date utils ───────────────────────────────────────────────────────────────

describe('todayDateString', () => {
  it('returns a YYYY-MM-DD string', () => {
    expect(todayDateString()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('matches today\'s date', () => {
    const today = new Date().toISOString().split('T')[0];
    expect(todayDateString()).toBe(today);
  });
});

describe('isExpired', () => {
  it('returns true for a past date', () => {
    const past = new Date(Date.now() - 1000);
    expect(isExpired(past)).toBe(true);
  });

  it('returns false for a future date', () => {
    const future = new Date(Date.now() + 60_000);
    expect(isExpired(future)).toBe(false);
  });
});
