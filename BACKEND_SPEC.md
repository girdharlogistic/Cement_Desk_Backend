# Cement Desk — Backend Specification

**Status:** Draft for implementation. Backend only — the Flutter client is NOT to be modified while
building this. Integration is a separate, later phase.

**Target database:** TiDB (MySQL 8.0 wire-compatible), used for **both** application data and
auth/identity. One cluster, one schema.

**Audience:** the engineer/agent implementing the backend service from scratch.

---

## 0. How to read this document

This spec was written by reading the existing Flutter app end to end. Everything in
§3 (Domain model), §5 (Invariants) and §6 (Schema) is derived from real code, not invented.
Where the current app has an implicit rule that only works because it is single-device, this
document calls it out explicitly and says what the server must do instead. Those are the places
where a naive port will break.

Sections marked **[DECISION]** need a human answer before or during implementation. They are
collected again in §16.

---

## 1. Context: what the app is today

Cement Desk is an **offline-first Android app for Indian cement dealers / depot managers**.
It is currently 100% local: all data lives in **Hive** boxes on the device
(`lib/data/db.dart`). There is no server, no account, no login, no network calls at all.
The only data mobility is a manual JSON backup/restore and CSV/XLSX exports
(`lib/data/export_service.dart`).

The app has three functional modules plus masters:

| Module | Purpose | Key screens |
|---|---|---|
| **Freight** | Per-trip P&L: what the cement company reimburses for freight vs. what the trip actually cost | `features/freight/` |
| **Plus Minus** | Daily stock reconciliation: physical godown stock vs. SAP (company books) vs. each party's running balance | `features/stock/` |
| **Landing** | Purchase invoices, dealer discount schemes, landed cost per bag, claims against cement companies | `features/landing/` |
| **Masters / More** | Parties, locations, grades, companies, sources, schemes, firms, settings | `features/masters/`, `features/landing/setup_tab.dart` |

### 1.1 The tenancy unit is the **Firm**, not the user

This is the single most important structural fact. The app already supports **multiple firms** on
one device. *Every* business record carries a `firmId` and every query filters on the
currently-active firm (`activeFirmIdProvider`). Deleting a firm cascades to every record it owns
(see `FirmsNotifier.delete` in `lib/data/providers.dart`).

The server therefore does **not** need to invent a tenancy model. It needs to:
- add a **User** concept above Firm (which does not exist today), and
- make `firm_id` the mandatory tenancy filter on every single query.

### 1.2 All primary keys are already client-generated UUIDv4

`const uuid = Uuid(); ... id: uuid.v4()` — parties, locations, entries, grades, companies,
sources, purchases, schemes, claims, payments, credit notes, receipts.

**This is a large advantage and must be preserved.** It means an offline client can create records
with final IDs and never needs an ID round-trip from the server. Do not replace these with
auto-increment integers. The server accepts client-supplied UUIDs and treats
`INSERT` of an existing id as an idempotent no-op / update (see §9.4).

Two entities use **composite natural keys** instead:

| Entity | Key format | Source |
|---|---|---|
| `PartyRoute` | `"{partyId}::{locationId}"` | `PartyRoute.key` |
| `StockDay` | `"{firmId}\|{yyyy-MM-dd}"` | `StockDaysNotifier.createDay` |

These become `UNIQUE` constraints server-side (§6).

### 1.3 All business math currently runs on the client, as pure functions

- `lib/core/calc/stock_engine.dart` — `computeDepotLedger()`, a carry-forward fold over all stock days.
- `lib/core/calc/landing_engine.dart` — 1365 lines: scheme evaluation, slab matching, cash discount,
  premium mix, month allocation, claims candidates, opportunities.
- `lib/core/calc/freight_calc.dart` — trip totals and route insight.

These are pure, unit-tested (`test/landing_engine_test.dart`, `test/stock_engine_test.dart`,
`test/freight_calc_test.dart`) and **fast**. See §4.3 for the recommendation on whether to port them.

---

## 2. Goals and non-goals

### 2.1 Goals

1. **Cloud as the source of truth.** Data survives phone loss / reinstall / upgrade.
2. **Accounts.** Sign up, sign in, session management — stored in the same TiDB.
3. **Multi-device.** The same user opens the app on a new phone and sees their data.
4. **Multi-user per firm.** A dealer and their accountant/staff can work on the same firm
   with roles. (Not in the app UI today; the backend must support it from day one because
   retro-fitting authorization is painful.)
5. **Offline-first is preserved.** The app must keep working with no connectivity and reconcile
   later. This is non-negotiable — a depot manager standing in a godown in a low-signal area is
   the primary user.
6. **No data loss on conflict.** Two devices editing the same firm must never silently destroy
   each other's work.
7. **Import path** from the existing local Hive data and from the v3 JSON backup file.

### 2.2 Non-goals (explicitly out of scope for v1)

- Rewriting the calculation engines as a server-side service (see §4.3 — keep them on the client).
- Real-time push / websockets. Pull-based sync is sufficient.
- Analytics warehouse, BI, admin dashboards.
- Payments/billing for the app itself.
- Any change to the Flutter app in this phase.

---

## 3. Domain model (derived from the code)

Complete field-level inventory. Dart source of truth: `lib/data/models.dart` and
`lib/data/landing_models.dart`.

### 3.1 Firm
`lib/data/models.dart` → `class Firm`

| Field | Type | Notes |
|---|---|---|
| `id` | String (UUID) | PK |
| `name` | String | required |

The user must always have ≥ 1 firm (`SettingsScreen` enforces this client-side).

### 3.2 Party
| Field | Type | Notes |
|---|---|---|
| `id` | String (UUID) | PK |
| `firmId` | String | tenancy |
| `code` | String? | the dealer's own S.No, e.g. "18". Nullable, free text (NOT numeric) |
| `name` | String | required |
| `phone` | String? | |
| `order` | int | manual drag-to-reorder position; default 0 |

Sort rule (must be reproduced by any server-side listing): `order` ASC, then numeric value of
`code` (non-numeric → sorts last, rank `1<<20`), then `name` case-insensitive.

### 3.3 DepotLocation
`id`, `firmId`, `name`. Sorted by `name` case-insensitive.

### 3.4 PartyRoute
| Field | Type | Notes |
|---|---|---|
| `firmId` | String | |
| `partyId` | String | part of natural key |
| `locationId` | String | part of natural key |
| `distanceKm` | double | |
| `revenuePerBag` | double | |

**No surrogate `id`.** Key is `"{partyId}::{locationId}"`.
Purpose: *prefill defaults only*. Editing a route must never change an already-saved
`FreightEntry` — the entry stores its own frozen copy of every rate.

### 3.5 FreightEntry
| Field | Type | Notes |
|---|---|---|
| `id` | String (UUID) | PK |
| `firmId` | String | |
| `serial` | int | **per-firm running voucher number, never reused.** See §5.1 |
| `date` | DateTime | normalized to local midnight |
| `partyId`, `locationId` | String | |
| `vehicleNo` | String | uppercased by the client |
| `revenuePerBag` | double | frozen |
| `bags` | double | |
| `totalReimbursed` | double | **stored, not computed on read** |
| `basis` | enum `CostBasis` | `km` = our vehicle, `bag` = self lifting |
| `costRate` | double | ₹/km or ₹/bag depending on `basis` |
| `costUnits` | double | km driven, or bags (mirrored) for self-lifting |
| `otherExpenses` | double | |
| `otherNote` | String | |
| `totalCost` | double | **stored** |
| `profit` | double | **stored** |
| `gradeBags` | Map<String gradeId, double> | optional split; empty map = no split recorded |

Derived: `profitPerBag = profit / bags` (0 when bags = 0).

Formula (`freight_calc.dart`, must be validated server-side):
```
units            = (basis == bag) ? bags : costUnits
totalReimbursed  = revenuePerBag * bags
totalCost        = costRate * units + otherExpenses
profit           = totalReimbursed - totalCost
```

### 3.6 Grade
`id`, `firmId`, `name`, `order` (int), `bagWeightKg` (double, default 50).
Derived: `bagsPerMt = 1000 / bagWeightKg` (fallback 20).
Order drives display order everywhere; reordering rewrites `order` 0..n.

### 3.7 OpeningBaseline
**One per firm.** Keyed by `firmId` in Hive (`AppDb.baseline.get(fid)`).

| Field | Type | Notes |
|---|---|---|
| `firmId` | String | PK |
| `date` | DateTime | "as on" date |
| `physical` | Map<gradeId, double> | godown stock |
| `sap` | Map<gradeId, double> | company-books stock |
| `party` | Map<partyId, Map<gradeId, double>> | each party's opening X Qty |

Every later day's opening is **derived**, never stored (§5.2).

### 3.8 StockDay
| Field | Type | Notes |
|---|---|---|
| `id` | String | `"{firmId}\|{yyyy-MM-dd}"` |
| `firmId` | String | |
| `date` | DateTime | local midnight; **unique per firm** |
| `receipts` | List\<Receipt\> | |
| `rows` | Map<partyId, Map<gradeId, DayCell>> | sparse |

`Receipt` = `{ id (UUID), gradeId, qty (physical), sapQty, ref }`.
`DayCell` = `{ billing, dispatch }`. A cell that becomes `{0,0}` is **removed** from the map
(`StockDay.withCell`) — sparsity is intentional, do not persist zero rows.

### 3.9 Landing module

**Company** — `id`, `firmId`, `name`, `order`.
**Source** — `id`, `firmId`, `name`, `type` (`plant`|`depot`), `order`.

