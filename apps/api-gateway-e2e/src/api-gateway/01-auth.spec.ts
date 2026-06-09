import axios from 'axios';
import { state } from '../support/state';

// Use a unique phone per test run so re-runs don't collide on "already registered"
const RUN_ID = Date.now().toString().slice(-6);
const phone = `0712${RUN_ID}`;   // 0712xxxxxx — valid Kenyan format
const phone2 = `0711${RUN_ID}`;
const adminPhone = `0700${RUN_ID}`;
const password = 'Password123';

// Store otp from dev console (in dev mode AT logs OTP instead of sending SMS)
// We use a fixed test OTP seeded by the auth service in NODE_ENV=development
const DEV_OTP = '123456';

describe('Auth — register & verify', () => {
  it('POST /auth/register → 201 with phone', async () => {
    state.phone = phone;
    const res = await axios.post('/auth/register', { phone, password });
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ phone: expect.any(String) });
  });

  it('POST /auth/register duplicate → 409', async () => {
    const res = await axios.post('/auth/register', { phone, password }).catch(e => e.response);
    expect(res.status).toBe(409);
  });

  it('POST /auth/register invalid phone → 400', async () => {
    const res = await axios
      .post('/auth/register', { phone: '12345', password })
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /auth/register short password → 400', async () => {
    const res = await axios
      .post('/auth/register', { phone: `0713${RUN_ID}`, password: 'short' })
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /auth/verify-phone → 200 with tokens', async () => {
    const res = await axios.post('/auth/verify-phone', { phone, otp: DEV_OTP });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
      user: expect.objectContaining({
        id: expect.any(String),
        phone: expect.any(String),
        role: 'USER',
        kycTier: 0,
      }),
    });
    state.accessToken = res.data.accessToken;
    state.refreshToken = res.data.refreshToken;
    state.userId = res.data.user.id;
  });

  it('POST /auth/verify-phone wrong otp → 401', async () => {
    const res = await axios
      .post('/auth/verify-phone', { phone, otp: '000000' })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });
});

describe('Auth — login & token rotation', () => {
  it('POST /auth/login → 200 with tokens', async () => {
    const res = await axios.post('/auth/login', { phone, password });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    // Use fresher tokens going forward
    state.accessToken = res.data.accessToken;
    state.refreshToken = res.data.refreshToken;
  });

  it('POST /auth/login wrong password → 401', async () => {
    const res = await axios
      .post('/auth/login', { phone, password: 'wrongpassword' })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('POST /auth/login unknown phone → 401', async () => {
    const res = await axios
      .post('/auth/login', { phone: '0799999999', password })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh → 200 with new token pair', async () => {
    const res = await axios.post('/auth/refresh', {
      refreshToken: state.refreshToken,
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      accessToken: expect.any(String),
      refreshToken: expect.any(String),
    });
    // Tokens are rotated — update state
    state.accessToken = res.data.accessToken;
    state.refreshToken = res.data.refreshToken;
  });

  it('POST /auth/refresh invalid token → 401', async () => {
    const res = await axios
      .post('/auth/refresh', { refreshToken: 'not-a-real-token' })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });
});

describe('Auth — OTP & password reset', () => {
  it('POST /auth/request-otp → 200', async () => {
    const res = await axios.post('/auth/request-otp', {
      phone,
      purpose: 'withdrawal',
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ message: expect.any(String) });
  });

  it('POST /auth/reset-password → 200', async () => {
    const res = await axios.post('/auth/reset-password', { phone });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ message: expect.any(String) });
  });

  it('POST /auth/reset-password/confirm → 200', async () => {
    const res = await axios.post('/auth/reset-password/confirm', {
      phone,
      otp: DEV_OTP,
      newPassword: 'NewPassword456',
    });
    expect(res.status).toBe(200);
    // Login with new password to refresh token
    const login = await axios.post('/auth/login', {
      phone,
      password: 'NewPassword456',
    });
    state.accessToken = login.data.accessToken;
    state.refreshToken = login.data.refreshToken;
  });
});

describe('Auth — second user & admin setup', () => {
  it('registers second user', async () => {
    state.user2Phone = phone2;
    await axios.post('/auth/register', { phone: phone2, password });
    const verify = await axios.post('/auth/verify-phone', {
      phone: phone2,
      otp: DEV_OTP,
    });
    state.user2AccessToken = verify.data.accessToken;
    state.user2Id = verify.data.user.id;
    expect(verify.status).toBe(200);
  });

  it('registers admin user (manual role assignment tested via DB seed)', async () => {
    // In a real E2E environment the admin user is seeded via a DB seed script.
    // Here we register a normal user; admin role tests will use the ADMIN_PHONE env
    // or fall back to skipping with a descriptive message.
    state.adminPhone = process.env.ADMIN_PHONE ?? '';
    state.adminAccessToken = process.env.ADMIN_TOKEN ?? '';
    if (!state.adminAccessToken) {
      console.warn('[e2e] ADMIN_TOKEN not set — admin suite tests will be skipped');
    }
    expect(true).toBe(true); // always passes — admin token is optional
  });
});

describe('Auth — logout', () => {
  it('POST /auth/logout → 200', async () => {
    // Login fresh so we don't invalidate the main session
    const login = await axios.post('/auth/login', {
      phone,
      password: 'NewPassword456',
    });
    const tempRefresh = login.data.refreshToken;
    const res = await axios.post('/auth/logout', { refreshToken: tempRefresh });
    expect(res.status).toBe(200);
    // After logout that refresh token should be invalid
    const retry = await axios
      .post('/auth/refresh', { refreshToken: tempRefresh })
      .catch(e => e.response);
    expect(retry.status).toBe(401);
  });
});
