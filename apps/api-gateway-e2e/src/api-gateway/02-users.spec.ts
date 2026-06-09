import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Users — own profile', () => {
  it('GET /users/me → 200 with profile', async () => {
    const res = await axios.get('/users/me', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      id: state.userId,
      role: 'USER',
      kycTier: 0,
    });
  });

  it('GET /users/me without token → 401', async () => {
    const res = await axios.get('/users/me').catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('PUT /users/me → 200 with updated profile', async () => {
    const res = await axios.put(
      '/users/me',
      { displayName: 'E2E Trader', bio: 'Automated test account' },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      displayName: 'E2E Trader',
      bio: 'Automated test account',
    });
  });

  it('PUT /users/me partial update (only displayName) → 200', async () => {
    const res = await axios.put('/users/me', { displayName: 'E2E Pro' }, auth());
    expect(res.status).toBe(200);
    expect(res.data.displayName).toBe('E2E Pro');
  });
});

describe('Users — KYC', () => {
  it('GET /users/me/kyc → 200 with tier 0 status', async () => {
    const res = await axios.get('/users/me/kyc', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      kycTier: 0,
      kycStatus: 'NONE',
    });
  });

  it('POST /users/me/kyc/start → 200 sets ID_SUBMITTED', async () => {
    const res = await axios.post(
      '/users/me/kyc/start',
      {
        docType: 'NATIONAL_ID',
        docNumber: '12345678',
        frontUrl: 'https://cdn.example.com/id-front.jpg',
        backUrl: 'https://cdn.example.com/id-back.jpg',
        selfieUrl: 'https://cdn.example.com/selfie.jpg',
      },
      auth(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ kycStatus: 'ID_SUBMITTED', kycTier: 1 });
  });

  it('GET /users/me/kyc after submit → kycStatus ID_SUBMITTED', async () => {
    const res = await axios.get('/users/me/kyc', auth());
    expect(res.status).toBe(200);
    expect(res.data.kycStatus).toBe('ID_SUBMITTED');
  });
});

describe('Users — referrals', () => {
  it('GET /users/me/referrals → 200 with referral code', async () => {
    const res = await axios.get('/users/me/referrals', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      referralCode: expect.any(String),
      totalReferrals: expect.any(Number),
    });
  });
});

describe('Users — public profile', () => {
  it('GET /users/:id/profile → 200 without auth', async () => {
    const res = await axios.get(`/users/${state.userId}/profile`);
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      id: state.userId,
      displayName: expect.any(String),
    });
    // Phone should NOT be in public profile
    expect(res.data.phone).toBeUndefined();
  });

  it('GET /users/unknown-id/profile → 404', async () => {
    const res = await axios
      .get('/users/00000000-0000-0000-0000-000000000000/profile')
      .catch(e => e.response);
    expect(res.status).toBe(404);
  });
});
