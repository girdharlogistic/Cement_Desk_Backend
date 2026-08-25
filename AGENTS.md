# AGENTS.md — where this repo actually stands

Architecture lives in the `cement-desk` skill and in `BACKEND_SPEC.md` /
`FRONTEND_INTEGRATION.md`. This file is the other thing: what is **in flight**,
what was learned the hard way, and which invariants will bite you.

Last updated: 2026-08-25, at commit `655242a`.

---

## 0. Read this first: work here has been lost before

On 2026-08-24 someone built the whole plans/entitlements feature — four source
files and a migration — and never committed it. The files were then deleted.
Only `dist/*.js` survived, and the recovery cost a session: decompiling the
build output, inferring the migration from the live schema, and proving the
result matched byte for byte.

**`dist/` is build output, not a backup. Neither is the running process.**

So:

- Commit before you stop, even if it is ugly. A branch costs nothing.
- `git status` in **both** repos before assuming anything. This repo has a
  history of large features sitting untracked for days.
- Never `git add .` without reading what is staged. `.env*` and
  `*service-account*.json` are ignored — keep it that way, and check.

---

## 1. Deployment

The service runs from `dist/`, so editing a `.ts` changes nothing until:

```bash
cd /home/ubuntu/Cement_Desk_Backend && npm run build && \
  sudo systemctl restart cementdesk-backend && sleep 2 && \
  curl -s http://127.0.0.1:8994/health
```

`/health` now returns cache sizes too:
`{"ok":true,"db":"up","cache":{"sessions":..,"firms":..,"members":..,"markers":..}}`.
If `markers` stays 0 while the app is polling, the sync watermark is not being
cached and every pull is paying full price — that is the canary.

Migrations run at boot in filename order, recorded in `_migrations`. As of now
`0001`–`0008` are applied. **Verify a fresh environment still builds** after
adding one: create a scratch database, run the whole `migrations/` chain into
it, compare `SHOW CREATE TABLE` against production, drop it. That check is what
caught nothing this time — and would have caught the lost migration immediately.

Backend tooling works fully here: `npm run build`, `npm test` (60 unit tests
pass, 18 integration skipped without `TEST_DATABASE_URL`). **Flutter is not
installed** — the app cannot be built or run on this machine. Use
`/tmp/dart-sdk/bin/dart` for `dart format` and note that `dart analyze` is
useless here (no Flutter SDK to resolve against, so it reports phantom errors
on untouched files).

---

## 2. Request units: the constraint is round trips, not data

The whole database is about **1 MB**. TiDB Serverless bills roughly one RU per
statement almost regardless of how little it returns, and a DB round trip is
~63ms. So the lever is always *fewer statements*, never *faster* ones.

Measured before/after on an idle `sync/pull`:

| | before | after |
|---|---|---|
| authenticate | 0.98 RU | 0 (cached 20s) |
| firmAccess (2 queries) | 0.98 RU | 0 (cached 60s) |
| 12 page scans + timestamp | 6.29 RU | 0.49, or 0 warm |
| `sync_state` write | 3.03 RU | gone |
| **total** | **11.28 RU** | **~0** |

Latency went from a 1025ms mean (0 of 4,511 pulls under 100ms) to 1–5ms warm,
66ms cold.

### Invariants you must not break

`firms.data_updated_at` is a watermark: pull skips the twelve table scans when
it is at or behind the client's cursor. Three things make a missed bump
survivable rather than catastrophic:

1. It is bumped from **one place** — the `onResponse` hook in `app.ts`, which
   fires for every successful non-GET request carrying `req.firmId`. That field
   is set by `firmAccess` and nothing else, and every firm-scoped write route
   stacks that guard. Do not "helpfully" bump it from a service instead.
2. **The fast path never advances the cursor.** A change whose bump went
   missing is delivered by the next bump that does land. It can arrive late; it
   cannot vanish.
3. A **NULL** watermark means "unknown" and forces the slow path.

Caches in `lib/caches.ts` are invalidated explicitly — every one of the seven
session-revoking paths in `auth/service.ts` calls `invalidateAllSessions()`, and
membership changes call `invalidateFirm()`. If you add a revocation path and
forget, a revoked token keeps working for up to 20 seconds. The TTL is only a
backstop for rows edited by hand in the SQL console.

`sync_state` was dropped because nothing read it. If a support tool ever needs
"where is device X", sample it — do not write on every poll.

---

## 3. Subscriptions — in flight, half built

### Decided

One rule everywhere: **free = one writable firm, one device.** Everything else
that firm owns stays visible but read-only. Same rule for a lapse as for a
brand-new account, so there is no special case to maintain.

