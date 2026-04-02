# secret-party-sync — Full Project Context

## What this is

A Cloudflare Worker that syncs ticket and invitation data from the **Secret Party API** into **Airtable**. The goal is to keep Airtable (the team's operational database) up to date with whatever is happening in Secret Party (the ticketing platform) without manual data entry.

The event is **Big Stick Shindig 2026 (BSS'26)**.

---

## The Big Picture

Secret Party is the source of truth for tickets and invitations. Airtable is where the team does all their work — tracking attendees, sponsors, wristbands, logistics, etc. This worker bridges the two by:

1. Running automatically every 5 minutes (cron)
2. Available to trigger manually via an Airtable button automation

Currently only syncing **tickets** (not invitations — disabled intentionally because there are 10,000+ invitations and we're working within the Cloudflare free plan's 50 subrequest limit).

---

## Deployment

| | |
|---|---|
| **Worker URL** | https://secret-party-sync.dangles.workers.dev |
| **Cloudflare account** | dangles@take3presents.com |
| **Account ID** | e5344b6ea83eafd3e476f25942d8326c |
| **Cloudflare plan** | Free (50 subrequest limit per invocation) |
| **Cron** | `*/5 * * * *` — active and running |
| **Deploy command** | `npm run deploy` |
| **Check auth** | `npx wrangler whoami` |
| **Tail live logs** | `npx wrangler tail` |

---

## Secrets

All secrets are set as Cloudflare Worker secrets via `wrangler secret put`. Local values live in `.dev.vars` (gitignored). Secrets **cannot be read back** from Cloudflare once set — these values are the source of truth.

| Secret | Value |
|---|---|
| `SECRET_PARTY_API_KEY` | *(stored in Cloudflare — see `.dev.vars` locally)* |
| `AIRTABLE_API_KEY` | *(stored in Cloudflare — see `.dev.vars` locally)* |
| `WEBHOOK_SECRET` | *(stored in Cloudflare — see `.dev.vars` locally)* |

To reset a secret: `npx wrangler secret put <NAME>`

---

## Airtable Setup

| | |
|---|---|
| **Base ID** | `appgvcig9jwAhim6W` |
| **Tickets/Invitations table (test)** | `{{API TEST}}` (`tblYlEp61232FQgsF`) |
| **Production table** | `BSS'26` (`tblVGGdO9QrRYi50x`) — NOT yet switched to |
| **Sync State table** | `{{Sync State}}` (`tblT06K1k450mZ6q2`) |

### `{{Sync State}}` table fields

Every sync run (cron or manual) creates a new row here. This is pure append-only log history — nothing is ever updated, only inserted.

| Field | Type | Purpose |
|---|---|---|
| `Endpoint` | text | `tickets` or `invitations` |
| `Cursor` | text | The `next_updated_after` value to use on the NEXT run |
| `Triggered By` | single select | `scheduled` or `manual` |
| `Synced At` | dateTime | When this sync ran (UTC) |
| `Status` | single select | `success` (green) or `failed` (red) |
| `Error` | text | Error message if failed, blank if success |
| `Records Fetched` | number | How many records SP returned this run |
| `Tickets Created` | number | Net new records added to Airtable |
| `Tickets Updated` | number | Existing records matched + updated in Airtable |
| `Invitations Created` | number | Reserved for when invitations sync is re-enabled |
| `Invitations Updated` | number | Reserved for when invitations sync is re-enabled |
| `Record Type` | single select | Obsolete — was used before logging refactor, no longer written |

**Important:** There is one old cursor-only row (has `Endpoint` + `Cursor` but no `Status`, `Synced At`, etc.) from before the logging refactor. It should be deleted — it's no longer used. `getCursor` reads the most recent row where `Cursor` is not empty, sorted by `Synced At` desc.

### `{{API TEST}}` table

This is a copy of the real `BSS'26` table used for testing the sync before going to production. It has all the same SP fields. The merge/dedup key is `SP ID` — a plain text field. Airtable's native `performUpsert` matches on this field to create or update.

**SP fields currently mapped** (see `src/config.js` for full FIELD_MAP):
- `SP ID`, `Ticket Code`, `Invitation Code`
- `First Name`, `Last Name`, `Email from SP`, `Phone`
- `SP Stage`, `SP Status`, `SP Invites Per`
- `SP Purchase Price`, `SP Total`
- `SP Is Checked In`, `SP Checkin At`
- `SP Transfer Status`, `SP Transferee First Name`, `SP Transferee Last Name`, `SP Transferee Email`
- `SP Created At`, `SP Updated At`
- `SP Product Name` (nested: `product.name`)
- `SP Invitation ID`

**SP fields NOT yet mapped** (in SP API but not written to Airtable):
- `promotion_code` → `Promo Code` field exists in Airtable but is `multipleSelects` type — needs to be changed to `singleLineText` first, then add to FIELD_MAP
- `transferer_first_name` + `transferer_last_name` → `Transfer From Name` field
- `transferer_email` → `Transferred From Email` field

---

## How the Sync Works

### Entry points (`src/index.js`)
- **Cron:** `scheduled()` handler calls `runSync(..., 'scheduled')`
- **Webhook:** `fetch()` handler — accepts `POST /sync` with `x-webhook-secret` header, calls `runSync(..., 'manual')`
- All other routes return 404

### Core flow (`src/sync.js`)
1. `runSync()` calls `syncEndpoint('tickets', ...)` — invitations disabled for now
2. `syncEndpoint()`:
   - Reads cursor from most recent `{{Sync State}}` row via `getCursor()`
   - Fetches records from SP API with `updated_after=cursor` (null = full sync)
   - Computes `nextCursor` from `meta.next_updated_after`, nudges +1s if unchanged
   - Upserts records into Airtable in batches of 10 via `upsertRecords()`
   - Writes log row via `logSync()` — success or failure, with counts + cursor
   - If error thrown, logs `failed` row then re-throws (so webhook returns 500)

### Cursor logic
- Cursor = ISO-8601 timestamp used as `updated_after` filter on SP API
- Stored on the log row, read back by sorting `{{Sync State}}` by `Synced At` desc
- If SP returns `next_updated_after` equal to cursor sent → nudge +1 second (avoids infinite loop on boundary records)
- Cursor is written AFTER upserts succeed. If upserts fail, next run retries with same cursor

### Subrequest budget (free plan = 50/invocation)
Each fetch to any external API = 1 subrequest. Budget breakdown per run:
- 1 → read cursor from Sync State
- N → upsert batches (10 records each = ceil(records/10) requests)
- 1 → write log row
- **Max safe records per run: ~480** (50 - 2 overhead = 48 upsert requests × 10 = 480)
- Full sync of 1,191 tickets = ~120 upsert requests = always fails on free plan
- **This is fine** — the cron retries every 5 min. Each failed run logs the failure. Once incremental (post-initial-sync), runs stay well under the limit.

---

## Manual Sync (Airtable Button)

**Endpoint:** `POST https://secret-party-sync.dangles.workers.dev/sync`
**Required header:** `x-webhook-secret: <WEBHOOK_SECRET>`

To test manually from terminal:
```bash
curl -X POST https://secret-party-sync.dangles.workers.dev/sync \
  -H "x-webhook-secret: <WEBHOOK_SECRET>"
```

### Airtable automation setup
- Trigger: Button field clicked (in `{{API TEST}}` or `BSS'26` table)
- Action: Run script
- In the script sidebar under **Secrets**, add:
  - Name: `webhookSecret`
  - Value: `<WEBHOOK_SECRET value from .dev.vars>`

### Airtable automation script (current working version)
```javascript
const webhookSecret = await input.secret('webhookSecret');

const response = await fetch('https://secret-party-sync.dangles.workers.dev/sync', {
    method: 'POST',
    headers: {
        'x-webhook-secret': webhookSecret,
    },
});

if (!response.ok) {
    const text = await response.text();
    console.log('Error: ' + response.status + ' ' + text);
    return;
}

const result = await response.json();

if (result.ok) {
    console.log('Sync complete!');
    console.log('Tickets — created: ' + result.summary.tickets.created + ', updated: ' + result.summary.tickets.updated);
} else {
    console.log('Sync failed: ' + result.error);
}
```

**Notes on Airtable scripting:**
- `input.secret()` is the correct API — NOT `input.config.text()` (that doesn't exist)
- `output.text()` does NOT work in automation scripts — use `console.log()` instead
- `input`, `output`, `console` are all global — no imports needed

---

## File Structure

```
src/
  index.js        — Worker entry point. fetch() + scheduled() handlers
  sync.js         — Core sync logic: syncEndpoint(), runSync()
  airtable.js     — Airtable helpers: upsertRecords(), getCursor(), logSync()
  secretparty.js  — SP API helper: fetchRecords()
  config.js       — BASES, TABLES, MERGE_FIELDS, FIELD_MAP constants
  backfill.js     — One-time local script to patch SP fields onto existing records
wrangler.toml     — Cloudflare Worker config (cron schedule, compat flags)
.dev.vars         — Local secrets for `npm run dev` (gitignored — DO NOT COMMIT)
.dev.vars.example — Template with secret names (no values)
CLAUDE.md         — Earlier shorter context doc (superseded by this file)
PROJECT.md        — This file
```

---

## SP API Reference

Base URL: `https://api.secretparty.io/secret`

| Endpoint | Description |
|---|---|
| `GET /tickets` | All tickets. Supports `?updated_after=ISO8601` |
| `GET /invitations` | All invitations. Supports `?updated_after=ISO8601` |

Response shape:
```json
{
  "data": [ ...records ],
  "meta": {
    "updated_after": "...",
    "next_updated_after": "...",
    "returned_count": 123
  }
}
```

SP returns ALL matching records in a single response (no pagination). With no cursor, this is the full dataset.

**Cursor behaviour (confirmed by SP dev):**
- If no records changed, `returned_count` is `0` and `next_updated_after` **echoes your input** — the cursor does not advance.
- All timestamps are ISO-8601 (e.g. `2026-03-16T21:12:15.000Z`).
- Treat all records as upserts keyed on `id`.

**SP ticket fields** (full list from API):
`id`, `product_id`, `invitation_id`, `code`, `first_name`, `last_name`, `status`, `stage`, `invites_per`, `created_at`, `updated_at`, `purchase_price`, `surcharge_fee`, `service_fee`, `processing_fee`, `total`, `transfer_fee`, `transfer_requires_payment`, `transferee_first_name`, `transferee_last_name`, `transfer_status`, `email`, `phone`, `transferee_email`, `invitation_code`, `sales_organizer_revenue_amount`, `is_checked_in`, `checkin_updated_at`, `total_unlocked_by_count`, `promotion_code`, `transferer_first_name`, `transferer_last_name`, `transferer_email`, `product` (nested: `id`, `name`, `type`, `is_transfer_allowed`), `invitation` (nested object)

SP has **1,191 tickets** and **10,271 invitations** as of April 2026.

---

## History / What Happened So Far

1. Built worker from scratch with cron + webhook trigger
2. Deployed to Cloudflare free plan under dangles account
3. First sync ran and **created duplicates** — existing Airtable records didn't have `SP ID` so upsert couldn't match them and created new rows instead
4. Ran `backfill.js` to stamp SP IDs on all existing records by matching on `Ticket Code` / `Invitation Code` — 747 records matched
5. Updated backfill to patch ALL SP field values (not just SP ID) — ran again, 898 records patched (151 more = duplicates from bad first sync)
6. Added `{{Sync State}}` table with sync log rows
7. Refactored: cursor now lives on the log row — one unified row per run instead of separate cursor config record + log record
8. Added `Status`, `Error`, `Records Fetched` fields to log
9. Disabled invitations sync (10k+ records, too many subrequests for free plan)
10. Added cursor nudge (+1s) to handle SP boundary bug
11. Confirmed SP API bug: 2 specific tickets always returned regardless of cursor
12. Added client-side cursor filter in `sync.js` — drops SP records where `updated_at <= cursor`, eliminating the phantom `Tickets Updated: 2` noise
13. Added `SP Transferer First Name`, `SP Transferer Last Name`, `SP Transferer Email` fields to Airtable and mapped in `config.js`
14. Hardened `backfill.js` — added `--table` flag, `--dry-run` mode, rate limiting, and retry on 429
15. Ran backfill against `{{API TEST}}` — 900/900 records matched and patched with full SP field set including transferer data

---

## Still To Do

- [ ] **Clean up ~151 duplicate records** in `{{API TEST}}` — leftover from the bad first sync. Identify by finding records with duplicate SP IDs and delete the extras manually in Airtable
- [ ] **Delete old cursor-only row** in `{{Sync State}}` — has `Endpoint` + `Cursor` but no `Status`/`Synced At`. Leftover from before logging refactor
- [ ] **Map `Promo Code`** — change field type from `multipleSelects` → `singleLineText` in Airtable, then add `promotion_code` to `FIELD_MAP.tickets` in `src/config.js` and redeploy
- [ ] **Switch to production table** — change `TABLES.tickets` in `src/config.js` from `{{API TEST}}` to `BSS'26` (`tblVGGdO9QrRYi50x`), run `node src/backfill.js --table "BSS'26" --dry-run` then live, redeploy worker
- [ ] **Re-enable invitations sync** — currently disabled in `runSync()`. May need Cloudflare paid plan ($5/mo, raises limit to 1000 subrequests)
- [ ] **Remove `Record Type` field** from `{{Sync State}}` — no longer written, just clutter
- [ ] **Compare SP transferer fields vs existing `Transfer From Name` / `Transferred From Email`** fields in Airtable — once data looks good in the SP* fields, decide whether to map directly or keep separate

---

## Known Bugs / Quirks

### SP API returns 2 tickets on every incremental sync regardless of cursor
Tickets `X8DAD4` (ID: `KlRpVwXP6X`) and `DMDT5M` (ID: `k0RywEkD67`) are always returned by the SP API even when the cursor is set past their `updated_at` timestamps. SP's `next_updated_after` also returns a value *earlier* than the cursor we sent.

**Mitigation (in `src/sync.js`):** After fetching from SP, records are filtered client-side — only records where `updated_at > cursor` are upserted. The 2 stale tickets fail this check and are silently dropped. `Records Fetched` and `Tickets Updated` in the log now reflect only genuinely changed records. Bug is in the SP API, not our code.

---

## Airtable Access

There are two ways to access Airtable directly:

**1. Airtable MCP tool (preferred)**
The Airtable MCP server is configured globally in `~/.claude/mcp.json` and is available in every Claude Code window/project automatically — no setup needed. It connects to `https://mcp.airtable.com/mcp` using a separate PAT (`pat3SZAr048ltVJjx...`). Tools appear as `mcp__airtable__*`. Use these for reading/writing Airtable data interactively.

Note: the MCP PAT (`pat3SZAr048ltVJjx...`) is different from the Worker's PAT (see .dev.vars). Both should have access to the BSS'26 base. If you hit permission errors through the MCP, check that token still has the right scopes.

**2. Direct REST API via curl**
The Worker's `AIRTABLE_API_KEY` (see .dev.vars) can also be used directly with `curl` against `https://api.airtable.com/v0/<baseId>/<tableId>`. Useful as a fallback or for one-off queries.

---

## Known Gotchas

- **`SP ID` must stay as plain text or number** — Airtable's `performUpsert` won't work on formula, lookup, or rollup fields
- **Airtable counts matched records as "updated"** even if no values changed — `Tickets Updated: 2` in the log ≠ actual data change
- **`null` / `undefined` SP fields are skipped** — `mapRecord()` only writes fields that have a value. A null SP field won't overwrite an existing Airtable value (intentional — preserves manual edits)
- **50 subrequest limit on free plan** — each external API call counts. 10 records per Airtable upsert batch. Stay aware when re-enabling invitations
- **Secrets are write-only in Cloudflare** — can't be read back after setting. Values stored in `.dev.vars` are the only copy
- **Airtable `performUpsert` creates if no match** — if `SP ID` is blank on an Airtable record, every sync will create a new duplicate instead of updating. Always ensure `SP ID` is populated before going live on a new table
- **`getCursor` sorts by `Synced At`** — if there are rows without a `Synced At` value (like the old cursor-only row), the sort may be unreliable. Delete that row.
