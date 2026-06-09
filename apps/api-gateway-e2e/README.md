# PredictMarket E2E Tests

End-to-end tests for the full PredictMarket API, running through the api-gateway on `localhost:3000`.

## Structure

```
apps/api-gateway-e2e/src/
  api-gateway/
    01-auth.spec.ts          Auth: register, verify, login, refresh, logout, OTP, password reset
    02-users.spec.ts         Users: profile CRUD, KYC submit, referrals, public profile
    03-markets.spec.ts       Markets: list, categories, get by id/slug, price history, admin CRUD
    04-trades.spec.ts        Trades: place trade, history, positions, public market trades
    05-wallet.spec.ts        Wallet: balance, ledger
    06-payments.spec.ts      Payments: deposit initiate/status/history, withdrawal, callbacks
    07-notifications.spec.ts Notifications: list, mark read, device token
    08-feed.spec.ts          Feed: activity, discovery
    09-analytics.spec.ts     Analytics: leaderboard, market stats, user stats
    10-admin.spec.ts         Admin: market CRUD, KYC approve/reject, user suspend/unsuspend
  support/
    state.ts                 Shared mutable state (tokens, IDs) across ordered suites
    global-setup.ts          Wait for gateway port before tests start
    global-teardown.ts       No-op — does NOT kill the gateway (managed externally)
    test-setup.ts            Configures axios baseURL
```

## Prerequisites

1. All services running: `pnpm dev` (or `pnpm setup` first if starting fresh)
2. Postgres, Redis, Kafka running: `pnpm infra:up`
3. `.env` configured (run `pnpm setup` to generate it)

## Running

```bash
# Run all E2E tests (services must already be running)
pnpm e2e

# Watch mode (re-runs on file change)
pnpm e2e:watch

# Run a single suite
pnpm exec jest --config apps/api-gateway-e2e/jest.config.cts --runInBand --testPathPattern=01-auth

# Run with coverage
pnpm exec jest --config apps/api-gateway-e2e/jest.config.cts --runInBand --coverage
```

## Admin tests

Admin-gated tests require an ADMIN-role JWT. To seed an admin user and get a token:

```bash
# 1. Seed admin user into auth DB
pnpm exec ts-node -P tsconfig.base.json scripts/seed-admin.ts

# 2. Login to get token
curl -s -X POST http://localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"0700000001","password":"AdminPass123"}' | jq -r .accessToken

# 3. Export for E2E run
export ADMIN_PHONE=0700000001
export ADMIN_TOKEN=<paste token here>
pnpm e2e
```

Without `ADMIN_TOKEN`, admin-gated tests are skipped with a warning — all other tests still run.

## Environment variables

| Variable      | Default     | Description                          |
|---------------|-------------|--------------------------------------|
| `HOST`        | `localhost` | Gateway host                         |
| `PORT`        | `3000`      | Gateway port                         |
| `ADMIN_PHONE` | —           | Phone of seeded admin user           |
| `ADMIN_TOKEN` | —           | JWT access token for admin user      |

## Test design notes

- **Sequential**: suites run in filename order (`--runInBand`). State from `01-auth` (tokens, userId) flows into `02-users`, etc.
- **Idempotent phone**: each run generates a unique phone suffix from `Date.now()`, so re-runs don't collide on "already registered".
- **Dev OTP**: in `NODE_ENV=development` the auth service accepts OTP `123456` — no real SMS needed.
- **No port kill on teardown**: gateway is kept alive; test runner exits cleanly after all suites.
- **Soft admin skip**: tests that require `ADMIN_TOKEN` log a warning and pass when the token is absent, so CI without admin seeding still produces a green run on the non-admin suites.
