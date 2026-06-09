import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Wallet — balance & ledger', () => {
  it('GET /wallet/me → 200 with balance fields', async () => {
    const res = await axios.get('/wallet/me', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      userId: state.userId,
      balanceKes: expect.any(Number),
      reservedKes: expect.any(Number),
      availableKes: expect.any(Number),
    });
    expect(res.data.availableKes).toBe(
      res.data.balanceKes - res.data.reservedKes,
    );
  });

  it('GET /wallet/me without token → 401', async () => {
    const res = await axios.get('/wallet/me').catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('GET /wallet/me/ledger → 200 with paginated entries', async () => {
    const res = await axios.get('/wallet/me/ledger', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
    });
  });

  it('GET /wallet/me/ledger?limit=5 → max 5 entries', async () => {
    const res = await axios.get('/wallet/me/ledger?limit=5', auth());
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeLessThanOrEqual(5);
  });

  it('ledger entries have expected shape', async () => {
    const res = await axios.get('/wallet/me/ledger?limit=10', auth());
    for (const entry of res.data.data) {
      expect(entry).toMatchObject({
        id: expect.any(String),
        type: expect.any(String),
        amountKes: expect.any(Number),
        balanceAfter: expect.any(Number),
        createdAt: expect.any(String),
      });
    }
  });
});
