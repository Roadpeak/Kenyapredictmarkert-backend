# M-Pesa Production Cutover

The integration (STK Push deposits, B2C withdrawals, callbacks) is code-complete
and covered by tests. Going live is purely a matter of the credentials below —
nothing else needs to change.

## What devops needs to send back

Ten values. Everything else in `.env.example`'s M-Pesa block either has a
sensible default or is derived automatically.

| # | Variable | Where to get it |
|---|---|---|
| 1 | `MPESA_ENVIRONMENT` | Set to `production` |
| 2 | `MPESA_CONSUMER_KEY` | developer.safaricom.co.ke → your production app → Keys |
| 3 | `MPESA_CONSUMER_SECRET` | Same app, next to the consumer key |
| 4 | `MPESA_SHORT_CODE` | Your paybill/till number, issued by Safaricom for the production account |
| 5 | `MPESA_PASSKEY` | developer.safaricom.co.ke → Lipa Na M-Pesa Online → Passkey (production, not the sandbox one in `.env.example`) |
| 6 | `MPESA_B2C_INITIATOR_NAME` | The API operator username created for B2C (Org portal → API Operators) |
| 7 | `MPESA_B2C_INITIATOR_PASSWORD` | That operator's password — plaintext, see below for why |
| 8 | `MPESA_B2C_CERTIFICATE` | Safaricom's **production** public cert — see below |
| 9 | `MPESA_CALLBACK_BASE_URL` | The public HTTPS URL of the API gateway, e.g. `https://api.yourdomain.com` |
| 10 | `INTERNAL_API_KEY` | Not M-Pesa-specific, but generate a real random value for prod if not already done — every service-to-service call depends on it |

## Why #7 + #8, not a single "security credential"

Daraja's B2C API doesn't take the initiator's password directly. It wants
`SecurityCredential` — the password **RSA-encrypted with Safaricom's public
certificate**, base64-encoded. That's not something you can type in; it has to
be computed, and the certificate differs between sandbox and production.

Rather than asking devops to run that computation externally (easy to get
wrong, and silently breaks if the cert rotates), the app does it at call time.
Give it the two real inputs — the plaintext password Safaricom issued, and the
certificate Safaricom publishes:

```bash
# Certificate download, from developer.safaricom.co.ke → Daraja API →
# Security Credential → download the cert for the environment you're
# configuring (sandbox and production are different files).
#
# If Safaricom gives you a .cer (binary DER), convert it first:
openssl x509 -in ProductionCertificate.cer -inform DER -out cert.pem

# Then flatten cert.pem into one line with \n for the newlines — same
# escaping the JWT_PUBLIC_KEY / JWT_PRIVATE_KEY vars already use:
awk 'NF {sub(/\r/, ""); printf "%s\\n",$0;}' cert.pem
```

Paste that output as `MPESA_B2C_CERTIFICATE`. It is Safaricom's **public**
certificate — not secret, safe to store like any other config, and it's the
same file for every deployment in that environment.

(If you already have a precomputed `SecurityCredential` from another tool,
setting `MPESA_B2C_SECURITY_CREDENTIAL` directly skips this derivation
entirely — but the initiator-password + certificate path above is the one to
use; it's what the app is built for and doesn't need re-deriving if the
initiator password ever changes.)

## Callback URL — one value drives three endpoints

`MPESA_CALLBACK_BASE_URL` must be the **API gateway's** public URL, not
payment-service directly — the gateway is what's internet-facing; it routes
`/api/callbacks/mpesa/*` to payment-service internally. The app derives all
three callback paths from this one base:

```
{MPESA_CALLBACK_BASE_URL}/api/callbacks/mpesa/stk
{MPESA_CALLBACK_BASE_URL}/api/callbacks/mpesa/b2c/result
{MPESA_CALLBACK_BASE_URL}/api/callbacks/mpesa/b2c/timeout
```

It must be reachable over HTTPS from Safaricom's servers before you register
production URLs with Safaricom — they will not accept HTTP or an unreachable
host.

## Callback security — IP allowlisting

Callback endpoints only accept requests from Safaricom's published IPs, and
only when `NODE_ENV=production` (in dev/staging the check is skipped so local
testing with ngrok doesn't need spoofing). The current list is hardcoded as a
sane default; if Safaricom updates it, set `MPESA_CALLBACK_IPS` (comma-
separated) to override without a redeploy.

This depends on the reverse proxy chain preserving the real client IP end to
end — confirmed working in this stack (nginx → api-gateway → payment-service,
each hop trusting exactly one upstream), but if the production topology adds
another proxy layer (e.g. a cloud load balancer in front of nginx), that
layer needs to be added to the trust chain too, or every real callback will
be rejected as unauthorized.

## What's already handled, so you don't need to worry about it

- **STK success is verified independently** via `QuerySTKPush` before any
  wallet is credited — a spoofed callback claiming success can't credit funds
  on its own.
- **Callbacks are idempotent.** A duplicate delivery (Safaricom retries on
  non-200 or timeout) is detected and skipped, not double-processed.
- **B2C failures release the wallet reserve.** If a withdrawal fails at any
  point — OTP, daily limit, the B2C call itself, or Safaricom's result
  callback reporting failure — the reserved amount returns to the user's
  available balance. Verified end-to-end against the running stack, including
  the case where the M-Pesa call itself throws.
- **B2C timeouts retry once** before failing and releasing funds.
- **Daily limits are enforced by KYC tier** (deposit: 50k/150k/300k,
  withdrawal: 0/70k/150k for tiers 0/1/2) before any M-Pesa call is made.
- **Every raw callback payload is stored** (`payment_callbacks` table) —
  nothing Safaricom sends is ever discarded, even for unmatched or duplicate
  callbacks.

## Verifying it after credentials land

```bash
# 1. Login and confirm STK push actually reaches Safaricom (should return
#    a real CheckoutRequestID, not the "Failed to authenticate" error you'll
#    see with placeholder credentials):
curl -X POST https://api.yourdomain.com/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"phone":"<test-number>","password":"<test-password>"}'

curl -X POST https://api.yourdomain.com/api/payments/deposits/initiate \
  -H "Authorization: Bearer <token>" -H 'Content-Type: application/json' \
  -d '{"amountKes":10,"phone":"<test-number>"}'

# 2. Confirm the STK prompt actually arrives on the test phone, and that
#    completing it lands as COMPLETED:
curl https://api.yourdomain.com/api/payments/deposits/<paymentId>/status \
  -H "Authorization: Bearer <token>"

# 3. For B2C, a real test-mode withdrawal (small amount) through the same
#    flow, checking apps/payment-service logs for "B2C initiated" and then
#    the result callback landing.
```

If STK push responds with `"Failed to authenticate with M-Pesa"`, the
consumer key/secret pair is wrong for the environment (sandbox key against
`MPESA_ENVIRONMENT=production`, or vice versa, is the most common cause).

If B2C responds with `"Failed to initiate M-Pesa withdrawal"` specifically
(not the auth error above), check `MPESA_B2C_CERTIFICATE` — a malformed or
mismatched-environment cert fails at the encryption step with a clear log
line (`Failed to encrypt B2C security credential: ...`) rather than a silent
wrong value.
