/**
 * Shared mutable state passed between ordered test suites.
 * Tests run sequentially (--runInBand) so this is safe.
 */
export const state = {
  // Regular user
  accessToken: '',
  refreshToken: '',
  userId: '',
  phone: '',

  // Second user (for public-profile, admin tests)
  user2AccessToken: '',
  user2Phone: '',
  user2Id: '',

  // Admin user
  adminAccessToken: '',
  adminPhone: '',

  // Created resources
  marketId: '',
  marketSlug: '',
  tradeId: '',
  depositId: '',
  notificationId: '',
};
