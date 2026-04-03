import { fetchRecords } from './secretparty.js';
import { upsertRecords, getCursor, logSync } from './airtable.js';
import { BASES, TABLES, MERGE_FIELDS, FIELD_MAP } from './config.js';

/**
 * Map a raw Secret Party record to Airtable fields using FIELD_MAP.
 * Only includes fields that are defined in the map.
 *
 * @param {object} record - raw record from Secret Party API
 * @param {'invitations'|'tickets'} type
 * @returns {{ fields: object }}
 */
function mapRecord(record, type) {
  const map = FIELD_MAP[type];
  const fields = {};
  for (const [spField, airtableField] of Object.entries(map)) {
    // Support dot notation for nested fields (e.g. 'product.name')
    const value = spField.includes('.')
      ? spField.split('.').reduce((obj, key) => obj?.[key], record)
      : record[spField];
    if (value !== undefined && value !== null) {
      fields[airtableField] = value;
    }
  }
  return { fields };
}

/**
 * Sync one endpoint (invitations or tickets).
 * Reads cursor → fetches from SP API → upserts to Airtable → saves new cursor.
 *
 * @param {'invitations'|'tickets'} type
 * @param {string} spApiKey
 * @param {string} airtableApiKey
 * @returns {{ created: number, updated: number, fetched: number }}
 */
async function syncEndpoint(type, spApiKey, airtableApiKey, triggeredBy) {
  // 1. Read the stored cursor (null = first run, do a full sync)
  const cursor = await getCursor(
    airtableApiKey,
    BASES.syncState,
    TABLES.syncState,
    type,
  );

  console.log(`[${type}] cursor: ${cursor ?? 'none — full sync'}`);

  let nextCursor = cursor;
  let fetched = 0;
  let created = 0;
  let updated = 0;

  try {
    // 2. Fetch from Secret Party
    const { records, meta } = await fetchRecords(type, spApiKey, cursor);
    fetched = meta.returned_count;
    console.log(`[${type}] fetched ${fetched} records`);

    // 3. Determine next cursor. If SP returns the same cursor we sent, nudge forward
    // 1 second to avoid fetching the same boundary records on every run.
    nextCursor = meta.next_updated_after ?? cursor;
    if (nextCursor && cursor && nextCursor === cursor) {
      nextCursor = new Date(new Date(cursor).getTime() + 1000).toISOString();
      console.log(`[${type}] cursor unchanged — nudging forward to: ${nextCursor}`);
    }

    // 4. Filter out records SP incorrectly returns past the cursor (known SP API bug:
    //    some records are always returned regardless of updated_after). Only process
    //    records whose updated_at is strictly after the cursor we sent.
    const genuineRecords = cursor
      ? records.filter((r) => r.updated_at > cursor)
      : records;

    fetched = genuineRecords.length;
    console.log(`[${type}] genuine records after cursor filter: ${fetched} (SP returned ${records.length})`);

    // 5. Upsert into Airtable
    if (genuineRecords.length > 0) {
      const airtableRecords = genuineRecords.map((r) => mapRecord(r, type));
      const result = await upsertRecords(
        airtableApiKey,
        BASES[type],
        TABLES[type],
        airtableRecords,
        MERGE_FIELDS[type],
      );
      created = result.createdRecords.length;
      updated = result.updatedRecords.length;
      console.log(`[${type}] created: ${created}, updated: ${updated}`);
    }

    await logSync(airtableApiKey, BASES.syncState, TABLES.syncState, type, triggeredBy, nextCursor, 'success', { created, updated, fetched });
  } catch (err) {
    console.error(`[${type}] error: ${err.message}`);
    await logSync(airtableApiKey, BASES.syncState, TABLES.syncState, type, triggeredBy, nextCursor, 'failed', { created, updated, fetched }, err.message);
    throw err;
  }

  return { fetched, created, updated };
}

/**
 * Run a full sync of all endpoints.
 * Runs invitations and tickets in parallel for speed.
 *
 * @param {string} spApiKey
 * @param {string} airtableApiKey
 * @param {'scheduled'|'manual'} triggeredBy
 * @returns {object} summary of what happened
 */
export async function runSync(spApiKey, airtableApiKey, triggeredBy = 'scheduled') {
  console.log('Sync started:', new Date().toISOString());

  // Invitations disabled in the Worker — 10k+ records exceeds the free plan's 50 subrequest limit.
  // Initial load must be done via backfill.js locally. Once SP IDs are stamped on all records,
  // re-enable this for incremental-only runs (which will be small and safe).
  const ticketResult = await syncEndpoint('tickets', spApiKey, airtableApiKey, triggeredBy);

  const summary = {
    invitations: { fetched: 0, created: 0, updated: 0 },
    tickets: ticketResult,
    timestamp: new Date().toISOString(),
  };

  console.log('Sync complete:', JSON.stringify(summary));
  return summary;
}
