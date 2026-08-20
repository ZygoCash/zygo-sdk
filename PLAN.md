# Zygo SDK — Production Plan

TypeScript SDK for third-party integration of Zygo QR payments
(api.zygo.cash · zygo.cash). Design informed by `@p2pdotme/sdk` (P2P.me),
adapted for Zygo's backend-orchestrated model (theirs is contract-first;
ours is API-first with a single on-chain deposit step into the Solana
escrow program).

## Foundation already in the monorepo (reuse)

| Existing | SDK role |
|---|---|
| `backend/internal/apikeys` + `POST/GET/DELETE /v1/api-clients` | key issuance/revoke, scopes, `zygo_c_…`/`zygo_s_…` credentials, SHA-256 at rest, secret shown once |
| `X-Api-Key` auth + `requireScope` on quote/order creation | gated write access |
| Valkey `rateLimit` middleware | base for per-key limits |
| `webhooks` service | partner notifications |
| `ProfileMenu` (apps/web) | developer-mode UI home |

## Package shape (P2P.me patterns adopted)

Single package, subpath exports; framework-agnostic core; optional React
subpath; neverthrow `Result`/`ResultAsync` everywhere (no thrown
exceptions); `prepare`/`execute` split for anything that signs; consumer
brings their own signer (SDK never touches keys).

```
@zygopay/sdk            → config, ZygoError, VERSION
@zygopay/sdk/merchants  → resolveQr (UPI now; QRIS/PIX/MercadoPago slot in here)
@zygopay/sdk/quotes     → create, get
@zygopay/sdk/orders     → create, get, timeline, waitFor(state)
@zygopay/sdk/payments   → deposit instructions; prepare/execute with consumer signer
@zygopay/sdk/webhooks   → HMAC verify + event types
@zygopay/sdk/react      → ZygoProvider + hooks (P1)
```

Explicitly rejected from P2P.me's design: viem/contract-first core,
subgraph reads, relay identity — artifacts of their on-chain settlement.

## Security

- Secret keys are server-side only; SDK throws when `window` exists.
- Per-key rate limits (Valkey, identity = client_id, IP fallback):
  60 rpm reads / 10 rpm writes; `429 + Retry-After`; SDK honors both.
- Daily ceiling per key (10k calls), 80% soft-warn header.
- Abuse tripwires: repeated 401s per IP → temp ban; revoked-key usage alerts owner.
- Scopes least-privilege: new keys default to `read`; writes opt-in.
- Webhooks: per-client signing secret, HMAC-SHA256 over raw body,
  `Zygo-Signature` + timestamp, 5-minute tolerance; `webhooks.verify()` helper.
- Optional: live keys gated on Didit KYC verification.

## Developer UX (zygo.cash → Profile → Developer mode)

Toggle reveals: create key (name, scopes, environment) → secret shown once;
list (prefix, scopes, last used); revoke with confirm.

## Rollout

- **P0**: per-key rate limit, webhook signing, ProfileMenu dev section, SDK core (merchants/quotes/orders/payments/webhooks), quickstart
- **P1**: usage counters, daily caps + alerts, hosted-checkout polish, public OpenAPI subset
- **P2**: React hooks, Python/Go SDKs, partner dashboard