**Purchase**
| Field | Type |
|---|---|
| `id`, `firmId` | String |
| `date` | DateTime |
| `companyId`, `gradeId`, `sourceId` | String |
| `qty` | double (bags) |
| `ratePerBag` | double |
| `invoiceNo` | String |
| `payments` | List\<Payment\> |

Derived (never stored): `billValue = qty * ratePerBag`, `paidAmount = Σ payments.amount`,
`balance = billValue - paidAmount`.

**Payment** — `id` (UUID), `date`, `amount`. Partial payments are normal; each tranche earns its
own cash-discount rate.

**Scheme** — the most complex entity. Models a cement company's discount letter.

| Field | Type | Notes |
|---|---|---|
| `id`, `firmId` | String | |
| `name` | String | free text |
| `companyId` | String | |
| `gradeId` | String? | **null = all grades of the company** |
| `perGrade` | bool | only meaningful when `gradeId == null`. false = pooled (all grades into one number), true = each grade evaluated separately |
| `sourceId` | String? | null = any source |
| `kind` | enum | `fixed` \| `variable` \| `mix` \| `cash` |
| `period` | enum? | `monthly` \| `quarterly` \| `annual` — for fixed/mix |
| `windowFrom`, `windowTo` | DateTime? | variable schemes only, both inclusive |
| `qtyUnit` | enum | `bag` \| `mt` — unit of `Slab.from`; ignored for mix and cash |
| `valueType` | enum | `perBag` \| `perMt` \| `percent` |
| `premiumGradeIds` | List\<String\> | mix only |
| `minPremiumQty` | double | mix only — the gate |
| `minPremiumUnit` | enum | `bag` \| `mt` (default `mt`) |
| `slabs` | List\<Slab\> | auto-sorted by `from`; duplicate `from` rejected |
| `active` | bool | false keeps history without affecting current math |

`Slab` = `{ from: double, value: double }`. `from` means:
- fixed/variable → "this qty and above"
- mix → "this premium %  and above"
- cash → "**within** this many days" (smaller = better rate)

**Claim** — a **frozen** snapshot. See §5.4.

| Field | Type | Notes |
|---|---|---|
| `id`, `firmId` | String | |
| `schemeId` | String | |
| `companyId`, `schemeName` | String | **denormalized on purpose** — survives scheme/company deletion for display and ageing |
| `periodFrom`, `periodTo` | DateTime | |
| `label` | String | e.g. "Jul 2026", "Q1 Apr–Jun" |
| `bags` | double | **frozen** |
| `accrued` | double | **frozen** — never recomputed |
| `status` | enum | `claimable` \| `claimed` \| `received` |
| `sentOn` | DateTime? | |
| `creditNotes` | List\<CreditNote\> | |

`CreditNote` = `{ id (UUID), date, number, amount }`.
Derived: `receivedAmount = Σ amounts`, `pendingAmount = accrued - receivedAmount`.

### 3.10 Settings / meta (the `meta` Hive box)

| Key | Scope today | Scope on server | Notes |
|---|---|---|---|
| `activeFirmId` | device | **device-local, do NOT sync** | which firm the UI is showing |
| `hapticsEnabled` | device | **device-local, do NOT sync** | UI preference |
| `tableTranspose:{id}` | device | **device-local, do NOT sync** | per-table orientation toggle |
| `fyStartMonth` | **global** (default 4 = April) | **must move to per-firm** | drives quarterly/annual scheme windows — a firm-level accounting policy. See **[DECISION D1]** |
| `serialCounters` | Map<firmId, int> | **server-owned** | see §5.1 |

---

## 4. Architecture

### 4.1 Recommended shape

```
Flutter app (unchanged for now)
      │  HTTPS/JSON, bearer token
      ▼
┌──────────────────────────────┐
│  API service (stateless)     │   ← horizontally scalable, no local state
│  - auth                      │
│  - CRUD per entity           │
│  - /sync pull + push         │
│  - import/export             │
└──────────────┬───────────────┘
               │ MySQL protocol, TLS
               ▼
          TiDB cluster
   (app data + identity, one schema)
```

Stateless service. No in-process cache that would break with >1 replica. Sessions live in TiDB
(or Redis if you add it later — not required at this scale).

### 4.2 Stack **[DECISION D2]**

Any of these are fine; pick one and stay consistent. Requirements:
- Mature MySQL driver with **prepared statements and TLS**.
- Transactions with explicit isolation control.
- Migration tooling.

| Option | Driver | Migrations | Note |
|---|---|---|---|
| **Node + TypeScript** (recommended if the team is JS-first) | `mysql2` | `drizzle-kit` / `knex` | Fastest to build; Drizzle's typed schema maps cleanly to the DDL below |
| **Go** | `go-sql-driver/mysql` | `golang-migrate` | Best raw throughput and memory profile |
| **Python (FastAPI)** | `PyMySQL` / `asyncmy` + SQLAlchemy 2.x | `alembic` | Fine; watch async driver maturity |

**Do not use an ORM's auto-migration in production.** Write explicit, reviewed SQL migrations —
TiDB DDL is online but you still want the exact statements in version control.

### 4.3 Where does the business math run? **[DECISION D3 — recommendation: keep it on the client]**

Recommendation: **v1 backend stores and syncs data only. It does not compute scheme benefits,
landed cost, or the stock ledger.**

Reasons, specific to this codebase:
1. The engines are already written, pure, and covered by tests. Porting 1365 lines of subtle
   slab/allocation logic to a second language is the highest-risk, lowest-reward work available.
   Any drift between two implementations shows up as *wrong money* on the dealer's screen.
2. The app must work offline. If the numbers came from the server, the app would be a blank shell
   in a godown with no signal — destroying the product's core value.
3. Everything the engines need (purchases, schemes, grades) is small per firm — a year of data is
   a few thousand rows. The client already computes it in milliseconds.

Consequences the backend **must** respect:
- The server stores **inputs**, and the **stored outputs the client already persists**
  (`FreightEntry.totalCost/profit/totalReimbursed`, `Claim.accrued/bags`). It must not "correct" them.
- The server should still *validate* those stored outputs against the formula (§5.5) and reject
  impossible values, but it must not silently recompute and overwrite.

If later you want server-side reports/exports, port the engines then, behind a clearly versioned
endpoint, and diff against client output on real data before trusting it.

---

## 5. Invariants the backend must enforce

These are the rules the current app relies on. Breaking any of them corrupts real money figures.

### 5.1 Freight serial numbers — **per firm, monotonic, never reused**

Today: `AppDb.nextSerial(firmId)` reads a map, increments, writes. Safe only because there is one
device and one thread.

On the server this is a classic race. Requirements:
- `serial` is unique per `firm_id`.
- Never reused, even after the entry is deleted.
- Must survive concurrent creates from two devices.

**Implementation:** a `firm_counters` row per firm, allocated inside a pessimistic transaction:
```sql
START TRANSACTION;
SELECT freight_serial FROM firm_counters WHERE firm_id = ? FOR UPDATE;
UPDATE firm_counters SET freight_serial = freight_serial + 1 WHERE firm_id = ?;
-- insert entry with the new value
COMMIT;
```
TiDB uses pessimistic transactions by default (since v5.0), so `FOR UPDATE` behaves as expected.

**Offline complication:** an offline client also needs a serial *now*. Two options:

- **(a) Client-provisional, server-authoritative (recommended).** The offline client assigns a
  local provisional serial. On push, the server allocates the real one and returns the mapping;
  the client updates its local row. Requires the client to treat `serial` as server-owned — a
  small, contained change when integration happens.
- **(b) Serial blocks.** Server leases each device a block of 100 serials; the device consumes them
  offline. No renumbering, but leaves gaps when a block is partially used. Gaps are acceptable for
  a voucher number, but confirm with the user — dealers sometimes care about unbroken sequences.

`ensureSerialAtLeast(firmId, max)` in the current code exists to keep the counter ahead of
restored data. The import endpoint (§8.7) must do the same: after import, set the counter to
`MAX(serial)` for that firm.

### 5.2 Stock openings are **derived, never stored**

`computeDepotLedger()` folds forward from the single `OpeningBaseline`. There is exactly one
baseline per firm and every subsequent day's opening comes from the previous day's closing.

Server rules:
- Store `stock_days` and `opening_baselines` as *inputs only*. Never persist a computed opening.
- A stock day is only valid if its date is **strictly after** the baseline date
  (`StockDaysNotifier.createDay` returns "Pick a date after the opening balances date.").
- One sheet per date per firm — `UNIQUE (firm_id, date)`.
- **Changing the baseline date or values silently re-rates every later day.** That is intended
  behaviour, but the endpoint must be explicit about it in its response (e.g. return the count of
  affected days) so the client can warn.

Ledger math (for reference / validation; runs on the client):
```
physicalClosing = physicalOpening + receiptsPhysical - dispatchTotal
sapClosing      = sapOpening      + receiptsSap      - billingTotal
difference      = physicalClosing - sapClosing
xQty(party,grade) = opening + billing - dispatch
gap(grade)      = Σ xQty(all parties, grade) - difference
tallied         = |gap| < 0.0001        // tallyEpsilon
```

### 5.3 Frozen rates on freight entries

`PartyRoute` is prefill-only. When a route's `distanceKm` / `revenuePerBag` changes, **existing
`freight_entries` must not change.** The server must never join to `party_routes` to derive an
entry's rate — the entry's own columns are authoritative.

### 5.4 Claims are immutable snapshots

`Claim.bags` and `Claim.accrued` are frozen at creation. The live engine keeps recomputing forever,
but a credit note is paid against the number on the letter that was sent.