| | Free | Premium |
|---|---|---|
| Firms | 1 writable, rest read-only | unlimited |
| Devices | 1 — a new sign-in signs the old device out | unlimited |
| Export, plain | after a rewarded ad | free |
| Export with party/date filters | ✗ | ✓ |
| Ads | banner ×2, app-open, rewarded | none |

Grandfathering already ran (migration `0008`): every account that had more than
one firm **or** more than one device keeps exactly that many, forever, through
lapses and plan changes. 9 rows carry it. `bestLimit()` in `plans/features.ts`
is what makes it survive — never drop somebody below what they already had.

### Shape

`plans` (name, `sku`, period, **features JSON**, active) and `entitlements`
(one row per user, `source` grant|play|code, status, `expires_at`,
`purchase_token`). Limits are data on the plan, not constants in code, so
changing an offer is a console edit rather than a release.

There is deliberately **no price column** — Play owns money. The app takes `sku`
to Play Billing and asks what it costs, which is the only answer that matches
what the user is actually charged.

`grace` counts as entitled. That is Play's payment-retry window; cutting
somebody off during it turns a failed card into a cancellation.

### Verified against Play (2026-08-25)

Product `premium`, both base plans ACTIVE, both with an ACTIVE `trial30` offer
of `P30D` free:

| base plan | price | period |
|---|---|---|
| `monthly` | ₹99 | P1M (7-day grace) |
| `yearly` | ₹599 | P1Y |

The service account (`play-releaser@cement-desk-ci`) mints a token and the
Android Publisher API answers 200, so the Play Console grant is in place.
Config: `PLAY_SA_KEY_FILE`, `PLAY_PACKAGE_NAME`, `PLAY_PRODUCT_ID`,
`PLAY_RTDN_SECRET`, `BILLING_ENFORCED`.

### Built since

`POST /api/v1/billing/verify` (`modules/billing`): the app sends the purchase
token, the server checks the anti-sharing binding **before** asking Play (a
shared token learns nothing from us, not even whether it is valid), verifies
via `purchases.subscriptionsv2.get`, **acknowledges before granting** (Play
auto-refunds an unacknowledged purchase in three days — crashing between the
two is lost revenue), maps the state (`active`/`grace`; CANCELED counts while
paid-through is ahead; READ-ONLY-read-only otherwise refused), and writes the
entitlement with `source='play'`. Re-verify is idempotent, so the app can call
it whenever it sees a purchase.

OAuth for Google APIs was factored into `src/lib/google_sa.ts`; FCM and Play
share it (different scopes). The key was proven against `androidpublisher` on
2026-08-25 — a bogus token comes back Play's own `400 Invalid Value`, not a
401, so auth and console permissions are in place. Note Play answers **400**
for a malformed token and 404 for a well-formed-but-unknown one; both map to
the same validation error in the route.

**The `plans` table is populated** (2026-08-25): "Premium Monthly" and
"Premium Yearly" (sku `premium`, period `month`/`year`, unlimited everything
+ adFree + export — the §3 table, operator-decided). Retire by clearing
`active`, never by delete while held.

### Not built yet

- RTDN webhook for renewals, cancellations and grace (needs a Pub/Sub topic).
- Enforcement itself. **`BILLING_ENFORCED` is `false` and must stay false**
  until a real purchase has been through end to end — flipping it early locks
  out the four multi-firm and three multi-device accounts by accident rather
  than by decision.
- Everything app-side: `in_app_purchase`, paywall, entitlement cache in Hive,
  the gates, the rewarded ad, ads off when premium.

---

## 4. Ads (app repo)

Four live units in `lib/ads/ad_ids.dart`: two banner bands, an app-open ad on
every fifth foreground, a 300×250 on More, and a rewarded unit
(`…/4355641966`) reserved for the export gate but not wired yet.

`AdIds.useTestIds` has been flipped on and off repeatedly during development.
**It must be `false` in any release** or the build earns nothing — and `false`
means real ads, so `testDeviceIds` (still empty) should be filled before anyone
uses a shipping build on their own phone. An accidental tap on a live ad is the
most common way an AdMob account is permanently suspended.

Ad slots are the last thing on each page, and a `ListView` builds its children
lazily — that is why banners were invisible on Freight and Landing for weeks.
Any page ending in an `AdFooter` passes `cacheExtent: AdFooter.pageCacheExtent`.

---

## 5. Secrets

- `.env` and `.play-service-account.json` (mode 600) are gitignored and are
  **not** on the remote. Verify before every push.
- The Play service account key was pasted into a chat transcript on 2026-08-25
  and **still needs rotating**. It can publish an app update to every user —
  a bigger blast radius than the database password.
- Hand over a *path*, never the contents.
