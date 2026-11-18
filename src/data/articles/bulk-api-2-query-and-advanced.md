---
title: "Bulk API 2.0 Query Jobs and Advanced Data Loading Practices"
description: "Export big data sets with Bulk API 2.0 query jobs, page results with locators, run incremental syncs with a high-water mark, and tune loads."
category: salesforce-development
tags: [Bulk API, Integration, Data Loading, Advanced]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/bulk-api-2-query-and-advanced.jpg
sources:
  - title: "Bulk API and Bulk API 2.0 Limits and Allocations"
    url: "https://developer.salesforce.com/docs/platform/salesforce-app-limits-cheatsheet/guide/salesforce-app-limits-platform-bulkapi.html"
  - title: "Bulk API 2.0 Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/"
---

The ingest article showed how to push data in. This article covers the other direction: exporting large data sets with **query jobs**, keeping an outside copy up to date with an **incremental sync**, and the practices that make large loads fast and safe.

## The business scenario

Redwood Insurance (a fictional insurer) feeds its analytics warehouse from Salesforce. A full export of 3 million `Policy__c` rows every night is too slow and too heavy, so the warehouse needs only what changed since the last run, including deleted records. The export must survive a failure halfway, never skip a change, and never apply the same change twice with a different result.

## Before you start: setup

### In Salesforce

1. Use the `Policy__c` object from the ingest article, with `Legacy_Id__c` as an External ID.
2. Ask your admin to confirm `SystemModstamp` is indexed on the object. It is a standard system field, indexed by default, and is the best field to filter on for changes.
3. Create an integration user with **API Enabled** and read access to the object. For deleted rows the user also needs permission to view deleted records through `queryAll`.
4. Note your daily Bulk query limits in **Setup > System Overview** or the `/limits` resource.

### In the external system

1. Provide durable storage for the **high-water mark**, which is the last `SystemModstamp` you have successfully applied. A small table or file is enough.
2. Make the target load idempotent, using upsert on `Legacy_Id__c` or the Salesforce Id.
3. Set `INSTANCE` and `TOKEN` environment variables and use Node 20 or newer.

## How it works

A query job extracts far more rows than a normal REST query and returns them as CSV. The lifecycle is shorter than ingest: you create the job with a SOQL statement, poll until it completes, then download the results. Results can be fetched in pieces using the `maxRecords` query parameter, and Salesforce returns a **locator** for the next piece in the `Sforce-Locator` response header. Confirm header names against the guide for your API version.

`operation` can be `query`, which returns live rows, or `queryAll`, which includes deleted and archived rows.

Official query limits:

- 10,000 query jobs per 24-hour rolling window, tracked as `DailyBulkV2QueryJobs` in `/limits`
- 1 TB total query results per 24 hours, tracked as `DailyBulkV2QueryFileStorageMB`
- Retrieved file size 1 GB
- Results retrieval timeout 20 minutes
- Results kept 7 days after completion
- If a query is retried more than 15 times, add filters and try again
- Query jobs do not use the shared batch allocation

Some SOQL features, such as certain relationship constructs, are not supported in bulk queries. Validate your statement in a sandbox first.

## Basic example

```bash
BASE="$INSTANCE/services/data/v67.0"
H="Authorization: Bearer $TOKEN"

# Create
curl -X POST "$BASE/jobs/query" -H "$H" -H "Content-Type: application/json" -d '{
  "operation": "query",
  "query": "SELECT Id, Legacy_Id__c, Premium__c FROM Policy__c WHERE SystemModstamp > 2026-11-01T00:00:00Z"
}'

# Poll (state becomes JobComplete)
curl "$BASE/jobs/query/$JOB_ID" -H "$H"

# Download
curl "$BASE/jobs/query/$JOB_ID/results" -H "$H" -o policies.csv
```

That exports everything changed after the date you typed. The advanced version works out that date by itself, pages through results, handles deletes and moves the mark only after success.

## Advanced end-to-end example

**src/query.mjs**