Server rules:
- `PATCH /claims/{id}` may modify **only**: `status`, `sentOn`, `creditNotes`, `schemeName`.
- Attempts to modify `bags`, `accrued`, `periodFrom`, `periodTo`, `label`, `schemeId` → **409**.
- `companyId` and `schemeName` are denormalized deliberately; do not "normalize" them away, and do
  not null them when the scheme or company is deleted.
- Status auto-transition (mirror `ClaimsNotifier.updateClaim`):
  ```
  if receivedAmount >= accrued - 1e-9 and creditNotes not empty → received
  else if status == received (and no longer satisfied)          → sentOn != null ? claimed : claimable
  ```
- Cash schemes never produce claims.

### 5.5 Stored-derivative validation

The client stores computed values. The server should verify them on write and reject clear
corruption (tolerance `0.01`):

| Entity | Check |
|---|---|
| `freight_entries` | `totalReimbursed ≈ revenuePerBag * bags`; `totalCost ≈ costRate * units + otherExpenses`; `profit ≈ totalReimbursed - totalCost` where `units = basis==bag ? bags : costUnits` |
| `freight_entries.gradeBags` | if non-empty, `Σ gradeBags ≈ bags` (the UI enforces "Matched") |
| `purchases` | `qty > 0`, `ratePerBag >= 0`; `Σ payments.amount <= billValue + 0.01` **[DECISION D4 — is overpayment ever legitimate? Currently the UI shows "₹X baaki" and does not block overpay]** |
| `schemes` | `slabs` non-empty when `active`; no duplicate `from`; sorted ascending on write |
| `schemes` (mix) | `premiumGradeIds` non-empty; `minPremiumQty >= 0` |
| `schemes` (variable) | `windowFrom <= windowTo`, both non-null |
| `schemes` (fixed/mix) | `period` non-null |
| `claims` | `accrued >= 0`, `periodFrom <= periodTo` |

### 5.6 Cascade rules (currently done manually in Dart — move to FK / explicit transaction)

From `providers.dart` and `landing_providers.dart`:

| Delete | Cascades to |
|---|---|
| **Firm** | parties, locations, routes, freight entries, grades, companies, sources, purchases, schemes, claims, baseline, stock days, serial counter |
| **Party** | its routes; its row in `opening_baselines.party`; its rows in every `stock_day` |
| **Location** | its routes |
| **Grade** | its figures in baseline (physical/sap/party); its receipts and cells in every stock day. **Note: purchases and schemes referencing the grade are NOT deleted today** — verify this is intended (**[DECISION D5]**) |
| **Company** | its purchases, its schemes, its claims (and orphan claims whose scheme no longer exists) |
| **Scheme** | its claims |
| **Purchase** | its payments |
| **Claim** | its credit notes |

Relational child tables (§6) make most of this free via `ON DELETE CASCADE`. The party/grade →
baseline/stock-day cases become trivial once those maps are child tables — which is the main
argument for normalizing them rather than storing JSON.

### 5.7 Date handling

The client normalizes every business date to **local midnight** (`Fmt.dayOnly`) and serializes with
`toIso8601String()` — producing a local-time string **with no timezone offset**, e.g.
`2026-08-14T00:00:00.000`.

Rules:
- Store business dates (`freight_entries.date`, `purchases.date`, `stock_days.date`,
  `payments.date`, `credit_notes.date`, `claims.period_*`, `schemes.window_*`,
  `opening_baselines.date`) as **`DATE`**, not `DATETIME`. They are calendar days, and the app
  never uses their time component.
- Store audit timestamps (`created_at`, `updated_at`, `deleted_at`) as **`DATETIME(3)` in UTC**.
- Do **not** apply timezone conversion to business dates. The dealer's "14 August" must stay
  14 August regardless of server timezone. Set the connection to a fixed `time_zone = '+00:00'`
  and treat DATE as opaque.
- Reject business dates outside `2000-01-01 .. 2100-01-01` as corruption.

---

## 6. Database schema (TiDB)

### 6.1 TiDB-specific conventions

- **Charset/collation:** `utf8mb4` / `utf8mb4_0900_ai_ci` for names, but IDs use
  `utf8mb4_bin` for exact-match comparison.
- **IDs:** `CHAR(36)` holding lowercase UUIDv4, matching what the client already produces.
  (`BINARY(16)` saves space but makes debugging and the import path painful. At this data scale
  the space is irrelevant — prefer `CHAR(36)`.)
- **Clustered PKs on `(firm_id, id)`** for tenant-scoped tables. In TiDB the clustered index
  determines physical layout, so leading with `firm_id` keeps one firm's rows co-located and makes
  the ubiquitous `WHERE firm_id = ?` a range scan instead of a scatter.
- **Foreign keys:** supported in modern TiDB (experimental from v6.6, GA in the 7.x line).
  **Verify support and behaviour on your exact cluster version before relying on them.** If FKs are
  unavailable or disabled, enforce every cascade in §5.6 inside an explicit application transaction
  instead — the rules are the same either way.
- **Transaction size:** TiDB caps total transaction size (default on the order of 100 MB) and large
  transactions hurt latency. Chunk bulk imports to **500–1000 rows per transaction** (§8.7).
- **No `AUTO_INCREMENT` on tenant tables** — avoid write hotspots. The only sequential value in the
  system is `freight_entries.serial`, which is deliberately serialized through `firm_counters`.

### 6.2 Identity & tenancy

```sql
CREATE TABLE users (
  id             CHAR(36)      NOT NULL,
  email          VARCHAR(255)  NOT NULL,
  email_norm     VARCHAR(255)  NOT NULL,          -- lowercased+trimmed; uniqueness key
  phone          VARCHAR(20)   NULL,              -- E.164, e.g. +919812345678
  password_hash  VARCHAR(255)  NOT NULL,          -- argon2id encoded string
  display_name   VARCHAR(120)  NOT NULL DEFAULT '',
  email_verified TINYINT(1)    NOT NULL DEFAULT 0,
  status         ENUM('active','suspended','deleted') NOT NULL DEFAULT 'active',
  created_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3)   NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_users_email (email_norm),
  UNIQUE KEY uk_users_phone (phone)
);

CREATE TABLE firms (
  id              CHAR(36)     NOT NULL,
  owner_user_id   CHAR(36)     NOT NULL,
  name            VARCHAR(160) NOT NULL,
  fy_start_month  TINYINT      NOT NULL DEFAULT 4,   -- moved off global meta; 1..12
  created_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at      DATETIME(3)  NULL,
  PRIMARY KEY (id) CLUSTERED,
  KEY idx_firms_owner (owner_user_id),
  CONSTRAINT fk_firms_owner FOREIGN KEY (owner_user_id) REFERENCES users(id)
);

CREATE TABLE firm_members (
  firm_id    CHAR(36) NOT NULL,
  user_id    CHAR(36) NOT NULL,
  role       ENUM('owner','admin','member','viewer') NOT NULL DEFAULT 'member',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (firm_id, user_id) CLUSTERED,
  KEY idx_fm_user (user_id),
  CONSTRAINT fk_fm_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE,
  CONSTRAINT fk_fm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE firm_counters (
  firm_id        CHAR(36) NOT NULL,
  freight_serial BIGINT   NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id) CLUSTERED,
  CONSTRAINT fk_fc_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE sessions (
  id                CHAR(36)     NOT NULL,
  user_id           CHAR(36)     NOT NULL,
  refresh_token_hash CHAR(64)    NOT NULL,   -- sha256 hex of the opaque refresh token
  device_id         CHAR(36)     NULL,       -- client-generated, stable per install
  device_label      VARCHAR(120) NOT NULL DEFAULT '',
  user_agent        VARCHAR(255) NOT NULL DEFAULT '',
  ip                VARBINARY(16) NULL,
  expires_at        DATETIME(3)  NOT NULL,
  revoked_at        DATETIME(3)  NULL,
  created_at        DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_used_at      DATETIME(3)  NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_sessions_refresh (refresh_token_hash),
  KEY idx_sessions_user (user_id, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE auth_tokens (          -- email verification, password reset, invites
  id         CHAR(36) NOT NULL,
  user_id    CHAR(36) NULL,
  email_norm VARCHAR(255) NULL,
  purpose    ENUM('verify_email','reset_password','firm_invite') NOT NULL,
  token_hash CHAR(64) NOT NULL,
  payload    JSON NULL,            -- e.g. {"firmId":"...","role":"member"}
  expires_at DATETIME(3) NOT NULL,
  used_at    DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id) CLUSTERED,
  UNIQUE KEY uk_auth_token (token_hash),
  KEY idx_auth_user (user_id, purpose)
);
```

### 6.3 Sync columns — **every tenant table gets these**

```sql
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,          -- soft delete = tombstone for sync
  rev        BIGINT      NOT NULL DEFAULT 1,   -- optimistic concurrency, bumped on every write
  updated_by CHAR(36)    NULL,          -- user id, for audit
```

> **Do not hard-delete tenant rows.** A device that was offline when a record was deleted has no
> other way to learn about it. Tombstones are the mechanism. Purge tombstones older than 180 days
> with a scheduled job (§13.3), and treat a client whose cursor is older than that as needing a
> full resync.

**Important consequence:** because deletes are soft, `UNIQUE` keys on natural keys
(`stock_days (firm_id, date)`, `party_routes (party_id, location_id)`) would block re-creating a
record after deletion. Handle this one of two ways — pick one and apply consistently:
- **(a)** include `deleted_at` in the unique key (`UNIQUE (firm_id, date, deleted_at)`) — NULLs are
  distinct in MySQL semantics so multiple tombstones coexist but only one live row can exist; or
