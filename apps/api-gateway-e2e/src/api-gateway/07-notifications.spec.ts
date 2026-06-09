import axios from 'axios';
import { state } from '../support/state';

function auth() {
  return { headers: { Authorization: `Bearer ${state.accessToken}` } };
}

describe('Notifications', () => {
  it('GET /notifications without token → 401', async () => {
    const res = await axios.get('/notifications').catch(e => e.response);
    expect(res.status).toBe(401);
  });

  it('GET /notifications → 200 with paginated list', async () => {
    const res = await axios.get('/notifications', auth());
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({
      data: expect.any(Array),
      total: expect.any(Number),
    });
  });

  it('GET /notifications?limit=5 → max 5 results', async () => {
    const res = await axios.get('/notifications?limit=5', auth());
    expect(res.status).toBe(200);
    expect(res.data.data.length).toBeLessThanOrEqual(5);
  });

  it('notification entries have expected shape when present', async () => {
    const res = await axios.get('/notifications?limit=20', auth());
    for (const n of res.data.data) {
      expect(n).toMatchObject({
        id: expect.any(String),
        type: expect.any(String),
        isRead: expect.any(Boolean),
        createdAt: expect.any(String),
      });
      state.notificationId = state.notificationId || n.id;
    }
  });

  it('PATCH /notifications/:id/read → 204 if notification exists', async () => {
    if (!state.notificationId) {
      console.warn('[e2e] No notifications to mark read — skipping');
      return;
    }
    const res = await axios.patch(
      `/notifications/${state.notificationId}/read`,
      {},
      auth(),
    );
    expect(res.status).toBe(204);
  });

  it('PATCH /notifications/read-all → 204', async () => {
    const res = await axios.patch('/notifications/read-all', {}, auth());
    expect(res.status).toBe(204);
  });

  it('GET /notifications after read-all → unreadCount is 0', async () => {
    const res = await axios.get('/notifications', auth());
    expect(res.status).toBe(200);
    // All should now be read
    const unread = res.data.data.filter((n: any) => !n.isRead);
    expect(unread).toHaveLength(0);
  });

  it('POST /notifications/device-tokens → 204', async () => {
    const res = await axios.post(
      '/notifications/device-tokens',
      {
        token: `fcm-test-token-${Date.now()}`,
        platform: 'android',
      },
      auth(),
    );
    expect(res.status).toBe(204);
  });

  it('POST /notifications/device-tokens invalid platform → 400', async () => {
    const res = await axios
      .post(
        '/notifications/device-tokens',
        { token: 'some-token', platform: '' },
        auth(),
      )
      .catch(e => e.response);
    expect(res.status).toBe(400);
  });
});