```javascript
const instance = process.env.INSTANCE;
const token = process.env.TOKEN;
const base = `${instance}/services/data/v67.0/jobs`;
const auth = { Authorization: `Bearer ${token}` };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ok(res, what) {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function runQuery(soql, { operation = 'query', pollMs = 3000, maxPolls = 600 } = {}) {
  const create = await ok(await fetch(`${base}/query`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ operation, query: soql })
  }), 'create query job');
  const job = await create.json();

  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    const info = await (await ok(await fetch(`${base}/query/${job.id}`, { headers: auth }), 'poll')).json();
    if (info.state === 'JobComplete') {
      return { id: job.id, rows: info.numberRecordsProcessed };
    }
    if (info.state === 'Failed' || info.state === 'Aborted') {
      throw new Error(`Query job ${job.id} ${info.state}: ${info.errorMessage || ''}`);
    }
  }
  throw new Error(`Query job ${job.id} did not finish in time`);
}

// Yield CSV pages, following the Sforce-Locator header until it is "null".
export async function* pages(jobId, maxRecords = 50000) {
  let locator = null;
  do {
    const url = `${base}/query/${jobId}/results?maxRecords=${maxRecords}` + (locator ? `&locator=${locator}` : '');
    const res = await ok(await fetch(url, { headers: auth }), 'download results');
    const next = res.headers.get('Sforce-Locator');
    locator = next && next !== 'null' ? next : null;
    yield await res.text();
  } while (locator);
}
```

**src/watermark.mjs**

```javascript
import { readFile, writeFile } from 'node:fs/promises';

export async function readMark(file, fallback = '1970-01-01T00:00:00.000Z') {
  try {
    return (await readFile(file, 'utf8')).trim() || fallback;
  } catch {
    return fallback;
  }
}

export async function writeMark(file, iso) {
  await writeFile(file, iso + '\n');
}

// SOQL datetime literals are unquoted ISO 8601.
export function changedSince(mark) {
  return `SELECT Id, Legacy_Id__c, Premium__c, IsDeleted, SystemModstamp FROM Policy__c ` +
    `WHERE SystemModstamp > ${mark} ORDER BY SystemModstamp ASC`;
}

// Highest SystemModstamp in a CSV page, or null when it has no rows.
export function maxModstamp(csv) {
  const lines = csv.split('\n').filter(Boolean);
  if (lines.length < 2) {
    return null;
  }
  const col = lines[0].split(',').indexOf('SystemModstamp');
  if (col < 0) {
    throw new Error('SystemModstamp column missing');
  }
  return lines.slice(1).map(l => l.split(',')[col].replace(/"/g, '')).sort().at(-1);
}
```

**src/sync.mjs**

```javascript
import { runQuery, pages } from './query.mjs';
import { readMark, writeMark, changedSince, maxModstamp } from './watermark.mjs';
import { applyToTarget } from './target.mjs';

const MARK_FILE = process.env.MARK_FILE || '.mark';

export async function syncOnce() {
  const mark = await readMark(MARK_FILE);
  // queryAll includes deleted rows, so the target can remove them too.
  const { id, rows } = await runQuery(changedSince(mark), { operation: 'queryAll' });
  if (rows === 0) {
    return { applied: 0, mark };
  }
  let newest = mark;
  let applied = 0;
  for await (const csv of pages(id)) {
    await applyToTarget(csv); // must be idempotent
    const high = maxModstamp(csv);
    if (high && high > newest) {
      newest = high;
    }
    applied += csv.split('\n').filter(Boolean).length - 1;
  }
  await writeMark(MARK_FILE, newest); // only after every page succeeded
  return { applied, mark: newest };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  syncOnce().then(r => console.log(r), e => { console.error(e.message); process.exit(1); });
}
```

**src/target.mjs** (replace with your warehouse loader)

```javascript
export async function applyToTarget(csv) {
  // Example: upsert each non-deleted row by Legacy_Id__c, delete rows where IsDeleted is true.
  console.log(`applying ${csv.split('\n').filter(Boolean).length - 1} rows`);
}
```

**test/watermark.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { changedSince, maxModstamp, readMark } from '../src/watermark.mjs';

test('query filters and orders by SystemModstamp', () => {
  const soql = changedSince('2026-11-01T00:00:00.000Z');
  assert.match(soql, /SystemModstamp > 2026-11-01T00:00:00.000Z/);
  assert.match(soql, /ORDER BY SystemModstamp ASC/);
});