- **(b)** on re-create, resurrect the tombstoned row in place (clear `deleted_at`, bump `rev`).

**(b) is recommended** — it preserves the row's identity and history, and matches what the client
does today (a stock sheet for a date is conceptually the same sheet).

### 6.4 Master tables

```sql
CREATE TABLE parties (
  firm_id CHAR(36) NOT NULL,
  id      CHAR(36) NOT NULL,
  code    VARCHAR(40)  NULL,
  name    VARCHAR(160) NOT NULL,
  phone   VARCHAR(20)  NULL,
  sort_order INT NOT NULL DEFAULT 0,
  -- + sync columns (§6.3)
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_parties_sync (firm_id, updated_at),
  CONSTRAINT fk_parties_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE locations (
  firm_id CHAR(36) NOT NULL,
  id      CHAR(36) NOT NULL,
  name    VARCHAR(160) NOT NULL,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_locations_sync (firm_id, updated_at),
  CONSTRAINT fk_locations_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE grades (
  firm_id       CHAR(36) NOT NULL,
  id            CHAR(36) NOT NULL,
  name          VARCHAR(80) NOT NULL,
  sort_order    INT NOT NULL DEFAULT 0,
  bag_weight_kg DECIMAL(8,3) NOT NULL DEFAULT 50.000,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_grades_sync (firm_id, updated_at),
  CONSTRAINT fk_grades_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE party_routes (
  firm_id         CHAR(36) NOT NULL,
  id              CHAR(36) NOT NULL,     -- NEW surrogate id; natural key kept unique below
  party_id        CHAR(36) NOT NULL,
  location_id     CHAR(36) NOT NULL,
  distance_km     DECIMAL(10,3) NOT NULL DEFAULT 0,
  revenue_per_bag DECIMAL(12,4) NOT NULL DEFAULT 0,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY uk_route (firm_id, party_id, location_id),
  KEY idx_routes_sync (firm_id, updated_at),
  CONSTRAINT fk_routes_firm  FOREIGN KEY (firm_id)  REFERENCES firms(id)  ON DELETE CASCADE,
  CONSTRAINT fk_routes_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
);
```
> `party_routes` gains a surrogate `id` because the client's `"partyId::locationId"` string key is
> awkward as a PK and unstable if a party is ever re-pointed. The natural key stays enforced by
> `uk_route`. The sync layer maps between them (§9.6).

### 6.5 Freight

```sql
CREATE TABLE freight_entries (
  firm_id          CHAR(36) NOT NULL,
  id               CHAR(36) NOT NULL,
  serial           BIGINT   NOT NULL,
  date             DATE     NOT NULL,
  party_id         CHAR(36) NOT NULL,
  location_id      CHAR(36) NOT NULL,
  vehicle_no       VARCHAR(32)  NOT NULL DEFAULT '',
  revenue_per_bag  DECIMAL(12,4) NOT NULL DEFAULT 0,
  bags             DECIMAL(14,3) NOT NULL DEFAULT 0,
  total_reimbursed DECIMAL(16,2) NOT NULL DEFAULT 0,
  basis            ENUM('km','bag') NOT NULL DEFAULT 'km',
  cost_rate        DECIMAL(12,4) NOT NULL DEFAULT 0,
  cost_units       DECIMAL(14,3) NOT NULL DEFAULT 0,
  other_expenses   DECIMAL(14,2) NOT NULL DEFAULT 0,
  other_note       VARCHAR(500)  NOT NULL DEFAULT '',
  total_cost       DECIMAL(16,2) NOT NULL DEFAULT 0,
  profit           DECIMAL(16,2) NOT NULL DEFAULT 0,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY uk_entry_serial (firm_id, serial),
  KEY idx_entries_date (firm_id, date),
  KEY idx_entries_party (firm_id, party_id, date),
  KEY idx_entries_sync (firm_id, updated_at),
  CONSTRAINT fk_fe_firm  FOREIGN KEY (firm_id)  REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE freight_entry_grades (   -- the gradeBags map
  firm_id  CHAR(36) NOT NULL,
  entry_id CHAR(36) NOT NULL,
  grade_id CHAR(36) NOT NULL,
  bags     DECIMAL(14,3) NOT NULL,
  PRIMARY KEY (firm_id, entry_id, grade_id) CLUSTERED,
  CONSTRAINT fk_feg_entry FOREIGN KEY (entry_id) REFERENCES freight_entries(id) ON DELETE CASCADE
);
```
> `freight_entry_grades` rows are **owned by** the entry: they carry no independent sync columns and
> are always written in the same transaction as the parent. The parent's `rev`/`updated_at` covers them.
> The same ownership rule applies to every child table below.

### 6.6 Stock (Plus Minus)

```sql
CREATE TABLE opening_baselines (
  firm_id CHAR(36) NOT NULL,          -- one per firm
  date    DATE     NOT NULL,
  -- + sync columns
  PRIMARY KEY (firm_id) CLUSTERED,
  CONSTRAINT fk_ob_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE opening_baseline_stock (   -- the physical{} and sap{} maps
  firm_id  CHAR(36) NOT NULL,
  grade_id CHAR(36) NOT NULL,
  physical DECIMAL(16,3) NOT NULL DEFAULT 0,
  sap      DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, grade_id) CLUSTERED,
  CONSTRAINT fk_obs_firm  FOREIGN KEY (firm_id)  REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obs_grade FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
);

CREATE TABLE opening_baseline_party (   -- the party{}{} nested map
  firm_id  CHAR(36) NOT NULL,
  party_id CHAR(36) NOT NULL,
  grade_id CHAR(36) NOT NULL,
  x_qty    DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, party_id, grade_id) CLUSTERED,
  CONSTRAINT fk_obp_firm  FOREIGN KEY (firm_id)  REFERENCES opening_baselines(firm_id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_party FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE,
  CONSTRAINT fk_obp_grade FOREIGN KEY (grade_id) REFERENCES grades(id)  ON DELETE CASCADE
);

CREATE TABLE stock_days (
  firm_id CHAR(36) NOT NULL,
  id      CHAR(36) NOT NULL,       -- NEW uuid; client's "firmId|date" maps via uk below
  date    DATE     NOT NULL,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY uk_stockday_date (firm_id, date),
  KEY idx_sd_sync (firm_id, updated_at),
  CONSTRAINT fk_sd_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE stock_receipts (
  firm_id      CHAR(36) NOT NULL,
  id           CHAR(36) NOT NULL,
  stock_day_id CHAR(36) NOT NULL,
  grade_id     CHAR(36) NOT NULL,
  qty          DECIMAL(16,3) NOT NULL DEFAULT 0,   -- physical
  sap_qty      DECIMAL(16,3) NOT NULL DEFAULT 0,
  ref          VARCHAR(120)  NOT NULL DEFAULT '',
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_sr_day (stock_day_id),
  CONSTRAINT fk_sr_day   FOREIGN KEY (stock_day_id) REFERENCES stock_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_sr_grade FOREIGN KEY (grade_id)     REFERENCES grades(id)     ON DELETE CASCADE
);

CREATE TABLE stock_day_cells (        -- the rows{partyId}{gradeId} sparse matrix
  firm_id      CHAR(36) NOT NULL,
  stock_day_id CHAR(36) NOT NULL,
  party_id     CHAR(36) NOT NULL,
  grade_id     CHAR(36) NOT NULL,
  billing      DECIMAL(16,3) NOT NULL DEFAULT 0,
  dispatch     DECIMAL(16,3) NOT NULL DEFAULT 0,
  PRIMARY KEY (firm_id, stock_day_id, party_id, grade_id) CLUSTERED,
  CONSTRAINT fk_sdc_day   FOREIGN KEY (stock_day_id) REFERENCES stock_days(id) ON DELETE CASCADE,
  CONSTRAINT fk_sdc_party FOREIGN KEY (party_id)     REFERENCES parties(id)    ON DELETE CASCADE,
  CONSTRAINT fk_sdc_grade FOREIGN KEY (grade_id)     REFERENCES grades(id)     ON DELETE CASCADE
);
```
> **Sparsity rule:** a cell with `billing = 0 AND dispatch = 0` must be **deleted**, not stored —
> mirroring `StockDay.withCell`. Enforce this in the write path.
>
> These child tables are the reason to normalize rather than store JSON: deleting a party or grade
> then cleans up baseline and every stock day automatically, replacing ~60 lines of manual Dart
> cleanup (`PartiesNotifier.delete`, `GradesNotifier.delete`) with FK cascades.

### 6.7 Landing

