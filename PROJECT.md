# secret-party-sync — Full Project Context

## What this is

A Cloudflare Worker that syncs ticket and invitation data from the **Secret Party API** into **Airtable**. The goal is to keep Airtable (the team's operational database) up to date with whatever is happening in Secret Party (the ticketing platform) without manual data entry.

The event is **Big Stick Shindig 2026 (BSS'26)**.

---

## Current State (as of April 2026)

- Worker is **live and syncing** — tickets + invitations, every 5 minutes, incremental via cursor
- Tickets syncing into **`BSS'26`** (production) — 747 records backfilled, incremental sync active
- Invitations syncing into **`Current Invite List`** — 10,272+ records backfilled, incremental sync active
- All SP fields mapped for both endpoints (objects/arrays stored as JSON in long text fields)
- Add-ons filtered out — only `product.type === 'ticket'` records are synced/backfilled
- On sync error, cursor is preserved so next run auto-retries the same window
- GitHub auto-deploy is configured — push to `main` = deployed
- Manual sync via Airtable button automation is working

---

## The Big Picture

Secret Party is the source of truth for tickets and invitations. Airtable is where the team does all their work — tracking attendees, sponsors, wristbands, logistics, etc. This worker bridges the two by:

1. Running automatically every 5 minutes (cron)
2. Available to trigger manually via an Airtable button automation

Syncing both **tickets** (into `BSS'26`) and **invitations** (into `Current Invite List`). Initial loads were done via local backfill scripts; the Worker handles incremental updates only, keeping well within the free plan's 50 subrequest limit.

---

## Deployment

| | |
|---|---|
| **Worker URL** | https://secret-party-sync.dangles.workers.dev |
| **Cloudflare account** | dangles@take3presents.com |
| **Account ID** | e5344b6ea83eafd3e476f25942d8326c |
| **Cloudflare plan** | Free (50 subrequest limit per invocation) |
| **Cron** | `*/5 * * * *` — active and running |
| **Deploy command** | Push to `main` on GitHub — do NOT run `npm run deploy` directly |
| **Check auth** | `npx wrangler whoami` |
| **Tail live logs** | `npx wrangler tail` |

### GitHub + Auto-deploy

- **Repo:** https://github.com/brianthomas17/secret-party-sync (private)
- **Auto-deploy:** Every push to `main` triggers `.github/workflows/deploy.yml` which deploys to Cloudflare via `cloudflare/wrangler-action@v3`
- **GitHub secret required:** `CLOUDFLARE_API_TOKEN` — already set in repo secrets
- **Bottom line:** Push to GitHub = deployed to production. **Do not run `npm run deploy` directly** — all deploys should go through GitHub so there's a record of what was deployed and when.

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
| **Tickets table (production)** | `BSS'26` (`tblVGGdO9QrRYi50x`) |
| **Invitations table** | `Current Invite List` (`tblKgwXnpqWjf8Z8q`) |
| **Sync State table** | `{{Sync State}}` (`tblT06K1k450mZ6q2`) |
| **Test table (retired)** | `{{API TEST}}` (`tblYlEp61232FQgsF`) — no longer used by worker |

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
| `Invitations Created` | number | Net new invitation records added |
| `Invitations Updated` | number | Existing invitation records updated |
| `Record Type` | single select | Obsolete — no longer written, can be ignored |

### `BSS'26` table (production tickets)

The merge/dedup key is `SP ID` — a plain text field. Airtable's native `performUpsert` matches on this field to create or update. Only records where `product.type === 'ticket'` are synced (add-ons are filtered out).

**All SP fields mapped** (see `src/config.js` FIELD_MAP and SP API Reference for full details):
- `SP ID`, `Ticket Code`, `Invitation Code`, `SP Invitation ID`
- `First Name`, `Last Name`, `Email from SP`, `Phone`
- `SP Stage`, `SP Status`, `SP Invites Per`
- `SP Purchase Price`, `SP Surcharge Fee`, `SP Service Fee`, `SP Processing Fee`, `SP Total`
- `SP Transfer Fee`, `SP Transfer Requires Payment`, `SP Transfer Status`
- `SP Transferee First Name/Last Name/Email`, `SP Transferer First Name/Last Name/Email`
- `SP Sales Organizer Revenue`, `SP Total Unlocked By Count`
- `SP Is Checked In`, `SP Checkin At`
- `SP Promo Code`
- `SP Created At`, `SP Updated At`
- `SP Product Name`, `SP Product Type`, `SP Product Transfer Allowed` (nested: `product.*`)
- `SP Invitation` (full nested invitation object as JSON)

**Existing fields not written by sync** (manually managed):
- `Email`, `Invited By Email` — linked record fields, can't write record IDs from SP
- `Promo Code` — multipleSelects type, use `SP Promo Code` instead
- `Transfer From Name`, `Transferred From Email` — unmapped, may overlap with SP transferer fields

### `Current Invite List` table (production invitations)

The merge/dedup key is `SP ID`. All SP invitation fields mapped — see SP API Reference section.
Note: `SP Level` is stored as text (singleLineText field) even though SP returns it as a number.

---

## How the Sync Works

### Entry points (`src/index.js`)
- **Cron:** `scheduled()` handler calls `runSync(..., 'scheduled')`
- **Webhook:** `fetch()` handler — accepts `POST /sync` with `x-webhook-secret` header, calls `runSync(..., 'manual')`
- All other routes return 404

### Core flow (`src/sync.js`)
1. `runSync()` calls `syncEndpoint('invitations', ...)` then `syncEndpoint('tickets', ...)` sequentially
2. `syncEndpoint()`:
   - Reads cursor from most recent `{{Sync State}}` row via `getCursor()`
   - Fetches records from SP API with `updated_after=cursor` (null = full sync)
   - Computes `nextCursor` from `meta.next_updated_after`, nudges +1s if unchanged
   - Upserts records into Airtable in batches of 10 via `upsertRecords()`
   - Writes log row via `logSync()` — success or failure, with counts + cursor
   - If error thrown, logs `failed` row with the **original cursor** (not advanced) so next run auto-retries, then re-throws (so webhook returns 500)

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
- Trigger: Button field clicked (in `BSS'26` or any table)
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
  backfill.js              — Patches SP fields onto existing ticket records by matching Ticket Code / SP ID
  backfill-invitations.js  — Full upsert of all SP invitations into Current Invite List
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

### Invitation fields

| SP field | Type | Airtable field | Notes |
|---|---|---|---|
| `id` | string | `SP ID` | merge key |
| `code` | string | `Invite Code` | |
| `first_name` | string\|null | `First Name` | |
| `last_name` | string\|null | `Last Name` | |
| `email` | string\|null | `Email` | |
| `phone` | string\|null | `Phone` | |
| `stage` | string | `SP Stage` | added/pending/sending/sent/opened/viewed/purchased/bounced/rejected/spam/opted-out/cancelled/duplicate/transferred |
| `status` | string | `SP Status` | active/purchased |
| `level` | number | `SP Level` | stored as text (Airtable field is singleLineText) |
| `invites_per` | number\|null | `SP Invites Per` | |
| `view_count` | number | `SP View Count` | |
| `created_invitation_count` | number | `SP Created Invitation Count` | |
| `claimed_ticket_count` | number | `SP Claimed Ticket Count` | |
| `last_viewed_at` | string\|null | `SP Last Viewed At` | |
| `created_at` | string | `SP Created At` | |
| `updated_at` | string | `SP Updated At` | |
| `inviter.name` | string | `SP Inviter Name` | nested |
| `parent_invitation.id` | string | `SP Parent Invitation ID` | nested |
| `parent_invitation.code` | string | `SP Parent Invitation Code` | nested |
| `event_id` | string | — | not mapped (not useful) |
| `tickets[]` | array | `SP Tickets` | stored as JSON in multilineText |
| `parent_invitation.first_name/last_name` | string\|null | — | not mapped |

### Ticket fields

| SP field | Type | Airtable field | Notes |
|---|---|---|---|
| `id` | string | `SP ID` | merge key |
| `code` | string\|null | `Ticket Code` | |
| `invitation_code` | string | `Invitation Code` | |
| `invitation_id` | string | `SP Invitation ID` | |
| `first_name` | string\|null | `First Name` | |
| `last_name` | string\|null | `Last Name` | |
| `email` | string\|null | `Email from SP` | |
| `phone` | string\|null | `Phone` | |
| `stage` | string | `SP Stage` | |
| `status` | string | `SP Status` | active/pending/refunded/transferred/disputed |
| `invites_per` | number\|null | `SP Invites Per` | |
| `purchase_price` | string | `SP Purchase Price` | decimal string e.g. "0.01" |
| `surcharge_fee` | string | `SP Surcharge Fee` | |
| `service_fee` | string | `SP Service Fee` | |
| `processing_fee` | string | `SP Processing Fee` | |
| `total` | string | `SP Total` | |
| `transfer_fee` | string | `SP Transfer Fee` | |
| `transfer_requires_payment` | boolean\|null | `SP Transfer Requires Payment` | checkbox |
| `transfer_status` | string\|null | `SP Transfer Status` | pending/active/complete |
| `transferee_first_name` | string\|null | `SP Transferee First Name` | |
| `transferee_last_name` | string\|null | `SP Transferee Last Name` | |
| `transferee_email` | string\|null | `SP Transferee Email` | |
| `transferer_first_name` | string\|null | `SP Transferer First Name` | |
| `transferer_last_name` | string\|null | `SP Transferer Last Name` | |
| `transferer_email` | string\|null | `SP Transferer Email` | |
| `sales_organizer_revenue_amount` | string\|null | `SP Sales Organizer Revenue` | |
| `is_checked_in` | boolean | `SP Is Checked In` | checkbox |
| `checkin_updated_at` | string\|null | `SP Checkin At` | |
| `total_unlocked_by_count` | number | `SP Total Unlocked By Count` | |
| `product.name` | string | `SP Product Name` | nested |
| `product.type` | string | `SP Product Type` | nested; ticket/add-on |
| `product.is_transfer_allowed` | boolean | `SP Product Transfer Allowed` | nested; checkbox |
| `created_at` | string | `SP Created At` | |
| `updated_at` | string | `SP Updated At` | |
| `product_id` | string | — | not mapped |
| `promotion_code` | string | `SP Promo Code` | |
| `invitation` | object | `SP Invitation` | stored as JSON in multilineText |

SP has **1,191 tickets** and **10,272 invitations** as of April 2026.

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
16. Added invitations sync — 10,272 records backfilled into `Current Invite List` via `backfill-invitations.js`, incremental Worker sync enabled
17. Added full SP field coverage — all invitation and ticket fields mapped, objects/arrays stored as JSON in multilineText fields
18. Added add-on filter — only `product.type === 'ticket'` records synced, add-ons skipped
19. Fixed error recovery — failed syncs now preserve original cursor so next run auto-retries
20. Switched tickets to production `BSS'26` table — 747 records backfilled, `{{API TEST}}` retired

---

## Still To Do

- [x] **Duplicate records** — verified clean as of April 2026. 900 records, all SP IDs unique, none blank.
- [x] **Delete old cursor-only row** in `{{Sync State}}` — done
- [x] **Remove `Record Type` field** from `{{Sync State}}` — done
- [x] **Map `Promo Code`** — created `SP Promo Code` as singleLineText, mapped in FIELD_MAP
- [x] **Re-enable invitations sync** — 10,272 records backfilled via `backfill-invitations.js`, incremental sync active
- [x] **Switch tickets to production table** — `BSS'26` live as of April 2026, 747 records backfilled
- [ ] **Compare SP transferer fields vs existing `Transfer From Name` / `Transferred From Email`** fields in Airtable — decide whether to map SP transferer fields there or keep them separate

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
- **50 subrequest limit on free plan** — each external API call counts. 10 records per Airtable upsert batch. Both endpoints now run incrementally so this is not an issue in normal operation. Use backfill scripts for any bulk loads.
- **Secrets are write-only in Cloudflare** — can't be read back after setting. Values stored in `.dev.vars` are the only copy
- **Airtable `performUpsert` creates if no match** — if `SP ID` is blank on an Airtable record, every sync will create a new duplicate instead of updating. Always ensure `SP ID` is populated before going live on a new table
- **`getCursor` sorts by `Synced At`** — if there are rows without a `Synced At` value (like the old cursor-only row), the sort may be unreliable. Delete that row.
