import axios from 'axios';
import { state } from '../support/state';

function adminAuth() {
  return { headers: { Authorization: `Bearer ${state.adminAccessToken}` } };
}

// ── Public market endpoints ────────────────────────────────────────────────────

describe('Markets — public listing', () => {
  it('GET /markets → 200 paginated list', async () => {
    const res = await axios.get('/markets');
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
      page: expect.any(Number),
      limit: expect.any(Number),
    });
  });

  it('GET /markets?status=ACTIVE → only ACTIVE markets', async () => {
    const res = await axios.get('/markets?status=ACTIVE');
    expect(res.status).toBe(200);
    const nonActive = res.data.data.filter((m: any) => m.status !== 'ACTIVE');
    expect(nonActive).toHaveLength(0);
  });

  it('GET /markets?limit=5 → max 5 results', async () => {
    const res = await axios.get('/markets?limit=5');
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeLessThanOrEqual(5);
  });

  it('GET /markets/categories → 200 with category list', async () => {
    const res = await axios.get('/markets/categories');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});

// ── Admin creates a market for subsequent tests ────────────────────────────────

describe('Markets — admin create', () => {
  it('POST /admin/markets without token → 401', async () => {
    const res = await axios
      .post('/admin/markets', {
        title: 'Will KES/USD exceed 130 by Dec 2025?',
        description: 'E2E test market',
        category: 'forex',
        closesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        resolvesAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
      })
      .catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('POST /admin/markets with admin token → 201 DRAFT market', async () => {
    if (!state.adminAccessToken) {
      console.warn('[e2e] Skipping — no ADMIN_TOKEN');
      return;
    }
    const res = await axios.post(
      '/admin/markets',
      {
        title: `E2E Market ${Date.now()}`,
        description: 'Created by automated E2E test',
        category: 'sports',
        closesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
        resolvesAt: new Date(Date.now() + 14 * 86400_000).toISOString(),
        tags: ['e2e', 'test'],
      },
      adminAuth(),
    );
    expect(res.status).toBe(201);
    expect(res.data).toMatchObject({ status: 'DRAFT' });
    state.marketId = res.data.id;
    state.marketSlug = res.data.slug;
  });

  it('PUT /admin/markets/:id/activate → 200 ACTIVE', async () => {
    if (!state.adminAccessToken || !state.marketId) return;
    const res = await axios.put(
      `/admin/markets/${state.marketId}/activate`,
      {},
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ status: 'ACTIVE' });
  });
});

// ── Public get by id/slug (needs a market to exist) ───────────────────────────

describe('Markets — get by id / slug', () => {
  it('GET /markets/:id → 200 if market exists', async () => {
    if (!state.marketId) {
      // Fallback: grab first market from list
      const list = await axios.get('/markets?limit=1');
      if (!list.data.data.length) return; // no markets seeded, skip
      state.marketId = list.data.data[0].id;
      state.marketSlug = list.data.data[0].slug;
    }
    const res = await axios.get(`/markets/${state.marketId}`);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(state.marketId);
  });

  it('GET /markets/:slug → 200 same market by slug', async () => {
    if (!state.marketSlug) return;
    const res = await axios.get(`/markets/${state.marketSlug}`);
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(state.marketId);
  });

  it('GET /markets/nonexistent-slug-xyz → 404', async () => {
    const res = await axios
      .get('/markets/nonexistent-slug-xyz-e2e')
      .catch(e => e.response);
    expect(res.status).toBe(404);
  });

  it('GET /markets/:id/history → 200 array', async () => {
    if (!state.marketId) return;
    const res = await axios.get(`/markets/${state.marketId}/history?hours=24`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data)).toBe(true);
  });
});