```sql
CREATE TABLE companies (
  firm_id CHAR(36) NOT NULL,
  id      CHAR(36) NOT NULL,
  name    VARCHAR(160) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_companies_sync (firm_id, updated_at),
  CONSTRAINT fk_co_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE sources (
  firm_id CHAR(36) NOT NULL,
  id      CHAR(36) NOT NULL,
  name    VARCHAR(160) NOT NULL,
  type    ENUM('plant','depot') NOT NULL DEFAULT 'plant',
  sort_order INT NOT NULL DEFAULT 0,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_sources_sync (firm_id, updated_at),
  CONSTRAINT fk_so_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE purchases (
  firm_id      CHAR(36) NOT NULL,
  id           CHAR(36) NOT NULL,
  date         DATE     NOT NULL,
  company_id   CHAR(36) NOT NULL,
  grade_id     CHAR(36) NOT NULL,
  source_id    CHAR(36) NOT NULL,
  qty          DECIMAL(16,3) NOT NULL,          -- bags
  rate_per_bag DECIMAL(12,4) NOT NULL,
  invoice_no   VARCHAR(80) NOT NULL DEFAULT '',
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_pur_date (firm_id, date),
  KEY idx_pur_company (firm_id, company_id, date),
  KEY idx_pur_sync (firm_id, updated_at),
  CONSTRAINT fk_pur_firm    FOREIGN KEY (firm_id)    REFERENCES firms(id)     ON DELETE CASCADE,
  CONSTRAINT fk_pur_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE purchase_payments (
  firm_id     CHAR(36) NOT NULL,
  id          CHAR(36) NOT NULL,
  purchase_id CHAR(36) NOT NULL,
  date        DATE     NOT NULL,
  amount      DECIMAL(16,2) NOT NULL,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_pp_purchase (purchase_id, date),
  CONSTRAINT fk_pp_purchase FOREIGN KEY (purchase_id) REFERENCES purchases(id) ON DELETE CASCADE
);

CREATE TABLE schemes (
  firm_id           CHAR(36) NOT NULL,
  id                CHAR(36) NOT NULL,
  name              VARCHAR(200) NOT NULL,
  company_id        CHAR(36) NOT NULL,
  grade_id          CHAR(36) NULL,                 -- NULL = all grades
  per_grade         TINYINT(1) NOT NULL DEFAULT 0,
  source_id         CHAR(36) NULL,                 -- NULL = any source
  kind              ENUM('fixed','variable','mix','cash') NOT NULL DEFAULT 'fixed',
  period            ENUM('monthly','quarterly','annual') NULL,
  window_from       DATE NULL,
  window_to         DATE NULL,
  qty_unit          ENUM('bag','mt') NOT NULL DEFAULT 'bag',
  value_type        ENUM('perBag','perMt','percent') NOT NULL DEFAULT 'perBag',
  min_premium_qty   DECIMAL(16,3) NOT NULL DEFAULT 0,
  min_premium_unit  ENUM('bag','mt') NOT NULL DEFAULT 'mt',
  active            TINYINT(1) NOT NULL DEFAULT 1,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_sch_company (firm_id, company_id),
  KEY idx_sch_sync (firm_id, updated_at),
  CONSTRAINT fk_sch_firm    FOREIGN KEY (firm_id)    REFERENCES firms(id)     ON DELETE CASCADE,
  CONSTRAINT fk_sch_company FOREIGN KEY (company_id) REFERENCES companies(id) ON DELETE CASCADE
);

CREATE TABLE scheme_slabs (
  firm_id    CHAR(36) NOT NULL,
  scheme_id  CHAR(36) NOT NULL,
  slab_from  DECIMAL(16,4) NOT NULL,
  slab_value DECIMAL(16,4) NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, slab_from) CLUSTERED,   -- also enforces "no duplicate from"
  CONSTRAINT fk_slab_scheme FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE
);

CREATE TABLE scheme_premium_grades (   -- mix schemes only
  firm_id   CHAR(36) NOT NULL,
  scheme_id CHAR(36) NOT NULL,
  grade_id  CHAR(36) NOT NULL,
  PRIMARY KEY (firm_id, scheme_id, grade_id) CLUSTERED,
  CONSTRAINT fk_spg_scheme FOREIGN KEY (scheme_id) REFERENCES schemes(id) ON DELETE CASCADE,
  CONSTRAINT fk_spg_grade  FOREIGN KEY (grade_id)  REFERENCES grades(id)  ON DELETE CASCADE
);

CREATE TABLE claims (
  firm_id     CHAR(36) NOT NULL,
  id          CHAR(36) NOT NULL,
  scheme_id   CHAR(36) NOT NULL,
  company_id  CHAR(36) NOT NULL,        -- denormalized on purpose (§5.4)
  scheme_name VARCHAR(200) NOT NULL,    -- denormalized on purpose
  period_from DATE NOT NULL,
  period_to   DATE NOT NULL,
  label       VARCHAR(60) NOT NULL DEFAULT '',
  bags        DECIMAL(16,3) NOT NULL DEFAULT 0,   -- FROZEN
  accrued     DECIMAL(16,2) NOT NULL DEFAULT 0,   -- FROZEN
  status      ENUM('claimable','claimed','received') NOT NULL DEFAULT 'claimable',
  sent_on     DATE NULL,
  -- + sync columns
  PRIMARY KEY (firm_id, id) CLUSTERED,
  UNIQUE KEY uk_claim_period (firm_id, scheme_id, period_from),
  KEY idx_claims_sync (firm_id, updated_at),
  CONSTRAINT fk_cl_firm FOREIGN KEY (firm_id) REFERENCES firms(id) ON DELETE CASCADE
);

CREATE TABLE claim_credit_notes (
  firm_id  CHAR(36) NOT NULL,
  id       CHAR(36) NOT NULL,
  claim_id CHAR(36) NOT NULL,
  date     DATE NOT NULL,
  number   VARCHAR(80) NOT NULL DEFAULT '',
  amount   DECIMAL(16,2) NOT NULL,
  PRIMARY KEY (firm_id, id) CLUSTERED,
  KEY idx_ccn_claim (claim_id, date),
  CONSTRAINT fk_ccn_claim FOREIGN KEY (claim_id) REFERENCES claims(id) ON DELETE CASCADE
);
```

> **Note on `claims.scheme_id`:** deliberately **not** an FK with cascade. The client deletes claims
> when a scheme is deleted (`SchemesNotifier.delete`), but a claim must remain readable if the
> scheme row vanishes for any other reason — hence the denormalized `company_id` / `scheme_name`.
> Implement the scheme→claims delete explicitly in the service layer, not via FK.

> **`uk_claim_period`** encodes the client's duplicate guard: `claimCandidates()` skips a period
> when `existingClaims.any(c.schemeId == s.id && dayOnly(c.periodFrom) == dayOnly(from))`.

### 6.8 Sync bookkeeping

```sql
CREATE TABLE sync_state (
  user_id     CHAR(36) NOT NULL,
  device_id   CHAR(36) NOT NULL,
  firm_id     CHAR(36) NOT NULL,
  cursor      DATETIME(3) NOT NULL,     -- last successfully delivered server watermark
  last_sync_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_id, device_id, firm_id) CLUSTERED
);

CREATE TABLE idempotency_keys (
  key_hash    CHAR(64)  NOT NULL,
  user_id     CHAR(36)  NOT NULL,
  endpoint    VARCHAR(120) NOT NULL,
  response_code SMALLINT NOT NULL,
  response_body JSON NULL,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (key_hash) CLUSTERED,
  KEY idx_idem_created (created_at)
);
```

---

## 7. Auth & authorization

### 7.1 Sign-up / sign-in **[DECISION D6 — email+password, phone OTP, or both?]**

Recommendation for the user base (Indian cement dealers, phone-first, may not check email):
**support both, ship email+password first.**

- **Password hashing:** argon2id (`memory ≥ 64 MB, iterations ≥ 3, parallelism 1`).
  bcrypt (cost ≥ 12) is an acceptable fallback. **Never** raw SHA/MD5.
- **Email normalization:** lowercase + trim into `email_norm`; uniqueness is on `email_norm`.
- **Phone:** store E.164 (`+91…`). If OTP is added, use a 6-digit code, 5-minute TTL, max 5
  attempts, rate-limited per phone and per IP.

### 7.2 Tokens

| Token | Type | TTL | Storage |
|---|---|---|---|
| Access | JWT (HS256 or RS256), claims: `sub`, `sid`, `iat`, `exp` | **15 min** | client memory / secure storage |
| Refresh | Opaque 32-byte random, base64url | **60 days**, sliding | client secure storage; **sha256 hash** in `sessions` |

- Refresh rotation: every refresh issues a new refresh token and revokes the old one.
- **Reuse detection:** if a already-revoked refresh token is presented, revoke **all** sessions for
  that user and force re-login. This is the standard defence against stolen refresh tokens.
- Logout revokes the session row. `POST /auth/logout-all` revokes every session for the user.

> Long refresh TTL is deliberate: this app is used offline for days at a stretch. A dealer must not
> be logged out because they were in a low-signal area for a week.

### 7.3 Authorization model

Every request carries a firm scope. Resolution order:
1. Extract `sub` (user id) from the access token.
2. Read `firm_id` from the route (`/firms/{firmId}/...`) — **never** from the request body.
3. Verify a `firm_members` row exists for `(firm_id, user_id)` and is not soft-deleted.
4. Check the role against the operation.

| Role | Read | Create/Update | Delete | Manage members | Delete firm |
|---|---|---|---|---|---|
| `owner` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `admin` | ✓ | ✓ | ✓ | ✓ | ✗ |
| `member` | ✓ | ✓ | ✓ | ✗ | ✗ |
| `viewer` | ✓ | ✗ | ✗ | ✗ | ✗ |

**Hard rule:** every SQL statement touching a tenant table includes `firm_id = ?` in its
`WHERE` clause. No exceptions. Add a repository-layer guard (a query builder that refuses to emit
a tenant-table query without a firm filter) and an integration test that greps for violations.

### 7.4 Rate limits (per IP and per account)

| Endpoint | Limit |
|---|---|
| `POST /auth/signup` | 5 / hour / IP |
| `POST /auth/login` | 10 / 15 min / IP, 5 / 15 min / email; exponential backoff after 5 failures |
| `POST /auth/refresh` | 60 / hour / user |
| `POST /auth/forgot-password` | 3 / hour / email |
| `POST /sync/push` | 60 / min / device |
| default authenticated | 600 / min / user |

---

## 8. API surface

Base path: `/api/v1`. JSON in / JSON out. `Authorization: Bearer <access token>`.

