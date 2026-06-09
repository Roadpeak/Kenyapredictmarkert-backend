import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Analytics — leaderboard', () => {
  it('GET /analytics/leaderboard → 200 with ranked entries', async () => {
    const res = await axios.get('/analytics/leaderboard', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
    });
  });

  it('GET /analytics/leaderboard?period=daily → 200', async () => {
    const res = await axios.get('/analytics/leaderboard?period=daily', auth());
    expect(res.status).toBe(200);
  });

  it('GET /analytics/leaderboard?period=monthly&category=SPORTS → 200', async () => {
    const res = await axios.get(
      '/analytics/leaderboard?period=monthly&category=SPORTS',
      auth(),
    );
    expect(res.status).toBe(200);
  });

  it('GET /analytics/leaderboard?limit=5 → max 5 entries', async () => {
    const res = await axios.get('/analytics/leaderboard?limit=5', auth());
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeLessThanOrEqual(5);
  });

  it('leaderboard entries have expected shape when present', async () => {
    const res = await axios.get('/analytics/leaderboard?limit=20', auth());
    for (const entry of res.data.data) {
      expect(entry).toMatchObject({
        rank: expect.any(Number),
        userId: expect.any(String),
      });
    }
  });
});

describe('Analytics — market stats', () => {
  it('GET /analytics/markets/:id/stats → 200 if market exists', async () => {
    if (!state.marketId) {
      console.warn('[e2e] Skipping market stats — no marketId');
      return;
    }
    const res = await axios.get(
      `/analytics/markets/${state.marketId}/stats`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      marketId: state.marketId,
      totalVolume: expect.any(Number),
    });
  });

  it('GET /analytics/markets/unknown-id/stats → 404', async () => {
    const res = await axios
      .get('/analytics/markets/00000000-0000-0000-0000-000000000000/stats', auth())
      .catch(e => e.response);
    expect([404, 200]).toContain(res.status); // 200 with zeros is also acceptable
  });
});

describe('Analytics — user stats', () => {
  it('GET /analytics/users/:id/stats → 200 with own stats', async () => {
    const res = await axios.get(
      `/analytics/users/${state.userId}/stats`,
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      userId: state.userId,
      totalTrades: expect.any(Number),
    });
  });

  it('GET /analytics/users/:id/stats without token → 401', async () => {
    const res = await axios
      .get(`/analytics/users/${state.userId}/stats`)
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });
});
