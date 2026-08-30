# Cement Desk API — Frontend Integration Guide

Everything you need to talk to the backend. Written against the deployed build; every
shape below was read off the actual route handlers, not the spec.

- **Base URL:** `https://cementdesk.sallytion.qzz.io/api/v1`
- **Health check:** `https://cementdesk.sallytion.qzz.io/health` (no `/api/v1` prefix)
- **Content type:** `application/json` in and out, UTF-8
- **Auth:** `Authorization: Bearer <accessToken>` on everything except the public auth routes

```bash
curl https://cementdesk.sallytion.qzz.io/health
# {"ok":true,"db":"up"}
```

---

## Table of contents

1. [Core conventions](#1-core-conventions)
2. [Authentication](#2-authentication)
3. [Firms, members and roles](#3-firms-members-and-roles)
4. [Request headers you should be sending](#4-request-headers-you-should-be-sending)
5. [Error format](#5-error-format)
6. [Masters — parties, locations, grades, companies, sources](#6-masters)
7. [Party routes](#7-party-routes)
8. [Freight entries](#8-freight-entries)
9. [Stock — baseline and daily sheets](#9-stock)
10. [Landing — purchases, schemes, claims](#10-landing)
11. [Sync protocol](#11-sync-protocol)
12. [Import / export](#12-import--export)
13. [Rate limits and size caps](#13-rate-limits-and-size-caps)
14. [Traps worth reading before you start](#14-traps-worth-reading-before-you-start)

---

## 1. Core conventions

### You generate the IDs

Every record's primary key is a **client-generated UUIDv4**. On any create you may send
`id` in the body; if you omit it the server generates one. Sending your own id is what
makes creates safely retryable and what lets an offline device create records before it
ever reaches the server.

Ids are unique **within a firm**, not globally. The same UUID may legitimately exist in
two different firms (this is what makes "restore my backup into a new firm" work).

### Field naming

JSON uses **camelCase** everywhere (`firmId`, `ratePerBag`, `bagWeightKg`, `revenuePerBag`,
`gradeBags`). The database uses snake_case; that mapping is entirely server-side and never
leaks into the API.

### Dates: two different things

| Kind | Format | Example | Notes |
|---|---|---|---|
| **Business date** | `yyyy-MM-dd` | `"2026-08-14"` | A calendar day. **Timezone-opaque** — never convert it. |
| **Audit timestamp** | ISO-8601 UTC with `Z` | `"2026-08-14T09:12:33.412Z"` | `createdAt`, `updatedAt`, `deletedAt`, `serverTime`, `nextCursor` |

Business dates (`date`, `periodFrom`, `windowTo`, `sentOn`…) are the dealer's calendar day.
14 August is 14 August in Mumbai, on the server, and in your test runner. **Do not** parse
them into a `Date` and re-serialize — you will shift them by a day in half the world's
timezones. Keep them as strings.

The server is lenient on input and will accept `"2026-08-14"`, `"2026-08-14T00:00:00"`, or
a full ISO string with an offset — in every case it takes the **date part literally** with
no conversion. It always returns the plain `yyyy-MM-dd` form. Send the plain form.

Valid business dates are `2000-01-01` to `2099-12-31`.

### Numbers

All money and quantity fields are **JSON numbers**, never strings. The database stores them
as DECIMAL and converts at the boundary. Values in this domain are far below
`Number.MAX_SAFE_INTEGER`, so plain JS numbers are fine — but compare with a `0.01`
tolerance, never `===`.

### Enums are strings

Send `"km"`, `"perBag"`, `"quarterly"` — never the legacy Dart ordinal integers.

| Enum | Values |
|---|---|
| Freight `basis` | `km`, `bag` |
| Source `type` | `plant`, `depot` |
| Scheme `kind` | `fixed`, `variable`, `mix`, `cash` |
| Scheme `period` | `monthly`, `quarterly`, `annual` (nullable) |
| `qtyUnit`, `minPremiumUnit` | `bag`, `mt` |
| Scheme `valueType` | `perBag`, `perMt`, `percent` |
| Claim `status` | `claimable`, `claimed`, `received` |
| Member `role` | `owner`, `admin`, `member`, `viewer` |

The **only** place integer enums are accepted is the backup import endpoint (§13), because
the legacy on-device JSON backups store them that way.

### Sync metadata on every tenant record

Every record under `/firms/{firmId}/…` carries these five fields:

```json
{
  "rev": 4,
  "createdAt": "2026-08-14T09:12:33.412Z",
  "updatedAt": "2026-08-14T09:40:02.100Z",
  "deletedAt": null,
  "updatedBy": "e2b1…-user-uuid"
}
```

`rev` starts at 1 and increments on every write. You need it for `If-Match` (§4) and for
sync push (§11). `deletedAt != null` means the record is a **tombstone** — deletes are soft
so offline devices can learn about them.

### Response envelopes are not uniform

Some endpoints return a bare array, most return a wrapped object. The table in each section
below gives the exact key. Summary of the bare-array ones, because they are the easy ones to
get wrong:

- `GET /firms`
- `GET /auth/sessions`
- `GET /firms/{firmId}/parties` (and locations, grades, companies, sources)
- `GET /firms/{firmId}/routes`
- `GET /firms/{firmId}/freight-entries/summary` (bare object, not array)

---

## 2. Authentication

### Token model

- **Access token** — JWT, `Authorization: Bearer <token>`, **15 minute** lifetime.
- **Refresh token** — opaque random string, **60 day** lifetime, rotated on every use.

Store the refresh token in the most secure storage the platform offers (Keychain /
Keystore / encrypted prefs). Never put either token in a URL or log line.

### The endpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/auth/signup` | `{ email, password, displayName?, firmName?, fyStartMonth? }` | **201** `{ user, tokens, firm? }` |
| POST | `/auth/login` | `{ email, password, deviceId?, deviceLabel? }` | **200** `{ user, tokens }` |
| POST | `/auth/refresh` | `{ refreshToken }` | **200** `{ tokens }` |
| POST | `/auth/logout` | `{ refreshToken }` | **204** |
| POST | `/auth/logout-all` | — (auth required) | **204** |
| GET | `/auth/me` | — | **200** `{ user, firms[] }` |
| PATCH | `/auth/me` | `{ displayName?, phone? }` | **200** `{ user }` |
| POST | `/auth/change-password` | `{ currentPassword, newPassword }` | **204** |
| POST | `/auth/forgot-password` | `{ email }` | **204** always |
| POST | `/auth/reset-password` | `{ email, code, newPassword }` | **204** |
| POST | `/auth/verify-email` | `{ code }` (auth required) | **200** `{ user }` |
| POST | `/auth/resend-verification` | — (auth required) | **204** |
| GET | `/auth/sessions` | — | **200** bare array |
| DELETE | `/auth/sessions/{id}` | — | **204** |

Password rules: 8–128 characters. Phone must be E.164 (`+919812345678`) or `""` to clear it.
`fyStartMonth` is 1–12 and defaults to **4** (April).

### Email verification is mandatory

**Every route outside `/auth/*` returns `403 EMAIL_NOT_VERIFIED` until the account has
confirmed its address.** That includes `/firms`, so a fresh account cannot create or list a
firm, push, or pull before verifying.

The flow the app implements:

1. `POST /auth/signup` → 201 with a working session. `user.emailVerified` is `false`.
2. Server emails a **6-digit code**, valid 10 minutes, single use.
3. App shows the code screen. `POST /auth/verify-email { code }` → 200 with the updated
   user; `emailVerified` is now `true`.
4. Only now does the app call `/auth/me` and the firm routes.

`POST /auth/resend-verification` issues a fresh code and **retires the previous one** — a
code the user is still looking at stops working the moment they ask for another. Throttled
to one per minute and five per hour per user; a 429 carries `Retry-After`.

Five wrong codes burn the code and force a resend. Every failure returns the same
`VALIDATION_FAILED` message whether the code was wrong, expired, or never existed.

### Shapes

```json
// tokens
{
  "accessToken": "eyJhbGci…",
  "refreshToken": "8Qk3…opaque…",
  "refreshExpiresAt": "2026-10-13T09:12:33.412Z"
}

// user
{
  "id": "…uuid…",
  "email": "dealer@example.com",
  "phone": null,
  "displayName": "Sharma",
  "emailVerified": false,
  "status": "active",
  "createdAt": "2026-08-14T09:12:33.412Z",
  "updatedAt": "2026-08-14T09:12:33.412Z"
}

// GET /auth/me
{
  "user": { … },
  "firms": [{ "id": "…", "name": "Sharma Traders", "role": "owner", "fyStartMonth": 4 }]
}

// GET /auth/sessions  → bare array
[{ "id": "…", "deviceLabel": "Pixel 8", "lastUsedAt": "…Z", "createdAt": "…Z", "current": true }]
```

### First-run signup

Passing `firmName` to `/auth/signup` creates the user, the firm, the owner membership and
the firm's serial counter **in one transaction**, and returns the firm in the response.
This mirrors the app's first-run screen, which only asks for a firm name. Use it — do not
sign up and then create a firm as two calls.

### Refresh rotation and reuse detection — read this carefully

Every call to `/auth/refresh` **revokes the token you sent** and issues a new pair. The old
refresh token is dead the moment you use it.

If a **revoked** refresh token is ever presented again, the server treats it as a stolen-token
event and **revokes every session for that user**. The legitimate device gets logged out too.

Practical consequences for your HTTP layer:

1. **Serialize refreshes.** If five requests 401 at once, they must not all fire `/auth/refresh`.
   Use a single in-flight refresh promise that the others await. Firing concurrent refreshes
   with the same token will nuke the user's session.
2. **Persist the new refresh token before using the new access token.** If you crash between
   the two, you have lost the session.
3. On `401` with code `TOKEN_REVOKED`, do **not** retry — clear local credentials and send the
   user to login.

### Recommended 401 handling

```
request → 401 ?
  ├─ code TOKEN_EXPIRED   → refresh once (shared promise), retry the original request once
  ├─ code TOKEN_REVOKED   → wipe tokens, go to login screen
  └─ code UNAUTHENTICATED → wipe tokens, go to login screen
```

### Email flows

SMTP is configured and live. Two different primitives go out by email, and they are not
interchangeable:

**6-digit codes** — email verification and password reset. Typed by hand into the app, so
they are short. 10-minute lifetime, single use, 5 wrong guesses and the code is dead.
Because a million codes is a small keyspace, each is stored salted and the attempt counter
is on the row — the lockout, not the hash, is what makes this safe.

**Opaque 32-byte tokens** — firm invites only. 7-day lifetime, single use, handed to
`/firms/{firmId}/members/accept`. These stay long: an invite goes to somebody who may not
have the app yet, is valid for a week, and grants access to another user's books.

`/auth/forgot-password` **always returns 204**, whether or not the email exists, and
`/auth/reset-password` returns the same error for an unknown address as for a wrong code.
Do not try to infer account existence from either.

---

## 3. Firms, members and roles

The tenancy unit is the **firm**, not the user. A user can belong to several firms with a
different role in each. `firmId` always comes from the **URL path** — the server ignores any
`firmId` in a request body.

| Method | Path | Body | Returns | Min role |
|---|---|---|---|---|
| GET | `/firms` | — | bare array | authenticated |
| POST | `/firms` | `{ name, fyStartMonth? }` | **201** `{ firm }` | authenticated |
| PATCH | `/firms/{firmId}` | `{ name?, fyStartMonth? }` | `{ firm }` | admin |
| DELETE | `/firms/{firmId}` | — | **204** | **owner** |
| GET | `/firms/{firmId}/members` | — | bare array | any member |
| POST | `/firms/{firmId}/members/invite` | `{ email, role }` | **201** `{ inviteId }` | admin |
| POST | `/firms/{firmId}/members/accept` | `{ token }` | **201** `{ firm }` | authenticated |
| PATCH | `/firms/{firmId}/members/{userId}` | `{ role }` | **204** | admin |
| DELETE | `/firms/{firmId}/members/{userId}` | — | **204** | admin |

### Role matrix

| Role | Can do |
|---|---|
| `viewer` | Read everything in the firm. No writes at all. |
| `member` | All record CRUD: masters, freight, stock, landing, sync push. |
| `admin` | Everything `member` can, plus edit the firm, manage members, import backups. |
| `owner` | Everything, plus delete the firm and grant/revoke ownership. |

Roles are ranked `viewer(0) < member(1) < admin(2) < owner(3)`; a gate of "admin" means
admin **or** owner.

### Guard rails that return 409

- **`LAST_OWNER`** — a firm must always keep at least one owner. Demoting or removing the
  last one fails.
- **`LAST_FIRM`** — a user must always keep at least one firm. Deleting their only firm fails.

### Invites

`invite` accepts roles `admin`, `member`, `viewer` — **ownership can never be granted by
invite**. The invite is addressed to a specific email; only a logged-in user whose account
email matches may accept, otherwise `403 FORBIDDEN`. Accepting an invite for a firm you are
already in is a no-op, not an error.

Note that `POST /firms/{firmId}/members/accept` only requires authentication, not membership
(obviously — you are not a member yet).

---

## 4. Request headers you should be sending

### `Authorization: Bearer <accessToken>`

Required on everything except `/health`, `/auth/signup`, `/auth/login`, `/auth/refresh`,
`/auth/logout`, `/auth/forgot-password`, `/auth/reset-password`.

`/auth/verify-email` and `/auth/resend-verification` **do** need it — they are the only two
authenticated routes an unverified account can reach.

### `Idempotency-Key: <uuid>` — on creates

Accepted on every POST that creates data. Replaying the same key returns the **original
stored response** (same status, same body) instead of creating a second record. Keys are
retained for at least 24 hours, so treat 24 h as the guaranteed replay window.

Use it on every create you might retry after a network failure. Generate one UUID per
logical user action and reuse it across retries of that action — not per HTTP attempt.

Supported on: `POST /firms`, `POST /firms/{id}/members/invite`, all master creates,
`POST /freight-entries`, `POST /stock-days`, `POST /purchases`, `POST /claims`,
`POST /sync/push`, `POST /import/backup`.

### `If-Match: <rev>` — on updates

Optimistic concurrency. Send the `rev` you last read. If the server's row has moved on you
get **409 `REV_MISMATCH`** with the current server row attached, so you can show a merge
prompt:

```json
{
  "error": { "code": "REV_MISMATCH", "message": "The record was changed elsewhere", "requestId": "…" },
  "server": { "id": "…", "rev": 7, "…": "…the full current row…" }
}
```

Omitting `If-Match` means last-write-wins. For money records (freight entries, purchases,
claims) you should always send it.

Supported on: `PATCH` for masters, freight entries, purchases, schemes, claims.

---

## 5. Error format

Every error, without exception, has this shape:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Validation failed",
    "details": [
      { "field": "bags", "code": "MUST_BE_NON_NEGATIVE", "message": "Bags must be >= 0" }
    ],
    "requestId": "746a50db-6163-46cb-b881-a008d0baf8ef"
  }
}
```

`details` is optional and only present for field-level validation failures. `requestId` is
always present — **log it**, it is how the backend team finds your request.

Branch on `error.code`, never on the message text.

| HTTP | Code | What it means / what to do |
|---|---|---|
| 400 | `VALIDATION_FAILED` | Bad field. Show `details` against your form fields. |
| 400 | `MALFORMED_JSON` | Your request body was not valid JSON. Bug on the client. |
| 401 | `UNAUTHENTICATED` | No/invalid token. Go to login. |
| 401 | `TOKEN_EXPIRED` | Access token aged out. Refresh and retry once. |
| 401 | `TOKEN_REVOKED` | Session killed (logout-all, password change, or reuse detection). Go to login. |
| 403 | `FORBIDDEN` | Generic denial (e.g. invite addressed to another account). |
| 403 | `INSUFFICIENT_ROLE` | Their role is too low. Hide the control rather than letting them hit this. |
| 403 | `NOT_A_FIRM_MEMBER` | Not a member of that firm. |
| 404 | `NOT_FOUND` | No such record or route. |
| 409 | `REV_MISMATCH` | Concurrent edit. Body carries `server` — offer a merge. |
| 409 | `DUPLICATE_KEY` | Unique constraint hit (e.g. claim already exists for that scheme + period). |
| 409 | `CLAIM_IMMUTABLE` | Tried to change a frozen claim field. See §10. |
| 409 | `CURSOR_TOO_OLD` | Sync cursor older than 180 days. Do a full resync from epoch. |
| 409 | `STOCK_DAY_EXISTS` | A sheet already exists for that date. |
| 409 | `DAY_BEFORE_BASELINE` | Stock day must be strictly after the baseline date. |
| 409 | `LAST_OWNER` | Firm must keep ≥ 1 owner. |
| 409 | `LAST_FIRM` | User must keep ≥ 1 firm. |
| 413 | `PAYLOAD_TOO_LARGE` | Over the body cap (§14). |
| 422 | `BUSINESS_RULE_VIOLATION` | Valid syntax, illegal business state. Message is user-showable. |
| 429 | `RATE_LIMITED` | Back off. Honour the `Retry-After` response header (seconds). |
| 500 | `INTERNAL` | Server bug. Report with the `requestId`. |

---

## 6. Masters

Six entities share one identical CRUD shape: **parties, locations, grades, companies,
sources, schemeFolders**. Everything below applies to all six; only the fields and the
response key differ.

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/{entity}?includeDeleted=false` | bare array | any member |
| POST | `/firms/{firmId}/{entity}` | **201** (or **200**) `{ <singular> }` | member |
| PATCH | `/firms/{firmId}/{entity}/{id}` | `{ <singular> }` | member |
| DELETE | `/firms/{firmId}/{entity}/{id}` | **204** | member |
| POST | `/firms/{firmId}/{entity}/reorder` | **204** | member |

**Response key is singular**: `parties` → `{ "party": {…} }`, `locations` → `{ "location": {…} }`,
`grades` → `{ "grade": {…} }`, `companies` → `{ "company": {…} }`, `sources` → `{ "source": {…} }`,
`schemeFolders` → `{ "schemeFolder": {…} }`.

**POST returns 201 when it created a row and 200 when it updated an existing id.** Sending a
create with an id that already exists is an idempotent upsert, and it will resurrect a
tombstoned record. Treat 200 and 201 the same way.

`?includeDeleted=true` includes tombstones. You normally want the default (`false`).

### Fields

| Entity | Create body | Extra response fields |
|---|---|---|
| `parties` | `{ id?, code?, name, phone?, order? }` | `code`, `phone`, `order` |
| `locations` | `{ id?, name }` | — |
| `grades` | `{ id?, name, order?, bagWeightKg? }` | `bagWeightKg` (default `50`) |
| `companies` | `{ id?, name, order? }` | `order` |
| `sources` | `{ id?, name, type?, order? }` | `type` (`plant`/`depot`, default `plant`) |
| `schemeFolders` | `{ id?, name, order? }` | `order` |

`name` is 1–160 chars (1–80 for grades). `order` is 0–1,000,000. PATCH bodies are the same
fields, all optional, minus `id`.

```json
// GET /firms/{firmId}/parties  → bare array
[{
  "id": "…", "firmId": "…", "code": "12", "name": "Agrawal Traders", "phone": null, "order": 0,
  "rev": 1, "createdAt": "…Z", "updatedAt": "…Z", "deletedAt": null, "updatedBy": "…"
}]
```

### Sort order

The server returns masters already sorted the way the app expects. **Do not re-sort client-side.**
Parties in particular use a three-key sort: `order` ascending, then numeric `code` ascending
(non-numeric codes sort last), then case-insensitive name.

### Reorder

```json
POST /firms/{firmId}/parties/reorder
{ "ids": ["uuid-a", "uuid-b", "uuid-c"] }   → 204
```

Rewrites `order` to 0..n in the given sequence, in one transaction. Send the full ordered
list after a drag — do not issue N individual PATCHes. Max 5000 ids.

### Delete cascades

Deletes are soft (tombstones). Cascades the server performs for you:

- **Party** → its routes are tombstoned; its baseline entries and stock-day cells are removed,
  and the affected stock days get a `rev` bump so your next pull sees the change.
- **Grade** → **refused with 422** if any live purchase or scheme still references it. Delete
  those first. Otherwise its baseline entries, stock cells and receipts are removed.
- **Company** → cascades to its purchases, schemes, and those schemes' claims.
- **Scheme folder** → its schemes are **unfiled, never deleted**: `folderId` is set to null and
  each affected scheme gets a `rev` bump so your next pull sees the move. A folder is filing,
  not ownership.
- **Location**, **Source** → no cascade.

---

## 7. Party routes

Routes hold the **prefill defaults** for a (party, location) pair. They have a surrogate
UUID `id`, but the natural key is the pair.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/firms/{firmId}/routes` | — | bare array |
| PUT | `/firms/{firmId}/routes` | `{ partyId, locationId, distanceKm, revenuePerBag }` | `{ route, created }` |
| DELETE | `/firms/{firmId}/routes/{partyId}/{locationId}` | — | **204** |

`PUT` is a **natural-key upsert** — it creates, updates, or resurrects a tombstoned route as
needed, and tells you which via `created`. Note the delete path takes the **pair**, not the id.

Each route also carries a convenience `key` field, `"{partyId}::{locationId}"`, which is the
key shape the legacy client used and what the sync layer accepts as a mutation id.

```json
{ "route": {
    "id": "…", "firmId": "…", "partyId": "…", "locationId": "…",
    "key": "partyUuid::locationUuid",
    "distanceKm": 42.5, "revenuePerBag": 12.5,
    "rev": 1, "createdAt": "…Z", "updatedAt": "…Z", "deletedAt": null, "updatedBy": "…"
  },
  "created": true }
```

---

## 8. Freight entries

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/freight-entries` | `{ entries, nextCursor }` | any member |
| POST | `/firms/{firmId}/freight-entries` | **201** `{ entry }` | member |
| GET | `/firms/{firmId}/freight-entries/summary` | bare object | any member |
| GET | `/firms/{firmId}/freight-entries/{id}` | `{ entry }` | any member |
| PATCH | `/firms/{firmId}/freight-entries/{id}` | `{ entry }` | member |
| DELETE | `/firms/{firmId}/freight-entries/{id}` | **204** | member |

### List filters and pagination

`?from=&to=&partyId=&locationId=&limit=&cursor=`

`from`/`to` are inclusive business dates. `limit` defaults to **200**, max **500**. Results are
newest first (`date DESC, id DESC`).

`nextCursor` is an **opaque string** — pass it back verbatim as `?cursor=`. When it is `null`
you have reached the end. Never construct or parse it yourself.

```
GET /firms/{firmId}/freight-entries?from=2026-08-01&to=2026-08-31&limit=200
→ { "entries": [ … ], "nextCursor": "eyJkIjoiMj…" }
GET /firms/{firmId}/freight-entries?from=…&to=…&limit=200&cursor=eyJkIjoiMj…
→ { "entries": [ … ], "nextCursor": null }
```

### Create body

```json
{
  "id": "client-uuid",              // optional
  "date": "2026-08-14",
  "partyId": "…uuid…",
  "locationId": "…uuid…",
  "vehicleNo": "HR56X1000",         // optional, default "", uppercased by the server
  "revenuePerBag": 12.5,
  "bags": 400,
  "totalReimbursed": 5000,
  "basis": "km",                    // "km" | "bag"
  "costRate": 10,
  "costUnits": 400,                 // optional, default 0
  "otherExpenses": 5,               // optional, default 0
  "otherNote": "toll",              // optional, default ""
  "totalCost": 4005,
  "profit": 995,
  "gradeBags": { "gradeUuid": 400 } // optional
}
```

### The client computes the math — the server verifies it

This is the single most important rule in this section. **You send the computed totals; the
server checks them and rejects mismatches.** It never silently recomputes and overwrites
your numbers.

```
units            = (basis === "bag") ? bags : costUnits
totalReimbursed  = revenuePerBag * bags
totalCost        = costRate * units + otherExpenses
profit           = totalReimbursed - totalCost
```

Tolerance is **±0.01**. A mismatch is `400 VALIDATION_FAILED` with `code: "FORMULA_MISMATCH"`
naming the offending field. Use exactly the same rounding on the client as you display.

`gradeBags` is a map of `gradeId → bags`. If present and non-empty, **it must sum to `bags`**
(±0.01) or you get `422 BUSINESS_RULE_VIOLATION` — this is the "split must be Matched" rule
from the app. Omit the key entirely if there is no split.

### Serial numbers are server-assigned

Each entry gets a `serial` that is **per-firm, monotonic, and never reused**. You cannot set
it, and you must not guess it. Read it off the create response. Gaps can appear if a create
fails; that is expected and fine. For entries created offline, the serial comes back in the
`serials[]` array of the sync push response (§11).

### PATCH

All create fields are optional; `id` cannot be changed. Only keys you actually send are
written, but the **merged** record is re-validated against the formulas above — so if you
change `bags` you must also send the recomputed `totalReimbursed`, `totalCost` and `profit`.

Send `If-Match: <rev>`. These are money records.

### Summary

`GET /firms/{firmId}/freight-entries/summary?from=&to=&partyId=` returns a **bare object**:

```json
{
  "entryCount": 128,
  "bags": 51200,
  "totalReimbursed": 640000,
  "totalCost": 512400,
  "netProfit": 127600,
  "profitPerBag": 2.4921875,
  "byLocation": [
    { "locationId": "…", "locationName": "Depot A", "entryCount": 64, "bags": 25600,
      "totalReimbursed": 320000, "totalCost": 256200, "netProfit": 63800, "profitPerBag": 2.49 }
  ]
}
```

Pure aggregation over stored columns — nothing is re-derived. `byLocation` is sorted by
profit descending. `locationName` is `null` if the location was deleted.

---

## 9. Stock

### The baseline

One opening baseline per firm. It is the anchor every later day is computed from.

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/baseline` | bare object | any member |
| PUT | `/firms/{firmId}/baseline` | `{ baseline, affectedDayCount }` | member |

```json
PUT /firms/{firmId}/baseline
{
  "date": "2026-08-01",
  "physical": { "gradeUuid": 1200 },
  "sap":      { "gradeUuid": 1180 },
  "party":    { "partyUuid": { "gradeUuid": 40 } }
}
```

`PUT` replaces the baseline **wholesale** — children included. Send the complete maps every
time; anything you omit is deleted.

`GET` returns `404 NOT_FOUND` when no baseline has been set yet. That is the normal state for
a brand-new firm — handle it as "not configured", not as an error.

`affectedDayCount` tells you how many existing stock days sit after the new baseline date and
are therefore re-rated. Show a confirmation when it is non-zero.

**Moving the baseline onto or after an existing stock day is refused with 422.** Days are only
valid strictly after the baseline. Delete or move those days first.

### Daily sheets

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/stock-days?from=&to=` | `{ days }` | any member |
| POST | `/firms/{firmId}/stock-days` | **201** `{ day }` | member |
| GET | `/firms/{firmId}/stock-days/{date}` | `{ day }` | any member |
| PUT | `/firms/{firmId}/stock-days/{date}/cells` | `{ day }` | member |
| PUT | `/firms/{firmId}/stock-days/{date}/note` | `{ day }` | member |
| POST | `/firms/{firmId}/stock-days/{date}/receipts` | **201** `{ day }` | member |
| DELETE | `/firms/{firmId}/stock-days/{date}/receipts/{receiptId}` | **200** `{ day }` | member |
| DELETE | `/firms/{firmId}/stock-days/{date}` | **204** | member |

Note the path parameter is the **date** (`yyyy-MM-dd`), not the day's UUID. The mutating
endpoints all return the **whole refreshed day**, so you can drop it straight into state
without a follow-up GET.

```json
// a day
{
  "id": "…uuid…",
  "firmId": "…",
  "date": "2026-08-14",
  "note": "SAP down tha, 2 truck raste mein",
  "clientKey": "firmUuid|2026-08-14",
  "receipts": [
    { "id": "…", "gradeId": "…", "qty": 500, "sapQty": 500, "ref": "INV-9" }
  ],
  "rows": {
    "partyUuid": { "gradeUuid": { "billing": 20, "dispatch": 18 } }
  },
  "rev": 3, "createdAt": "…Z", "updatedAt": "…Z", "deletedAt": null, "updatedBy": "…"
}
```

`POST /stock-days` takes `{ "date": "2026-08-14" }` and fails with:
- **409 `DAY_BEFORE_BASELINE`** if the date is on or before the baseline date, or no baseline exists yet
- **409 `STOCK_DAY_EXISTS`** if a live sheet already exists for that date

Creating a date whose sheet was previously deleted **resurrects** it rather than failing.

### Cells are sparse — `{0,0}` deletes

```json
PUT /firms/{firmId}/stock-days/2026-08-14/cells
{ "partyId": "…", "gradeId": "…", "billing": 20, "dispatch": 18 }
```

One cell per call. **Writing `billing: 0, dispatch: 0` deletes the cell** rather than storing
zeros, and the returned `rows` map will simply not contain that key. Your grid must treat a
missing key as zero — do not expect a dense matrix.

### The day's remark

```json
PUT /firms/{firmId}/stock-days/2026-08-14/note
{ "note": "SAP down tha, 2 truck raste mein" }
```

One free-text remark per sheet, max 500 characters; `""` clears it. It has its own route
rather than riding on the cell PUT because it is written on a completely different rhythm —
the app saves a cell on every keystroke, but a remark only when typing pauses and when the
field loses focus, since a sentence would otherwise cost a dozen round trips to type.

Over sync it is a plain field on the day. **Omitting `note` from a `stockDays` upsert leaves
the stored value alone** — it is not "set it to empty". Send `""` to clear.

### Receipts

`POST …/receipts` with `{ id?, gradeId, qty, sapQty?, ref? }`. Sending an `id` that already
exists updates that receipt in place, so this is safe to retry.

---

## 10. Landing

### Purchases

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/purchases?from=&to=&companyId=&gradeId=&limit=&cursor=` | `{ purchases, nextCursor }` | any member |
| POST | `/firms/{firmId}/purchases` | **201** `{ purchase }` | member |
| PATCH | `/firms/{firmId}/purchases/{id}` | `{ purchase }` | member |
| DELETE | `/firms/{firmId}/purchases/{id}` | **204** | member |
| POST | `/firms/{firmId}/purchases/{id}/payments` | **201** `{ purchase }` | member |
| DELETE | `/firms/{firmId}/purchases/{id}/payments/{paymentId}` | **200** `{ purchase }` | member |

Pagination works exactly as for freight entries (limit 200/500, opaque `nextCursor`).

```json
{
  "id": "client-uuid",
  "date": "2026-08-14",
  "companyId": "…", "gradeId": "…", "sourceId": "…",
  "qty": 500,                 // must be > 0
  "ratePerBag": 300,          // must be >= 0
  "invoiceNo": "INV-1",       // optional, default ""
  "payments": [               // optional, max 200
    { "id": "…", "date": "2026-08-15", "amount": 50000 }
  ]
}
```

Payments are an **append-only ledger** and come back inlined on the purchase. Both payment
endpoints return the full refreshed purchase and bump the purchase's `rev`, so your sync
pull picks up the child change.

**Overpayment is legal.** Σ payments may exceed `qty × ratePerBag` — the backend deliberately
does not reject it. Do not add a client-side guard.

Bill value is not stored; compute `qty * ratePerBag` for display.

### Schemes

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/schemes?companyId=&active=` | `{ schemes }` | any member |
| POST | `/firms/{firmId}/schemes` | **201** `{ scheme }` | member |
| PATCH | `/firms/{firmId}/schemes/{id}` | `{ scheme }` | member |
| POST | `/firms/{firmId}/schemes/{id}/activate` | `{ scheme }` | member |
| DELETE | `/firms/{firmId}/schemes/{id}` | **204** | member |

`?active=true` / `?active=false` filters; omit for all.

```json
{
  "id": "client-uuid",
  "name": "Q2 Volume Scheme",
  "companyId": "…",
  "gradeIds": [],             // grade scope; EMPTY = ALL GRADES
  "gradeId": null,            // derived, read-only in practice — see below
  "folderId": null,           // optional scheme folder; null = unfiled
  "perGrade": false,
  "sourceId": null,
  "kind": "fixed",            // fixed | variable | mix | cash
  "period": "quarterly",      // required for fixed and mix
  "windowFrom": null,         // required pair for variable
  "windowTo": null,
  "qtyUnit": "bag",           // bag | mt        (default bag)
  "valueType": "perBag",      // perBag | perMt | percent  (default perBag)
  "premiumGradeIds": [],      // required non-empty for kind "mix"
  "minPremiumQty": 0,
  "minPremiumUnit": "mt",     // DEFAULT IS "mt", not "bag"
  "slabs": [ { "from": 0, "value": 5 }, { "from": 1000, "value": 7 } ],
  "active": true
}
```

Validation rules, all returning `400 VALIDATION_FAILED`:

- An **active** scheme needs at least one slab.
- Slab `from` values must be unique. Slabs are stored **auto-sorted ascending** by `from` — read
  them back in that order regardless of what you sent.
- `kind: "mix"` needs a non-empty `premiumGradeIds`, and `minPremiumQty >= 0`.
- `kind: "variable"` needs both `windowFrom` and `windowTo`, with `windowFrom <= windowTo`.
- `kind: "fixed"` and `"mix"` need a `period`.
- `folderId`, if not null, must be a live folder in this firm — otherwise
  `400 VALIDATION_FAILED` with `field: "folderId"`. The **sync push is deliberately more
  forgiving**: a scheme naming a folder that no longer exists is stored unfiled rather than
  rejected, because a folder deleted on another device must not cost you the scheme.

#### `gradeIds` vs `gradeId`

`gradeIds` is the grade scope and **an empty array means every grade** — the absence of a
filter, never "no grades". A company letter routinely names two or three of the grades you
trade, which the old single `gradeId` could not express: it could only say "one" or (null)
"all".

`gradeId` is still present and still accepted, purely for compatibility:

- **Reading**, it is derived — the single grade when `gradeIds` has exactly one entry, `null`
  otherwise. A two-grade scheme therefore reads back as `gradeId: null`, which an old client
  interprets as "all grades". That is the safe direction: it over-reads rather than silently
  attributing the scheme to one wrong grade.
- **Writing**, it is only consulted when you send no `gradeIds` at all. `gradeIds` always
  wins when both are present.

Send `gradeIds`. Only fall back to `gradeId` if you are on a build that predates it.

`PATCH` merges: slabs, `premiumGradeIds` and `gradeIds` are only rewritten if you actually
send those keys. Send the complete array when you do — it is a replace, not an append.

**Deleting a scheme also deletes its claims.** This is intentional (§5.6 of the spec).

### Claims — mostly frozen snapshots

| Method | Path | Returns | Min role |
|---|---|---|---|
| GET | `/firms/{firmId}/claims?status=&companyId=` | `{ claims }` | any member |
| POST | `/firms/{firmId}/claims` | **201** `{ claim }` | member |
| PATCH | `/firms/{firmId}/claims/{id}` | `{ claim }` | member |
| DELETE | `/firms/{firmId}/claims/{id}` | **204** | member |
| POST | `/firms/{firmId}/claims/{id}/credit-notes` | **201** `{ claim }` | member |
| DELETE | `/firms/{firmId}/claims/{id}/credit-notes/{cnId}` | **200** `{ claim }` | member |

```json
{
  "id": "…", "firmId": "…", "schemeId": "…", "companyId": "…",
  "schemeName": "Q2 Volume Scheme",
  "periodFrom": "2026-07-01", "periodTo": "2026-07-31",
  "label": "Jul 2026",
  "bags": 5000, "accrued": 25000,
  "status": "claimable",
  "sentOn": null,
  "creditNotes": [ { "id": "…", "date": "2026-08-10", "number": "CN-1", "amount": 10000 } ],
  "receivedAmount": 10000,     // derived, never stored
  "pendingAmount": 15000,      // derived, never stored
  "rev": 2, "createdAt": "…Z", "updatedAt": "…Z", "deletedAt": null, "updatedBy": "…"
}
```

A claim is a **frozen snapshot of what was earned**. Only three fields are editable:

- `status`
- `sentOn`
- `schemeName`

Everything else — `bags`, `accrued`, `periodFrom`, `periodTo`, `label`, `schemeId`, `companyId` —
is immutable. Sending a **different** value returns `409 CLAIM_IMMUTABLE` naming the field.
Echoing the **identical** value back is tolerated, so you can safely PATCH the whole object.
`bags` and `accrued` compare with a 0.01 tolerance; the rest compare as strings.

`schemeId` is deliberately **not** a foreign key: a claim stays readable even after its scheme
is gone, which is why `companyId` and `schemeName` are denormalized onto it. Don't assume you
can resolve `schemeId` to a live scheme.

Only one claim may exist per `(schemeId, periodFrom)` — a second returns `409 DUPLICATE_KEY`.

#### Status transitions are partly automatic

After any write, the server recomputes:

- If `receivedAmount >= accrued` **and** there is at least one credit note → **`received`**.
- If the status was `received` but that no longer holds → falls back to `claimed` when `sentOn`
  is set, otherwise `claimable`.

So adding a credit note that covers the accrual flips the claim to `received` on its own, and
deleting it flips it back. Always render `status` from the response rather than predicting it.

`receivedAmount` and `pendingAmount` are computed per request from the credit notes and are
never stored — don't send them.

---

## 11. Sync protocol

This is what makes the app work offline. Sync is **per firm** — a user with three firms syncs
each independently, and a device only syncs firms it has actually opened.

The cycle is: **push** local changes, then **pull** everything that changed since your cursor.

### Pull

```
GET /firms/{firmId}/sync/pull?cursor=<ISO8601>&limit=1000&deviceId=<uuid>
```

`limit` defaults to 1000, max 2000. `deviceId` is optional; passing it lets the server
remember your cursor. Omit `cursor` entirely for a **full sync from the beginning**.

```json
{
  "serverTime": "2026-08-14T09:12:33.412Z",
  "nextCursor": "2026-08-14T09:12:31.006Z",
  "hasMore": false,
  "changes": {
    "parties": [], "locations": [], "grades": [], "routes": [],
    "companies": [], "sources": [],
    "freightEntries": [],
    "baseline": null,
    "stockDays": [],
    "purchases": [], "schemeFolders": [], "schemes": [], "claims": []
  }
}
```

Rules:

- The cursor is **exclusive**: you get rows with `updatedAt > cursor`.
- **Tombstones are included** — records with `deletedAt != null`. That is how deletes reach you.
  Apply them as deletes locally.
- **Parents arrive with children inlined**: a `stockDay` carries its `receipts` and `rows`, a
  `purchase` its `payments`, a `scheme` its `slabs`, `gradeIds` and `premiumGradeIds`, a
  `claim` its `creditNotes`. Children have no independent cursor.
- `baseline` is a single object or `null` (null meaning "unchanged since your cursor"), not an array.
- **If `hasMore` is true, immediately pull again with the returned `nextCursor`.** Loop until it
  is false.
- Store `nextCursor` **verbatim**. Never generate a cursor from the device clock — the cursor is
  an opaque value the server issued.
- Rows may occasionally be re-sent across pages. Apply changes idempotently (upsert by id).

**`409 CURSOR_TOO_OLD`** means your cursor predates the 180-day tombstone retention window: you
would miss deletes. Discard the cursor, pull from the beginning, and reconcile locally.

### Push

```
POST /firms/{firmId}/sync/push
Idempotency-Key: <uuid>

{
  "deviceId": "…",
  "baseCursor": "2026-08-14T09:12:31.006Z",
  "mutations": [
    { "op": "upsert", "entity": "parties",        "id": "…", "rev": 3, "data": { … } },
    { "op": "delete", "entity": "freightEntries", "id": "…", "rev": 7 },
    { "op": "upsert", "entity": "stockDays",      "id": "firmUuid|2026-08-14", "rev": 1, "data": { … } }
  ]
}
```

**Max 500 mutations per request** — chunk on the client. `rev` is your last-known server
revision; `0` or absent means "this is new".

```json
{
  "serverTime": "2026-08-14T09:12:33.412Z",
  "applied":   [ { "entity": "parties", "id": "…", "rev": 4 } ],
  "conflicts": [ { "entity": "purchases", "id": "…", "reason": "REV_MISMATCH", "server": { … } } ],
  "rejected":  [ { "entity": "claims", "id": "…", "code": "CLAIM_IMMUTABLE", "message": "…" } ],
  "serials":   [ { "entity": "freightEntries", "id": "…", "serial": 128 } ]
}
```

You must handle all four arrays:

- **`applied`** — write the returned `rev` back onto your local record.
- **`conflicts`** — the server row is attached as `server`. Surface a merge prompt; do not
  silently retry.
- **`rejected`** — a validation or rule failure. Fix or drop the mutation; retrying unchanged
  will fail again.
- **`serials`** — server-assigned freight serials for entries you created offline. **Store these**;
  it is the only place you learn them.

A push **never fails as a whole because one row was bad**. Mutations are grouped by entity and
each group commits in its own transaction, in dependency order. If a whole group fails (e.g. a
deadlock), every mutation in that group comes back `rejected` with code `GROUP_FAILED` — those
are safe to retry.

### Entity names for push

`parties`, `locations`, `grades`, `companies`, `sources`, `routes`, `baseline`, `stockDays`,
`freightEntries`, `schemeFolders`, `schemes`, `purchases`, `purchasePayments`, `claims`,
`claimCreditNotes`

They are applied **in that order** — `schemeFolders` before `schemes` for the same reason
`companies` comes before `purchases`: a scheme filed under a folder the server has not seen
yet would land unfiled.

Note these are the **push** names. The `changes` object in a pull uses the same names except
that purchase payments and credit notes are inlined into their parents rather than appearing
separately.

`baseline` supports `upsert` only — it cannot be deleted over sync.

### Two entities use a natural key

| Entity | Send as `id` | What comes back |
|---|---|---|
| `stockDays` | `"{firmId}\|{yyyy-MM-dd}"` | the server UUID in `applied[].id` |
| `routes` | `"{partyId}::{locationId}"` | the server UUID in `applied[].id` |

The server resolves the pair and creates the row if absent. **Store the returned UUID** — that
is the key mapping, and after the first successful push you can use the UUID directly.

`purchasePayments` and `claimCreditNotes` mutations need their parent in `data`:
`{ "purchaseId": "…" }` and `{ "claimId": "…" }` respectively.

### Conflict policy by entity — this is the part to get right

| Entity | Policy | What it means for you |
|---|---|---|
| Masters (parties, locations, grades, companies, sources, schemeFolders, routes) | **Last-write-wins** | Your push always applies. Low stakes. |
| `freightEntries`, `purchases` | **Reject on `rev` mismatch** | You **must** send an accurate `rev`. Omitting it on an existing row is treated as a conflict. Show a merge prompt. |
| `stockDays` cells | **Field-level merge** | Cells merge per `(party, grade)`. A stale `rev` does **not** reject — two people filling different parties on the same sheet both succeed. |
| `baseline` | **Reject on mismatch** | Changing it re-rates every later day. |
| `claims` | **Reject on mismatch**, immutable fields always rejected | See §10. |
| `purchasePayments`, `claimCreditNotes` | **Additive** | Inserts never conflict; deletes are idempotent. |

### What must never sync

`activeFirmId`, `hapticsEnabled`, `tableTranspose:*` are **device-local UI state**. Keep them in
local storage only. Syncing them makes one device's UI jump when another is used.

---

## 12. Plans, entitlement & billing

Subscriptions are bought through **Play Billing**; the server's job is to say what
each plan unlocks and to turn a purchase token into an entitlement. All three routes
need a Bearer token but **not** a verified email — someone mid-signup can already
have been charged, and owning money they cannot collect is the worst funnel there is.

| Method | Path | Purpose |
|---|---|---|
| GET | `/plans` | The offer: `{ plans: [{ id, name, description, sku, period, features }] }` |
| GET | `/me/entitlement` | What this user may do: `{ entitlement: {...} }` |
| POST | `/billing/verify` | `{ purchaseToken }` → the fresh `{ entitlement }` |

**No prices, anywhere.** Neither `/plans` nor the entitlement carries one — by
design. Take `sku` (+ Play base plan `monthly`/`yearly`) to Play Billing and let
Play quote the price in the user's currency; a price echoed by our API could only
ever disagree with what Play charges. `sku` values with no price are normal for
grant-only plans.

`features` is `{ adFree, excelExport, maxFirms, maxDevices }`; a limit of **-1**
means unlimited. Entitlement `status` is the server's own: `free`, `active`,
`grace`, `expired`, `cancelled`. Only `active`/`grace` arrive with premium
features attached — the server already lapses anything whose `expiresAt` has
passed, so the client never reasons about expiry itself. `grace` is Play's
payment-retry window and counts as entitled.

**Buying.** On every purchase update (`purchaseStream`), send the purchase token
to `/billing/verify`, then complete the purchase in the store SDK — in that order.
The server verifies the token with Play, **acknowledges it** (Play refunds an
unacknowledged purchase in 3 days), checks the anti-sharing binding, and writes the
entitlement with `source: 'play'`. The call is idempotent, so the client should
verify on *every* purchase event, including `restored` ones from
`restorePurchases()`. Errors worth handling:

- **409 `PURCHASE_ALREADY_LINKED`** — the token belongs to another account.
- **400 `VALIDATION_FAILED`** — Play does not recognise the token (bogus or refund-/fraud-state).
- **502 `PLAY_UNAVAILABLE`** — Google was unreachable; retry later.

Cache the last entitlement on disk and keep trusting it while offline — a dealer in
a godown with no signal must not lose features they paid for. Refresh on app start
and after any purchase event; the server caches 60 s, so this is cheap. The
client-side gates are conveniences only: the server is the authority, and once
billing enforcement is on it rejects over-limit actions regardless of what any
cached entitlement claims.

---

## 13. Import / export

| Method | Path | Returns | Min role |
|---|---|---|---|
| POST | `/firms/{firmId}/import/backup?mode=merge\|replace` | `{ imported, warnings }` | **admin** |
| GET | `/firms/{firmId}/export/backup` | the v3 backup JSON | any member |

Export returns the same v3 JSON shape the on-device backup uses, with a
`Content-Disposition: attachment` header. Only live records are exported.

Import accepts `schemaVersion` **1, 2 and 3** and maps the legacy **integer** enums to strings —
this is the migration path for existing users' on-device backups.

- `?mode=merge` (default) upserts by id.
- `?mode=replace` wipes the firm's existing data first, and **requires `"confirmReplace": true`
  in the request body**. Without it you get a 400. This is destructive — always confirm with
  the user.

The whole payload is validated in a **dry-run pass first**; if anything is structurally wrong,
**nothing is written** and you get a 400 listing up to 50 problems in `details`. A successful
import returns per-entity counts and a `warnings` array of non-fatal notes (dropped unknown
grade references, totals that don't match the formulas, and so on) that are worth showing.

Body cap for this endpoint is **25 MB** (1 MB everywhere else). Send an `Idempotency-Key`.

---

## 14. Rate limits and size caps

Exceeding a limit returns **429 `RATE_LIMITED`** with a **`Retry-After`** header in seconds.
Honour it — back off, don't hammer.

| Endpoint | Limit |
|---|---|
| `POST /auth/signup` | 5 / hour per IP |
| `POST /auth/login` | 10 / 15 min per IP, **and** 5 / 15 min per email |
| `POST /auth/refresh` | 60 / hour per IP and per user |
| `POST /auth/forgot-password` | 10 / hour per IP, **and** 3 / hour per email |
| `POST /freight-entries` | 600 / min per user |
| `POST /sync/push` | 60 / min per device |

Body size: **1 MB** default, **25 MB** for `/import/backup`. Over the cap →
`413 PAYLOAD_TOO_LARGE`.

Pagination caps: list endpoints max `limit=500`; sync pull max `limit=2000`.

---

## 15. Traps worth reading before you start

Ranked by how much time they will cost you if you miss them.

1. **Serialize your token refreshes.** Concurrent `/auth/refresh` calls with the same token
   trip reuse detection and log the user out of every device. One shared in-flight promise.

2. **Don't touch business dates with `Date`.** `date`, `periodFrom`, `windowTo`, `sentOn` are
   `yyyy-MM-dd` strings. Parsing and re-serializing them shifts the day for most of the world.
   Keep them strings end to end.

3. **You compute the freight math; the server only verifies it.** Tolerance ±0.01. If you patch
   `bags`, you must also send the recomputed `totalReimbursed`, `totalCost` and `profit`.

4. **`minPremiumUnit` defaults to `"mt"`, not `"bag"`.** This one bites because every other unit
   field defaults to `bag`. It mirrors a legacy enum index.

5. **A `{billing: 0, dispatch: 0}` cell is deleted, not stored.** The `rows` map is sparse.
   Treat a missing key as zero; never expect a dense party × grade matrix.

6. **Freight serials are server-assigned.** Never generate or guess. Read them from the create
   response or from `serials[]` in a sync push response.

7. **`gradeBags` must sum exactly to `bags`** (±0.01) when present, or you get a 422. Send no
   `gradeBags` key at all if there is no split.

8. **Claims are frozen.** Only `status`, `sentOn`, `schemeName` are editable, and `status` may be
   overridden by the server's auto-transition. Render status from the response.

9. **Master POST returns 200 on an existing id, 201 on a new one.** Both are success. Don't
   treat 200 as an error.

10. **Send `rev` on sync push for freight entries, purchases and claims.** Omitting it on an
    existing row is a `REV_MISMATCH` conflict, not a last-write-wins update.

11. **Pull until `hasMore` is false.** A single pull is not a complete sync.

12. **Handle `409 CURSOR_TOO_OLD`** by resyncing from the beginning. It will happen to any device
    that has been offline for more than 180 days.

13. **`GET /baseline` 404s when unset.** That is the normal new-firm state, not a failure.

14. **Response envelopes vary.** Some endpoints return bare arrays, most wrap in a named key, and
    the master endpoints use the *singular* name. Check the tables above.

15. **Gate your UI on role.** `viewer` cannot write anything. Hide the controls rather than
    letting the user discover it via `403 INSUFFICIENT_ROLE`.

16. **Always log `error.requestId`.** It is how the backend team traces your request.

---

## Appendix: minimal client sketch

```ts
const BASE = "https://cementdesk.sallytion.qzz.io/api/v1";

let accessToken: string | null = null;
let refreshToken: string | null = null;
let refreshing: Promise<void> | null = null;   // the shared in-flight refresh

async function doRefresh(): Promise<void> {
  // Collapse concurrent refreshes into one — see trap #1.
  refreshing ??= (async () => {
    const res = await fetch(`${BASE}/auth/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    });
    if (!res.ok) { accessToken = refreshToken = null; throw new Error("SESSION_LOST"); }
    const { tokens } = await res.json();
    await persistTokens(tokens);            // persist BEFORE using — see §2
    accessToken = tokens.accessToken;
    refreshToken = tokens.refreshToken;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { idempotencyKey?: string; ifMatch?: number } = {},
  isRetry = false,
): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(opts.idempotencyKey ? { "idempotency-key": opts.idempotencyKey } : {}),
      ...(opts.ifMatch !== undefined ? { "if-match": String(opts.ifMatch) } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 204) return null;

  const json = await res.json().catch(() => null);
  if (res.ok) return json;

  const code = json?.error?.code;

  if (res.status === 401 && code === "TOKEN_EXPIRED" && !isRetry) {
    await doRefresh();
    return api(method, path, body, opts, true);   // retry exactly once
  }
  if (res.status === 401) { accessToken = refreshToken = null; throw new AuthLost(code); }

  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after") ?? 1);
    throw new RateLimited(retryAfter);
  }

  throw new ApiError(code, json?.error?.message, json?.error?.details, json?.error?.requestId, json?.server);
}
```

Sync loop, in outline:

```ts
async function syncFirm(firmId: string, deviceId: string) {
  // 1. push local changes, ≤500 at a time
  for (const chunk of chunked(pendingMutations(firmId), 500)) {
    const out = await api("POST", `/firms/${firmId}/sync/push`,
      { deviceId, baseCursor: getCursor(firmId), mutations: chunk },
      { idempotencyKey: uuid() });

    out.applied.forEach(a => markSynced(a.entity, a.id, a.rev));
    out.serials.forEach(s => storeSerial(s.id, s.serial));   // freight serials
    out.conflicts.forEach(c => queueMergePrompt(c));
    out.rejected.forEach(r => handleRejection(r));
  }

  // 2. pull until drained
  let cursor = getCursor(firmId);
  for (;;) {
    let page;
    try {
      page = await api("GET",
        `/firms/${firmId}/sync/pull?limit=1000&deviceId=${deviceId}` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""));
    } catch (e) {
      if (e.code === "CURSOR_TOO_OLD") { cursor = null; clearLocalFirm(firmId); continue; }
      throw e;
    }
    applyChanges(firmId, page.changes);   // upsert by id; deletedAt != null → delete
    cursor = page.nextCursor;
    saveCursor(firmId, cursor);           // store verbatim
    if (!page.hasMore) break;
  }
}
```

---

*Questions, or a shape here that doesn't match what you're seeing? Grab the `requestId` from
the error envelope and send it over — that's the fastest path to an answer.*