### 8.1 Conventions

- **Idempotency:** all `POST` that create data accept `Idempotency-Key: <uuid>`. Replaying the same
  key within 24 h returns the original response from `idempotency_keys`.
- **Optimistic concurrency:** `PATCH`/`PUT` accept `If-Match: <rev>`. Mismatch → `409` with the
  current server row so the client can merge.
- **Pagination:** cursor-based. `?limit=200&cursor=<opaque>`; response carries `nextCursor`.
  Max `limit` 500.
- **Field names:** JSON uses the **client's camelCase names** (`firmId`, `ratePerBag`,
  `bagWeightKg`, `revenuePerBag`, `gradeBags`…) so the eventual Flutter integration is a
  transport swap, not a rename exercise. The DB uses snake_case; map at the boundary.
- **Enums on the wire:** send **strings** (`"km"`, `"perBag"`, `"quarterly"`), not the Dart
  ordinal ints that the local JSON backup uses. The import endpoint (§8.7) is the one place that
  must accept the legacy integer form — see the mapping table in §11.2.

### 8.2 Auth

```
POST   /auth/signup            { email, password, displayName, firmName? } → { user, tokens, firm? }
POST   /auth/login             { email, password, deviceId?, deviceLabel? } → { user, tokens }
POST   /auth/refresh           { refreshToken } → { tokens }
POST   /auth/logout            { refreshToken } → 204
POST   /auth/logout-all                          → 204
GET    /auth/me                                  → { user, firms:[{id,name,role,fyStartMonth}] }
PATCH  /auth/me                { displayName?, phone? } → { user }
POST   /auth/change-password   { currentPassword, newPassword } → 204   (revokes other sessions)
POST   /auth/forgot-password   { email } → 204   (always 204 — never reveal existence)
POST   /auth/reset-password    { token, newPassword } → 204
POST   /auth/verify-email      { token } → 204
GET    /auth/sessions                            → [{ id, deviceLabel, lastUsedAt, current }]
DELETE /auth/sessions/{id}                       → 204
```

`signup` with a `firmName` creates the user, the firm, the `firm_members` owner row, and the
`firm_counters` row in **one transaction** — mirroring `FirstRunScreen`, which asks only for a firm
name.

### 8.3 Firms & members

```
GET    /firms                                    → [{ id, name, fyStartMonth, role }]
POST   /firms                  { name, fyStartMonth? } → { firm }
PATCH  /firms/{firmId}         { name?, fyStartMonth? } → { firm }
DELETE /firms/{firmId}                           → 204   (owner only; soft-delete + cascade §5.6)

GET    /firms/{firmId}/members                   → [{ userId, email, displayName, role }]
POST   /firms/{firmId}/members/invite  { email, role } → { inviteId }
POST   /firms/{firmId}/members/accept  { token } → { firm }
PATCH  /firms/{firmId}/members/{userId} { role } → 204
DELETE /firms/{firmId}/members/{userId}          → 204
```

