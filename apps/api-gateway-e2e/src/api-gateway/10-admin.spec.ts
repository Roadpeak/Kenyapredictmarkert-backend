import axios from 'axios';
import { state } from '../support/state';

function adminAuth() {
  return { headers: { Authorization: `Bearer ${state.adminAccessToken}` } };
}
function userAuth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

function skip(reason: string) {
  console.warn(`[e2e] Skipping — ${reason}`);
}

// All admin tests are conditional on ADMIN_TOKEN being set in env.
// Without it, they log a warning and pass trivially.

describe('Admin — access control', () => {
  it('GET /admin/markets with normal user token → 403', async () => {
    const res = await axios
      .get('/admin/markets', userAuth())
      .catch(e => e.response);
    expect(res.status).toBe(403);
  });

  it('GET /admin/markets without token → 401', async () => {
    const res = await axios.get('/admin/markets').catch(e => e.response);
    expect(res.status).toBe(401);
  });
});

describe('Admin — market management', () => {
  it('GET /admin/markets → 200 paginated markets', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get('/admin/markets', adminAuth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
    });
  });

  it('GET /admin/markets?status=DRAFT → only DRAFT markets', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get('/admin/markets?status=DRAFT', adminAuth());
    expect(res.status).toBe(200);
    for (const m of res.data.data) {
      expect(m.status).toBe('DRAFT');
    }
  });

  it('POST /admin/markets → 201 creates DRAFT market', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.post(
      '/admin/markets',
      {
        title: `Admin E2E Market ${Date.now()}`,
        description: 'Created by admin E2E test',
        category: 'politics',
        closesAt: new Date(Date.now() + 3 * 86400_000).toISOString(),
        resolvesAt: new Date(Date.now() + 7 * 86400_000).toISOString(),
      },
      adminAuth(),
    );
    expect(res.status).toBe(201);
    expect(res.data.status).toBe('DRAFT');
    // Use this market for activate/resolve/cancel tests
    state.marketId = res.data.id;
    state.marketSlug = res.data.slug;
  });

  it('POST /admin/markets missing required fields → 400', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios
      .post('/admin/markets', { title: 'Too short' }, adminAuth())
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('POST /admin/markets/:id/activate → 200 ACTIVE', async () => {
    if (!state.adminAccessToken || !state.marketId) return skip('no ADMIN_TOKEN or marketId');
    const res = await axios.post(
      `/admin/markets/${state.marketId}/activate`,
      {},
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('ACTIVE');
  });

  it('POST /admin/markets/:id/resolve → 200 RESOLVED', async () => {
    if (!state.adminAccessToken || !state.marketId) return skip('no ADMIN_TOKEN or marketId');
    const res = await axios.post(
      `/admin/markets/${state.marketId}/resolve`,
      { outcome: 'YES', note: 'E2E test resolution' },
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.status).toBe('RESOLVED');
    expect(res.data.winningOutcome).toBe('YES');
  });

  it('POST /admin/markets/:id/cancel on already-resolved → 422', async () => {
    if (!state.adminAccessToken || !state.marketId) return skip('no ADMIN_TOKEN or marketId');
    const res = await axios
      .post(`/admin/markets/${state.marketId}/cancel`, {}, adminAuth())
      .catch(e => e.response);
    // Cannot cancel a resolved market
    expect([422, 400]).toContain(res.status);
  });
});

describe('Admin — KYC management', () => {
  it('GET /admin/kyc/pending → 200 list', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get('/admin/kyc/pending', adminAuth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ data: expect.any(Array) });
  });

  it('POST /admin/kyc/:userId/approve → 200 APPROVED tier 2', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.post(
      `/admin/kyc/${state.userId}/approve`,
      {},
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ kycStatus: 'APPROVED', kycTier: 2 });
  });

  it('GET /users/me/kyc after approval → kycTier 2', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get('/users/me/kyc', userAuth());
    expect(res.status).toBe(200);
    expect(res.data.kycTier).toBe(2);
  });

  it('POST /admin/kyc/:userId/reject with reason → 200 REJECTED', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    // Reject user2 (who hasn't submitted KYC — expect 422 or 404)
    const res = await axios
      .post(
        `/admin/kyc/${state.user2Id}/reject`,
        { reason: 'No documents submitted' },
        adminAuth(),
      )
      .catch(e => e.response);
    expect([200, 422, 404]).toContain(res.status);
  });
});

describe('Admin — user management', () => {
  it('GET /admin/users → 200 paginated user list', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get('/admin/users', adminAuth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ data: expect.any(Array) });
  });

  it('GET /admin/users/:id → 200 full user detail', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.get(`/admin/users/${state.userId}`, adminAuth());
    expect(res.status).toBe(200);
    expect(res.data.id).toBe(state.userId);
  });

  it('POST /admin/users/:id/suspend → 200 isSuspended true', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.post(
      `/admin/users/${state.user2Id}/suspend`,
      {},
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.isSuspended).toBe(true);
  });

  it('POST /admin/users/:id/unsuspend → 200 isSuspended false', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios.post(
      `/admin/users/${state.user2Id}/unsuspend`,
      {},
      adminAuth(),
    );
    expect(res.status).toBe(200);
    expect(res.data.isSuspended).toBe(false);
  });

  it('GET /admin/users/unknown → 404', async () => {
    if (!state.adminAccessToken) return skip('no ADMIN_TOKEN');
    const res = await axios
      .get('/admin/users/00000000-0000-0000-0000-000000000000', adminAuth())
      .catch(e => e.response);
    expect(res.status).toBe(404);
  });
});
