/**
 * Backfill script: fetch all SP tickets and patch every matched Airtable record
 * with the full set of SP fields defined in FIELD_MAP.
 *
 * Usage:
 *   SECRET_PARTY_API_KEY=... AIRTABLE_API_KEY=... node src/backfill.js [options]
 *
 * Options:
 *   --table <name|id>   Airtable table to target (default: value from config.js)
 *   --dry-run           Preview what would be patched without writing anything
 *   --help              Show this message
 *
 * Examples:
 *   # Test table (default)
 *   node src/backfill.js
 *
 *   # Production table, dry run first
 *   node src/backfill.js --table "BSS'26" --dry-run
 *
 *   # Production table, for real
 *   node src/backfill.js --table "BSS'26"
 */

import { BASES, TABLES, SP_BASE_URL, FIELD_MAP } from './config.js';

const AIRTABLE_API = 'https://api.airtable.com/v0';
const BATCH_SIZE = 10;          // Airtable max records per PATCH request
const RATE_LIMIT_MS = 250;      // 4 req/sec — safely under Airtable's 5/sec limit

// ── CLI args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

if (args.includes('--help')) {
  console.log(`
Usage: node src/backfill.js [--table <name>] [--dry-run]

  --table <name>   Airtable table name or ID to target (default: ${TABLES.tickets})
  --dry-run        Preview changes without writing to Airtable
`);
  process.exit(0);
}

const dryRun = args.includes('--dry-run');
const tableArgIdx = args.indexOf('--table');
const targetTable = tableArgIdx !== -1 ? args[tableArgIdx + 1] : TABLES.tickets;

if (!targetTable) {
  console.error('Error: --table flag requires a value');
  process.exit(1);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAllSP(endpoint, apiKey) {
  const url = new URL(`${SP_BASE_URL}/${endpoint}`);
  const response = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) throw new Error(`SP API error: ${response.status} (${endpoint})`);
  const body = await response.json();
  return body.data ?? body.records ?? body[endpoint] ?? [];
}

async function fetchAllAirtableRecords(apiKey, baseId, tableId) {
  const records = [];
  let offset = null;
  let page = 0;

  do {
    const url = new URL(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`);
    url.searchParams.set('fields[]', 'SP ID');
    url.searchParams.set('fields[]', 'Ticket Code');
    if (offset) url.searchParams.set('offset', offset);

    const response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Airtable list error: ${response.status} — ${await response.text()}`);

    const data = await response.json();
    records.push(...(data.records ?? []));
    offset = data.offset ?? null;
    page++;
    console.log(`  Fetched page ${page} (${records.length} records so far)`);

    if (offset) await sleep(RATE_LIMIT_MS);
  } while (offset);

  return records;
}

function mapSpRecord(spRecord) {
  const map = FIELD_MAP.tickets;
  const fields = {};
  for (const [spField, airtableField] of Object.entries(map)) {
    const value = spField.includes('.')
      ? spField.split('.').reduce((obj, key) => obj?.[key], spRecord)
      : spRecord[spField];
    if (value !== undefined && value !== null) {
      fields[airtableField] = value;
    }
  }
  return fields;
}

async function patchBatch(apiKey, baseId, tableId, batch, batchNum, totalBatches) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetch(`${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: batch }),
    });

    if (response.ok) {
      console.log(`  Batch ${batchNum}/${totalBatches} — patched ${batch.length} records`);
      return;
    }

    const err = await response.text();

    // 429 = rate limited — back off and retry
    if (response.status === 429 && attempt < maxAttempts) {
      const backoff = attempt * 2000;
      console.warn(`  Batch ${batchNum}: rate limited (429), retrying in ${backoff / 1000}s...`);
      await sleep(backoff);
      continue;
    }

    throw new Error(`Airtable patch error on batch ${batchNum} (attempt ${attempt}): ${response.status} — ${err}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const SP_API_KEY = process.env.SECRET_PARTY_API_KEY;
const AT_API_KEY = process.env.AIRTABLE_API_KEY;

if (!SP_API_KEY || !AT_API_KEY) {
  console.error('Error: Missing SECRET_PARTY_API_KEY or AIRTABLE_API_KEY env vars');
  process.exit(1);
}

console.log('='.repeat(60));
console.log(`Target table : ${targetTable}`);
console.log(`Mode         : ${dryRun ? 'DRY RUN (no writes)' : 'LIVE'}`);
console.log('='.repeat(60));

console.log('\nFetching all SP tickets...');
const spTickets = await fetchAllSP('tickets', SP_API_KEY);
const ticketByCode = new Map(spTickets.map((r) => [r.code, r]));
const ticketById   = new Map(spTickets.map((r) => [String(r.id), r]));
console.log(`  ${spTickets.length} tickets from SP`);

console.log(`\nFetching all Airtable records from "${targetTable}"...`);
const baseId = BASES.tickets;
const airtableRecords = await fetchAllAirtableRecords(AT_API_KEY, baseId, targetTable);
console.log(`  ${airtableRecords.length} Airtable records total`);

// Build update list
const updates = [];
let matched = 0;
let unmatched = 0;

for (const record of airtableRecords) {
  const spId      = record.fields['SP ID'];
  const ticketCode = record.fields['Ticket Code'];

  let spRecord = null;
  if (spId && ticketById.has(String(spId))) {
    spRecord = ticketById.get(String(spId));
  } else if (ticketCode && ticketByCode.has(ticketCode)) {
    spRecord = ticketByCode.get(ticketCode);
  }

  if (spRecord) {
    updates.push({ id: record.id, fields: mapSpRecord(spRecord) });
    matched++;
  } else {
    console.log(`  No SP match: Airtable ${record.id} (SP ID: ${spId ?? '—'}, code: ${ticketCode ?? '—'})`);
    unmatched++;
  }
}

console.log(`\nResults: ${matched} matched, ${unmatched} unmatched`);

if (updates.length === 0) {
  console.log('Nothing to patch. Exiting.');
  process.exit(0);
}

if (dryRun) {
  console.log(`\nDRY RUN — would patch ${updates.length} records. First 3 previewed below:`);
  updates.slice(0, 3).forEach((u) => console.log(JSON.stringify(u, null, 2)));
  process.exit(0);
}

console.log(`\nPatching ${updates.length} records in batches of ${BATCH_SIZE}...`);
const batches = [];
for (let i = 0; i < updates.length; i += BATCH_SIZE) {
  batches.push(updates.slice(i, i + BATCH_SIZE));
}

for (let i = 0; i < batches.length; i++) {
  await patchBatch(AT_API_KEY, baseId, targetTable, batches[i], i + 1, batches.length);
  if (i < batches.length - 1) await sleep(RATE_LIMIT_MS);
}

console.log(`\nBackfill complete. ${updates.length} records patched.`);