Guard: a firm must always keep **≥ 1 owner**; refuse the last owner's removal/demotion with `409`.
Guard: a user must always keep **≥ 1 firm** (mirrors the client's rule) — refuse deleting the last
firm with `409`, or auto-create a replacement. **[DECISION D7]**

### 8.4 Masters

Uniform CRUD, all under `/firms/{firmId}`:

```
GET    /firms/{firmId}/parties          ?includeDeleted=false
POST   /firms/{firmId}/parties          { id?, code?, name, phone?, order? }
PATCH  /firms/{firmId}/parties/{id}
DELETE /firms/{firmId}/parties/{id}
POST   /firms/{firmId}/parties/reorder  { ids: [...] }      → rewrites order 0..n

… identical shape for: locations, grades, companies, sources
```

`POST` accepts an optional client-supplied `id` (UUIDv4). If absent, the server generates one.
`reorder` exists because the client persists explicit drag-order (`PartiesNotifier.reorder`,
`GradesNotifier.reorder`) — doing it as N individual PATCHes would be N round-trips and a partial-
failure hazard; do it in one transaction.

```
GET    /firms/{firmId}/routes                       → [{ id, partyId, locationId, distanceKm, revenuePerBag }]
PUT    /firms/{firmId}/routes                       { partyId, locationId, distanceKm, revenuePerBag }  (upsert)
DELETE /firms/{firmId}/routes/{partyId}/{locationId}
```

### 8.5 Freight

```
GET    /firms/{firmId}/freight-entries   ?from&to&partyId&locationId&limit&cursor
POST   /firms/{firmId}/freight-entries   { id?, date, partyId, locationId, vehicleNo,
                                           revenuePerBag, bags, basis, costRate, costUnits,
                                           otherExpenses, otherNote, gradeBags?,
                                           totalReimbursed, totalCost, profit }
                                          → { entry }   -- server assigns `serial` (§5.1)
PATCH  /firms/{firmId}/freight-entries/{id}
DELETE /firms/{firmId}/freight-entries/{id}
GET    /firms/{firmId}/freight-entries/summary ?from&to&partyId
                                          → { totalReimbursed, totalCost, netProfit,
                                              profitPerBag, entryCount, byLocation:[…] }
```

`summary` mirrors the Freight Logs stat cards. It is a pure aggregate over stored columns — safe to
compute server-side because nothing is re-derived, only summed.

### 8.6 Stock and Landing

```
GET    /firms/{firmId}/baseline                  → { date, physical:{}, sap:{}, party:{} }
PUT    /firms/{firmId}/baseline                  { date, physical, sap, party }
                                                 → { baseline, affectedDayCount }

GET    /firms/{firmId}/stock-days                ?from&to
GET    /firms/{firmId}/stock-days/{date}         → { day with receipts[] and rows{}{} }
POST   /firms/{firmId}/stock-days                { date }        → 409 if exists / before baseline
PUT    /firms/{firmId}/stock-days/{date}/cells   { partyId, gradeId, billing, dispatch }
POST   /firms/{firmId}/stock-days/{date}/receipts { id?, gradeId, qty, sapQty, ref }
DELETE /firms/{firmId}/stock-days/{date}/receipts/{receiptId}
DELETE /firms/{firmId}/stock-days/{date}

GET    /firms/{firmId}/purchases                 ?from&to&companyId&gradeId&limit&cursor
POST   /firms/{firmId}/purchases                 { id?, date, companyId, gradeId, sourceId,
                                                   qty, ratePerBag, invoiceNo, payments? }
PATCH  /firms/{firmId}/purchases/{id}
DELETE /firms/{firmId}/purchases/{id}
POST   /firms/{firmId}/purchases/{id}/payments   { id?, date, amount }
DELETE /firms/{firmId}/purchases/{id}/payments/{paymentId}

GET    /firms/{firmId}/schemes                   ?companyId&active
POST   /firms/{firmId}/schemes                   { …full scheme incl. slabs[], premiumGradeIds[] }
PATCH  /firms/{firmId}/schemes/{id}
POST   /firms/{firmId}/schemes/{id}/activate     { active: bool }
DELETE /firms/{firmId}/schemes/{id}              -- also deletes its claims (§5.6)

GET    /firms/{firmId}/claims                    ?status&companyId
POST   /firms/{firmId}/claims                    { id?, schemeId, companyId, schemeName,
                                                   periodFrom, periodTo, label, bags, accrued }
PATCH  /firms/{firmId}/claims/{id}               { status?, sentOn?, schemeName? }   -- §5.4 only
POST   /firms/{firmId}/claims/{id}/credit-notes  { id?, date, number, amount }
DELETE /firms/{firmId}/claims/{id}/credit-notes/{cnId}
DELETE /firms/{firmId}/claims/{id}
```

`PUT /stock-days/{date}/cells` with `billing == 0 && dispatch == 0` **deletes** the cell (§6.6).

### 8.7 Import / export

```
POST /firms/{firmId}/import/backup   multipart or JSON body = the v3 backup file
                                     ?mode=replace|merge     → { imported:{…counts}, warnings:[] }
GET  /firms/{firmId}/export/backup                           → the same v3 JSON shape
```

The import endpoint is the migration path for every existing user and must:
1. Accept `schemaVersion` **1, 2 and 3** (the client's `restoreFromJson` handles all three).
2. Map legacy **integer enums** → strings (§11.2).
3. Scope records with an empty `firmId` to the target firm (the v1 single-firm case).
4. Re-key stock days and routes to the new PK scheme (§9.6).
5. Set `firm_counters.freight_serial = MAX(serial)` for the firm (mirrors `ensureSerialAtLeast`).
6. Run in **chunked transactions** (500–1000 rows) — a full year of data can exceed TiDB's
   transaction size limit in one shot.
7. Be **idempotent** by `Idempotency-Key`, and validate the whole payload **before** writing
   anything (dry-run pass, then commit pass).

`?mode=replace` wipes the firm's existing data first (equivalent to today's restore, which replaces
everything). `?mode=merge` upserts by id. Default should be `replace` only with explicit
confirmation in the request body (`{"confirmReplace": true}`) — this is a destructive operation.

---

## 9. Sync protocol

This is the heart of the backend. Get it wrong and dealers lose entries.

### 9.1 Model: per-firm, cursor-based, two-phase

```
   PUSH  local changes  ──►  server assigns authoritative rev/updated_at
   PULL  since cursor   ◄──  server returns everything changed after the cursor
```

Sync is **per firm**, not per user — a user with three firms syncs each independently, and a
device only syncs the firms it has opened.

### 9.2 Pull

```
GET /firms/{firmId}/sync/pull?cursor=<ISO8601 UTC>&limit=1000
```
Response:
```json
{
  "serverTime": "2026-08-14T09:12:33.412Z",
  "nextCursor": "2026-08-14T09:12:31.006Z",
  "hasMore": false,
  "changes": {
    "parties":        [ { …row…, "rev": 4, "deletedAt": null } ],
    "locations":      [],
    "grades":         [],
    "routes":         [],
    "freightEntries": [],
    "baseline":       null,
    "stockDays":      [],
    "companies":      [], "sources": [], "purchases": [], "schemes": [], "claims": []
  }
}
```

Rules:
- `cursor` is **exclusive on the low end**: return rows with `updated_at > cursor`.
- Tombstones (`deletedAt != null`) are included — that is how deletes propagate.
- Parents come with their children inlined (a `stockDay` carries its `receipts` and `rows`;
  a `purchase` carries its `payments`). Children have no independent cursor.
- `nextCursor` is the **max `updated_at` actually returned**, not `serverTime` — otherwise a row
  written during the request window is skipped forever.
- If `hasMore` is true, the client immediately pulls again with `nextCursor`.
- **Clock safety:** never let the client's clock choose the cursor. The cursor is an opaque value
  the server issued.

> **The stale-cursor case:** if `cursor` is older than the tombstone retention window (§13.3),
> respond `409 { "code": "CURSOR_TOO_OLD" }`. The client must then do a full resync
> (`cursor=1970-01-01T00:00:00Z`) and reconcile locally.

### 9.3 Push

```
POST /firms/{firmId}/sync/push
Idempotency-Key: <uuid>
{
  "deviceId": "…",
  "baseCursor": "2026-08-14T09:12:31.006Z",
  "mutations": [
    { "op":"upsert", "entity":"parties",        "id":"…", "rev": 3, "data": { … } },
    { "op":"delete", "entity":"freightEntries", "id":"…", "rev": 7 },
    { "op":"upsert", "entity":"stockDays",      "id":"…", "rev": 1, "data": { …incl children… } }
  ]
}
```
Response:
```json
{
  "serverTime": "…",
  "applied":  [ { "entity":"parties", "id":"…", "rev": 4 } ],
  "conflicts":[ { "entity":"purchases", "id":"…", "reason":"REV_MISMATCH", "server": { …row… } } ],
  "rejected": [ { "entity":"claims", "id":"…", "code":"CLAIM_IMMUTABLE", "message":"…" } ],
  "serials":  [ { "entity":"freightEntries", "id":"…", "serial": 128 } ]
}
```

Rules:
- The whole push is processed in **one transaction per entity group**, ordered by dependency
  (§9.5). If any mutation in a group fails validation, that group rolls back; other groups still
  apply. Report per-mutation outcomes — never fail the whole batch for one bad row.
- Cap `mutations` at **500 per request**; larger batches are chunked by the client.
- `rev` is the client's last-known server revision. `rev: 0` or absent = "this is new".
- `serials` returns server-assigned freight serials (§5.1 option a).

### 9.4 Conflict resolution **[DECISION D8]**

Recommended policy, per entity class:

| Entity class | Policy | Why |
|---|---|---|
| Masters (parties, locations, grades, companies, sources, routes) | **Last-write-wins** on `updated_at` | Low-stakes; name edits |
| `freight_entries`, `purchases` | **Reject on `rev` mismatch**, return server row, let the client show a merge prompt | These are money records — silent overwrite is unacceptable |
| `stock_day_cells` | **Field-level merge**: cells are independent; apply per `(party, grade)` cell | Two people filling different parties on the same sheet must both succeed |
| `opening_baselines` | **Reject on mismatch** | Changing it re-rates every later day |
| `claims` | **Reject on mismatch**; immutable fields always rejected (§5.4) | Frozen by design |
| `purchase_payments`, `claim_credit_notes` | **Additive** — an insert never conflicts; deletes are idempotent | Append-only ledgers |

The `stock_day_cells` field-level merge is worth the extra work: the realistic multi-user scenario
in a depot is exactly "two staff entering different parties' figures on the same day".

### 9.5 Dependency order

Apply upserts in this order and deletes in the exact reverse:

```
firms → grades → parties → locations → companies → sources
      → routes → baseline(+children)
      → stockDays(+receipts, +cells)
      → freightEntries(+gradeBags)
      → schemes(+slabs, +premiumGrades)
      → purchases(+payments)
      → claims(+creditNotes)
```

### 9.6 Key mapping (client key → server key)

Two entities change key shape. The **server** owns the mapping; the client keeps sending what it has
today, and the sync layer translates. Document this clearly for the integration phase.

| Entity | Client key | Server key | Mapping rule |
|---|---|---|---|
| `StockDay` | `"{firmId}\|{yyyy-MM-dd}"` | `id` UUID + `UNIQUE(firm_id, date)` | On push, look up by `(firm_id, date)`; create with a new UUID if absent. Return the server `id` in the response so the client can store it. |
| `PartyRoute` | `"{partyId}::{locationId}"` | `id` UUID + `UNIQUE(firm_id, party_id, location_id)` | Same pattern, keyed on the pair. |

### 9.7 What must NOT sync

`activeFirmId`, `hapticsEnabled`, `tableTranspose:*` are device-local UI state. Syncing them would
make one device's UI jump when another device is used. Keep them in Hive only.

---

## 10. Error format

Single shape for every error:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Human-readable, safe to show a dealer",
    "details": [ { "field": "bags", "code": "MUST_BE_POSITIVE", "message": "Bags must be greater than 0" } ],
    "requestId": "01J…"
  }
}
```

| HTTP | `code` values |
|---|---|
| 400 | `VALIDATION_FAILED`, `MALFORMED_JSON` |
| 401 | `UNAUTHENTICATED`, `TOKEN_EXPIRED`, `TOKEN_REVOKED` |
| 403 | `FORBIDDEN`, `INSUFFICIENT_ROLE`, `NOT_A_FIRM_MEMBER` |
| 404 | `NOT_FOUND` |
| 409 | `REV_MISMATCH`, `DUPLICATE_KEY`, `CLAIM_IMMUTABLE`, `CURSOR_TOO_OLD`, `STOCK_DAY_EXISTS`, `DAY_BEFORE_BASELINE`, `LAST_OWNER`, `LAST_FIRM` |
| 422 | `BUSINESS_RULE_VIOLATION` (e.g. gradeBags don't sum to bags) |
| 429 | `RATE_LIMITED` (include `Retry-After`) |
| 500 | `INTERNAL` (never leak SQL or stack traces) |

`requestId` must appear in both the response and the server log line for that request.

---

## 11. Type & enum mapping

### 11.1 Numeric types

The Dart models use `double` everywhere. Money must not be stored as binary floating point.

| Concept | Dart | SQL | Rationale |
|---|---|---|---|
| Bags / quantities | `double` | `DECIMAL(16,3)` | fractional bags occur in stock reconciliation |
| MT | derived | not stored | `qty * bagWeightKg / 1000`, computed |
| ₹ per bag / per km rates | `double` | `DECIMAL(12,4)` | 4 dp headroom for percent-type slab values |
| ₹ amounts | `double` | `DECIMAL(16,2)` | |
| Distance km | `double` | `DECIMAL(10,3)` | |
| Bag weight kg | `double` | `DECIMAL(8,3)` | |
| Slab `from` / `value` | `double` | `DECIMAL(16,4)` | `from` may be MT (60.000) or % (20.5) or days (5) |

On the wire, send these as JSON **numbers** (not strings) so the client's `(j['x'] as num).toDouble()`
keeps working unchanged. Watch precision on the server side: parse into a decimal type, not a float.

### 11.2 Enum mapping (legacy int ↔ wire string)

The local JSON backup stores enum **indexes**. The API uses strings. The import endpoint must map:

| Enum | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| `CostBasis` | `km` | `bag` | | |
| `SourceType` | `plant` | `depot` | | |
| `SchemeKind` | `fixed` | `variable` | `mix` | `cash` |
| `SchemePeriod` | `monthly` | `quarterly` | `annual` | |
| `QtyUnit` | `bag` | `mt` | | |
| `ValueType` | `perBag` | `perMt` | `percent` | |
| `ClaimStatus` | `claimable` | `claimed` | `received` | |

> Note the default for `Scheme.minPremiumUnit` is index **1** (`mt`), not 0 — see
> `landing_models.dart:370`. Getting this wrong silently changes which mix schemes pass their gate.

---

## 12. Scale & capacity

Realistic sizing, derived from the actual record shapes.

**Per firm per year** (an active dealer): ~1,500 freight entries, ~350 stock days
(× ~15 parties × ~4 grades ≈ 20k cells), ~1,200 purchases, ~30 schemes, ~50 claims.
Roughly **25–30k rows/year/firm**, on the order of **10–20 MB** including indexes.

| Firms | Rows/yr | Data/yr (with indexes + tombstones) |
|---|---|---|
| 100 | ~3 M | ~2 GB |
| 1,000 | ~30 M | ~20 GB |
| 10,000 | ~300 M | ~200 GB |

At 1,000 active firms the write rate is a handful of writes per second — trivial for TiDB. Size the
cluster for **storage and index locality**, not throughput. A single small TiDB Cloud cluster
comfortably covers the first few thousand firms.

Latency targets: p95 < 150 ms for CRUD, p95 < 800 ms for a 1,000-row `sync/pull`, p95 < 2 s for a
500-mutation `sync/push`.

---

## 13. Operations

### 13.1 Config (env vars)
```
DATABASE_URL / TIDB_HOST, TIDB_PORT, TIDB_USER, TIDB_PASSWORD, TIDB_DATABASE
TIDB_TLS=true                    # TiDB Cloud requires TLS
JWT_SECRET or JWT_PRIVATE_KEY / JWT_PUBLIC_KEY
ACCESS_TOKEN_TTL=15m  REFRESH_TOKEN_TTL=60d
ARGON2_MEMORY_KB=65536  ARGON2_ITERATIONS=3
SMTP_* (verification / reset mail)
TOMBSTONE_RETENTION_DAYS=180
LOG_LEVEL, SENTRY_DSN (optional)
```
Never commit secrets. Fail fast at boot if any required var is missing.

### 13.2 Connection pool
Pool size ≈ `4 × vCPU`, cap 50 per replica. Set a statement timeout (5 s for CRUD, 30 s for
import). Always use **prepared statements** — TiDB benefits from plan cache reuse.

### 13.3 Scheduled jobs
| Job | Cadence | Action |
|---|---|---|
| Tombstone purge | daily | hard-delete rows with `deleted_at < now() - 180d` |
| Session cleanup | daily | delete expired/revoked sessions older than 30 d |
| Auth token cleanup | hourly | delete used/expired `auth_tokens` |
| Idempotency cleanup | daily | delete keys older than 24 h |
| Backup verification | weekly | restore the latest backup into a scratch schema and run row counts |

### 13.4 Observability
- Structured JSON logs with `requestId`, `userId`, `firmId`, `route`, `durationMs`, `status`.
  **Never log** passwords, tokens, or full request bodies of auth endpoints.
- Metrics: request rate/latency/error by route; sync push conflict rate; pull batch size;
  DB pool saturation; slow query count.
- Alerts: 5xx rate > 1% over 5 min; p95 latency > 1 s; conflict rate > 5%; DB connection failures.

### 13.5 Backups
TiDB Cloud managed backups + **an independent logical dump** (per-firm JSON in the v3 backup shape)
to object storage weekly. The logical dump matters because it can be restored into the app itself,
not just into a database.

---

## 14. Security checklist

- [ ] TLS everywhere; HSTS on the API domain.
- [ ] Parameterized queries only — no string-built SQL anywhere.
- [ ] `firm_id` filter on every tenant query, enforced at the repository layer + tested.
- [ ] Never trust `firmId`/`userId` from a request body — derive from the token and the route.
- [ ] argon2id password hashing; no password ever logged or returned.
- [ ] Refresh-token rotation with reuse detection.
- [ ] Rate limiting per §7.4.
- [ ] Request body size cap (1 MB normal, 25 MB for `/import/backup`).
- [ ] Response size cap / forced pagination.
- [ ] CORS locked to known origins (the mobile app doesn't need CORS; an admin web UI would).
- [ ] No stack traces or SQL text in client-visible errors.
- [ ] Account enumeration prevented on signup/forgot-password (uniform responses and timing).
- [ ] Dependency scanning in CI.
- [ ] A **user data export and delete** path (a dealer's data is their own; also a compliance need).

---

## 15. Testing requirements

The instruction is to test this thoroughly before integration. Concretely:

### 15.1 Unit
- Every validation rule in §5.5, both pass and fail cases.
- Enum mapping in both directions, including the `minPremiumUnit` default = `mt` trap.
- Date handling: local-midnight ISO strings without offset parse to the right `DATE`;
  no timezone drift across a DST-free but offset-shifted server (run the suite with
  `TZ=UTC`, `TZ=Asia/Kolkata`, and `TZ=America/Los_Angeles` — all must produce identical rows).

### 15.2 Integration (against a real TiDB, not a MySQL stand-in)
TiDB differs from MySQL in FK behaviour, transaction size limits and isolation details.
Test against the actual target version.

- Full CRUD per entity with tenancy enforcement: user A must never read or write firm B's rows.
  Write an explicit test that attempts it for **every** endpoint.
- Every cascade in §5.6, verifying orphan counts are zero afterwards.
- Claim immutability: attempts to PATCH `accrued`/`bags`/`periodFrom` → 409.
- Stock day guards: duplicate date → 409; date ≤ baseline date → 409; zero-cell deletes the row.
- Freight entry validation: mismatched `profit` rejected; `gradeBags` not summing to `bags` rejected.
- Scheme validation: duplicate slab `from` rejected; variable without window rejected;
  fixed without period rejected; mix without premium grades rejected.

### 15.3 Concurrency (the highest-risk area)
- **Serial allocation:** 100 concurrent `POST /freight-entries` for one firm → serials are exactly
  1..100, no duplicates, no gaps. Run it 20 times.
- **Two devices, one firm:** interleaved push/pull cycles converge to identical state.
- **Same-row conflict:** two clients PATCH the same purchase with the same `rev` → exactly one
  succeeds, the other gets 409 with the current server row.
- **Stock cell merge:** two clients write different `(party, grade)` cells of the same day
  concurrently → both survive.
- **Idempotency:** the same `Idempotency-Key` replayed 10× creates exactly one row.

### 15.4 Sync correctness (property/fuzz style)
Model-based test: maintain an in-memory "expected" state, apply a random sequence of
create/update/delete operations across 3 simulated devices with random offline windows, sync, and
assert all devices plus the server converge. Run with a fixed seed set in CI, plus a nightly
random-seed run.

Specific cases to include:
- A device offline for 10 days, then a large push (>500 mutations, forcing chunking).
- A delete on device A while device B edits the same row offline.
- A cursor older than the tombstone window → `CURSOR_TOO_OLD` → full resync recovers correctly.

### 15.5 Data migration
Take a **real v3 backup JSON** exported from the current app (ask the user for one, with permission)
and import it. Then export from the API and diff against the original: every id, amount and date
must round-trip. Also test the v1 and v2 legacy shapes.

### 15.6 Load
- 1,000 firms × 1 year of synthetic data loaded; verify query plans on the hot paths
  (`EXPLAIN ANALYZE` on the sync pull and the freight/purchases list) show index range scans,
  not full table scans.
- 200 concurrent sync clients sustained for 10 minutes; p95 within §12 targets, zero errors.

---

## 16. Decisions needed **[collected]**

| # | Question | Recommendation |
|---|---|---|
| **D1** | `fyStartMonth` is global today. Move to per-firm, or per-user? | **Per-firm.** It is an accounting policy of the business entity, and a user may hold firms with different FYs. |
| **D2** | Language/framework? | Node+TypeScript if the team is JS-first; Go if throughput/footprint matters more. |
| **D3** | Port the calculation engines to the server? | **No, not in v1.** Keep them on the client (§4.3). |
| **D4** | Is overpayment on a purchase legitimate (`Σ payments > billValue`)? | Ask the user. The current UI does not block it — if legitimate, only warn, never reject. |
| **D5** | Deleting a grade currently leaves purchases/schemes referencing it intact. Intended? | Probably yes (historical purchases must survive), but confirm — the FKs in §6.7 assume grade deletion should be **blocked** when purchases reference it, which is safer. |
| **D6** | Auth method: email+password, phone OTP, or both? | Both eventually; ship **email+password** first, add phone OTP once the flow is stable. |
| **D7** | Can a user delete their last firm? | Refuse with `409 LAST_FIRM`, mirroring the client's rule. |
| **D8** | Conflict policy per §9.4 acceptable? | Yes — reject-on-conflict for money records, LWW for masters, field-merge for stock cells. |
| **D9** | Freight serial when offline: server-authoritative renumbering, or leased blocks with gaps? | **Server-authoritative** unless dealers require gapless vouchers — ask the user, this is a business-practice question. |
| **D10** | Data residency — must data stay in India? | Ask. If yes, pin the TiDB Cloud region accordingly before any production data lands. |

---

## 17. Suggested build order

1. **Foundation** — project skeleton, config, TiDB connection, migration tooling, health check,
   structured logging, error envelope.
2. **Auth** — users, sessions, signup/login/refresh/logout, password reset, rate limits. Test hard;
   everything else depends on it.
3. **Firms & membership** — firms, `firm_members`, `firm_counters`, role checks, the tenancy guard
   at the repository layer.
4. **Masters CRUD** — parties, locations, grades, companies, sources, routes (+ reorder).
5. **Freight** — entries with serial allocation (the first genuinely tricky piece), summary.
6. **Landing** — purchases + payments, schemes + slabs, claims + credit notes, with all
   immutability and validation rules.
7. **Stock** — baseline, stock days, receipts, cells, with the sparsity and ordering guards.
8. **Import/export** — the v3 backup path. Validates the entire model against real data.
9. **Sync** — pull, then push, then conflict handling, then the fuzz suite.
10. **Hardening** — load tests, scheduled jobs, observability, backup verification.

Steps 1–3 gate everything. Step 8 is the best early proof that the schema is right — it round-trips
a real dealer's year of data before any sync complexity is added.

---

## Appendix A — source-of-truth file map

| Concern | File |
|---|---|
| Core models | `lib/data/models.dart` |
| Landing models | `lib/data/landing_models.dart` |
| Hive boxes, migration, serial counter | `lib/data/db.dart` |
| State + all mutation/cascade logic | `lib/data/providers.dart`, `lib/data/landing_providers.dart` |
| Backup/restore JSON (schema v3) | `lib/data/export_service.dart` |
| Stock ledger fold | `lib/core/calc/stock_engine.dart` |
| Scheme / landed-cost engine | `lib/core/calc/landing_engine.dart` |
| Freight math | `lib/core/calc/freight_calc.dart` |
| Date/number formatting, `dayOnly`, `dayKey` | `lib/core/formatters.dart` |
| Existing engine tests (behaviour reference) | `test/*.dart` |
