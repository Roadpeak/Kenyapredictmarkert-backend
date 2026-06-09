import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Feed', () => {
  it('GET /feed/discovery → 200 (public, no auth required)', async () => {
    const res = await axios.get('/feed/discovery');
    expect(res.status).toBe(200);
    // May return data or empty array — both are valid
    expect(res.data).toBeDefined();
  });

  it('GET /feed/discovery?limit=5 → max 5 results', async () => {
    const res = await axios.get('/feed/discovery?limit=5');
    expect(res.status).toBe(200);
    if (res.data.data) {
      expect(res.data.data.length).toBeLessThanOrEqual(5);
    }
  });

  it('GET /feed/activity without token → 401', async () => {
    const res = await axios.get('/feed/activity').catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('GET /feed/activity → 200 with activity entries', async () => {
    const res = await axios.get('/feed/activity', auth());
    expect(res.status).toBe(200);
    expect(res.data).toBeDefined();
  });

  it('GET /feed/activity?limit=10&page=1 → paginated', async () => {
    const res = await axios.get('/feed/activity?limit=10&page=1', auth());
    expect(res.status).toBe(200);
    if (Array.isArray(res.data.data)) {
      expect(res.data.data.length).toBeLessThanOrEqual(10);
    }
  });
});
