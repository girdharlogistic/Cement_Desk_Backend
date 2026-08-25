# Cement Desk Backend

The cloud API for the **Cement Desk** Android app
(`girdharlogistic/Cement_Desk_Android`) — the sync target for an offline-first
cement dealer back office (freight, stock reconciliation, scheme/landing-cost
accounting).

Stack: **Node ≥ 20.12 · TypeScript · Fastify 5 · mysql2 → TiDB Cloud
Serverless (MySQL wire) · zod · jose JWT · argon2id · nodemailer**.
Hand-written SQL migrations; no ORM. CommonJS, runs from `dist/`.

Public endpoints (behind a Cloudflare tunnel):

| | |
|---|---|
| API | `https://cementdesk.sallytion.qzz.io/api/v1` |
| Health | `GET /health` → `{ok, db, cache:{sessions,firms,members,markers}}` |
| Landing page | `GET /` |
| Operator console | `/console` (separate login, env-configured) |
| AdMob | `GET /app-ads.txt` |
| Play-mandated account deletion | `/delete-account` |

## What it does

- **Auth** — email + password (argon2id), mandatory 6-digit email-verification
  OTP, JWT access + rotating opaque refresh tokens with a 60-second reuse
  grace chain; device session list + revoke.
- **Firms & sharing** — multi-tenant books; invite by email with roles
  owner/admin/member/viewer, `LAST_OWNER`/`LAST_FIRM` guards.
- **Masters, freight, stock, landing** — CRUD REST for parties/locations/
  grades/companies/sources, server-assigned freight voucher serials, sparse
  stock-day cells, scheme/purchase/claim ledgers with frozen-claim
  immutability. The client computes the arithmetic; the server validates it
  (±0.01) and stores it.
- **Sync** — per-firm push/pull with cursors, soft-delete tombstones (180-day
  retention), a `firms.data_updated_at` watermark fast path that skips the 12
  table scans when nothing changed, idempotency keys, server wins conflicts.
- **Backup** — two-phase validated import (merge/replace) and v3 JSON export,
  wire-compatible with the app.
- **Billing** — `POST /billing/verify`: Play purchase token → subscriptionsv2
  check → acknowledge → entitlement. Plans carry feature limits as JSON
  (prices live only on Play). One-time grandfathering preserved `bestLimit`
  limits for early multi-firm/multi-device accounts.
- **Console** — operator web UI: FCM broadcast composer with image upload,
  sponsored-card editor (the app's Home-screen slot), plans CRUD, subscribers
  list, user search, analytics.

## Layout

```
src/
  index.ts     boot: migrate → buildApp → listen → jobs (ENABLE_JOBS)
  app.ts       Fastify factory, error envelope, /health, watermark hook
  config.ts    zod-validated env, fail-fast; every env var lives here
  plugins/guards.ts   authenticate · requireVerified · firmAccess · requireRole
  db/          pool (dateStrings, decimals as strings) · migrate
  lib/         cache · caches · limiter · mailer · otp · tokens · passwords
               · validators · num · dates · google_sa (FCM + Play OAuth)
  modules/     auth · firms · masters · freight · stock · landing · sync
               · backup · plans · billing · sponsor · console · site
               · account · ads_txt
  jobs/        purge (tombstones/sessions/tokens, every 6 h)
migrations/    0001–0008, run at boot in filename order
test/          unit (always) + integration (needs TEST_DATABASE_URL)
```

## Develop, build, test

```bash
cp .env.example .env    # fill in TiDB + JWT_SECRET (+ SMTP, Play, console…)
npm ci
npm run dev             # tsx watch, hot reload
npm run build           # tsc → dist/
npm test                # 72 unit tests (integration skips without TEST_DATABASE_URL)
npm run test:integration   # full suite against a scratch MySQL/TiDB database
```

`config.ts` is the single list of environment variables (zod-validated,
fail-fast at boot). The service loads `.env` itself — do **not** move that to
systemd `EnvironmentFile` (`MAIL_FROM` contains spaces).

## Deploy

The service runs from `dist/`, under `cementdesk-backend.service` on
`127.0.0.1:8994`, fronted by `cloudflared`:

```bash
npm run build && sudo systemctl restart cementdesk-backend \
  && sleep 2 && curl -s http://127.0.0.1:8994/health
```

Migrations run automatically at boot and are recorded in `_migrations`
(applied: `0001`–`0008`). The 6-hourly purge job only runs when
`ENABLE_JOBS=true`.

## Docs

- `FRONTEND_INTEGRATION.md` — the API contract, written from the handlers.
  **This repo's copy is canonical**; the app repo carries an older one.
- `BACKEND_SPEC.md` — the design spec; code comments cite its section
  numbers (`§5.6`, `§9.3`).
- `AGENTS.md` — current state, in-flight work, and the hard-won invariants
  (sync watermark, cache invalidation, RU budgeting, billing rollout).

## Secrets

`.env*` and `*service-account*.json` are gitignored — keep it that way, and
never `git add .` without reading what is staged.