test('maxModstamp finds the newest value', () => {
  const csv = 'Id,SystemModstamp\n"a","2026-11-02T10:00:00.000Z"\n"b","2026-11-03T09:00:00.000Z"\n"c","2026-11-01T01:00:00.000Z"\n';
  assert.equal(maxModstamp(csv), '2026-11-03T09:00:00.000Z');
});

test('empty page has no modstamp', () => {
  assert.equal(maxModstamp('Id,SystemModstamp\n'), null);
});

test('missing mark file falls back to the epoch', async () => {
  assert.equal(await readMark('/nonexistent/.mark'), '1970-01-01T00:00:00.000Z');
});
```

Schedule it with cron on a server, for example every night at 01:30:

```bash
30 1 * * * cd /opt/policy-sync && /usr/bin/node src/sync.mjs >> sync.log 2>&1
```

## What happens behind the scenes

A query job runs on Salesforce's servers, away from your request. Salesforce executes the SOQL, writes the output to a result file, and keeps it for seven days. Each page request reads a slice of that file and returns a locator that points at the next slice. The locator is why you can resume after a failure without re-running the query.

The incremental pattern works because `SystemModstamp` changes whenever any change is made to a record, including by automation and by integrations. Sorting by it and moving the mark only after all pages were applied means a crash causes a repeat of changes, never a loss. Repeats are harmless because the target applies upserts. Deleted records appear only through `queryAll` with `IsDeleted = true`, so the same job covers inserts, updates and deletes.

One subtle point: use `>` with the **highest value you saw**, not the time the job started. A change committed while your job was running might carry an earlier timestamp than your start time, and using the start time would skip it.

## Tuning large loads and exports

The same few habits make both directions faster and safer:

1. **Filter on indexed fields** and slice by date ranges, for example by `SystemModstamp`, rather than one giant query.
2. **Select only needed fields.** Wide rows cost time at every step.
3. **Avoid triggers and flows during loads.** Use a bypass switch for load users, but keep integrity rules that matter.
4. **Order by parent** to reduce lock conflicts.
5. **Defer sharing calculations** for huge loads only when your admin has that option and approves it.
6. **Run during quiet hours** so you do not compete with users.

Monitoring is simple. `GET /jobs/ingest` and `GET /jobs/query` list jobs. Abort a job by sending `PATCH` with state `Aborted`, and delete a finished job with `DELETE`. Jobs in a terminal state are deleted after seven days, according to the limits page.

Choosing the tool: millions of rows in or out belong to Bulk API 2.0; thousands with relationships and rollback belong to Composite or collections; a live event stream belongs to the Pub/Sub API; and a person doing a one-off load should use the Data Import Wizard or Data Loader.

## Test it and verify

1. Run `node --test`; four tests should pass.
2. Run `node src/sync.mjs` with no `.mark` file in a sandbox. It exports everything and writes the mark.
3. Run it again immediately. Expect `applied: 0`.
4. Edit one policy in Salesforce and run again. Expect one row and a newer mark.
5. Delete a policy, empty nothing else, and run again. With `queryAll` the row appears with `IsDeleted` true.
6. Check `/limits` and confirm `DailyBulkV2QueryJobs` rose by one per run.

## Common mistakes and fixes

- **Moving the mark before applying.** A crash then loses data. Move it last.
- **Using the job start time as the mark.** Use the highest `SystemModstamp` seen.
- **One giant query.** Slice by date ranges if a window is too large.
- **Forgetting deletes.** Plain `query` never returns them. Use `queryAll`.
- **Selecting every field.** Select only what you need.
- **Parsing CSV with `split(',')` on free text.** Use a real CSV parser when fields can contain commas or line breaks.

## Key takeaways

- Query jobs export huge data sets asynchronously, with locators for paging.
- A stored high-water mark on `SystemModstamp` turns a full export into a cheap incremental one.
- Move the mark only after every page is applied, and make the target idempotent.
- Use `queryAll` to carry deletes.
- For loads, bypass unneeded automation, order by parent, and run in quiet hours.

## Where to go next

- Read [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/) for the loading side.
- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for repeat-safe design.
- Read [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/) when you need changes in near real time instead of nightly.
