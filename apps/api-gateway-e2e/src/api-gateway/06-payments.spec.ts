import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Payments — deposits', () => {
  it('POST /payments/deposits/initiate without token → 401', async () => {
    const res = await axios
      .post('/payments/deposits/initiate', { amountKes: 100, phone: '0712345678' })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('POST /payments/deposits/initiate below minimum → 400', async () => {
    const res = await axios
      .post('/payments/deposits/initiate', { amountKes: 5, phone: state.phone }, auth())
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /payments/deposits/initiate invalid phone → 400', async () => {
    const res = await axios
      .post(
        '/payments/deposits/initiate',
        { amountKes: 100, phone: 'not-a-phone' },
        auth(),
      )
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /payments/deposits/initiate valid → 200 PENDING', async () => {
    // In sandbox/dev this triggers a mock STK push — will return PENDING
    const res = await axios.post(
      '/payments/deposits/initiate',
      { amountKes: 500, phone: state.phone || '0712345678' },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      paymentId: expect.any(String),
      status: 'PENDING',
    });
    state.depositId = res.data.paymentId;
  });

  it('GET /payments/deposits/:id/status → 200', async () => {
    if (!state.depositId) return;
    const res = await axios.get(
      `/payments/deposits/${state.depositId}/status`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      paymentId: state.depositId,
      status: expect.stringMatching(/^(PENDING|COMPLETED|FAILED|CANCELLED)$/),
    });
  });

  it('GET /payments/deposits/:id/status for another user → 404', async () => {
    if (!state.depositId || !state.user2AccessToken) return;
    const res = await axios
      .get(`/payments/deposits/${state.depositId}/status`, {
        headers: { Authorization: `Bearer ${state.user2AccessToken}` },
      })
      .catch(e => e.response);
    expect(res.status).toBe(404);
  });

  it('GET /payments/deposits → 200 paginated history', async () => {
    const res = await axios.get('/payments/deposits', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('Payments — withdrawals', () => {
  it('POST /payments/withdrawals/initiate without token → 401', async () => {
    const res = await axios
      .post('/payments/withdrawals/initiate', {
        amountKes: 200,
        phone: '0712345678',
        otp: '123456',
      })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('POST /payments/withdrawals/initiate below minimum → 400', async () => {
    const res = await axios
      .post(
        '/payments/withdrawals/initiate',
        { amountKes: 50, phone: state.phone || '0712345678', otp: '123456' },
        auth(),
      )
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /payments/withdrawals/initiate tier-0 user → 403', async () => {
    // user2 is still tier 0 (only KYC started for main user)
    if (!state.user2AccessToken) return;
    const res = await axios
      .post(
        '/payments/withdrawals/initiate',
        { amountKes: 200, phone: state.user2Phone || '0712345678', otp: '123456' },
        { headers: { Authorization: `Bearer ${state.user2AccessToken}` } },
      )
      .catch(e => e.response);
    // tier-0 cannot withdraw — expect 403 or 422
    expect([403, 422]).toContain(res.status);
  });

  it('GET /payments/withdrawals → 200 paginated history', async () => {
    const res = await axios.get('/payments/withdrawals', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
    });
  });
});

describe('Payments — M-Pesa callbacks (internal, IP-whitelisted)', () => {
  // Callbacks are Safaricom→server only and IP-whitelisted in production.
  // In dev mode IP check is skipped, so we can test the endpoints accept the shape.

  it('POST /callbacks/mpesa/stk → accepts Safaricom STK callback shape', async () => {
    const body = {
      Body: {
        stkCallback: {
          MerchantRequestID: 'test-merchant-id',
          CheckoutRequestID: 'test-checkout-id',
          ResultCode: 0,
          ResultDesc: 'The service request is processed successfully.',
          CallbackMetadata: {
            Item: [
              { Name: 'Amount', Value: 500 },
              { Name: 'MpesaReceiptNumber', Value: 'QDJ8TEST123' },
              { Name: 'PhoneNumber', Value: 254712345678 },
            ],
          },
        },
      },
    };
    // This may return 200 or 404/422 depending on whether the checkout ID is known
    const res = await axios
      .post('/callbacks/mpesa/stk', body)
      .catch(e => e.response);
    // We just verify it doesn't 500 and accepts the shape
    expect(res.status).not.toBe(500);
  });
});
