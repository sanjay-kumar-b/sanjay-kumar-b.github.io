---
title: "Bulk API 2.0 Ingest: Load Millions of Records Step by Step"
description: "Load large data sets with Bulk API 2.0: job lifecycle, CSV chunking, polling, failed-row retry and automation bypass, with tested Node code."
category: salesforce-development
tags: [Bulk API, Integration, Data Loading, Intermediate]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/bulk-api-2-ingest-guide.jpg
sources:
  - title: "Bulk API and Bulk API 2.0 Limits and Allocations"
    url: "https://developer.salesforce.com/docs/platform/salesforce-app-limits-cheatsheet/guide/salesforce-app-limits-platform-bulkapi.html"
  - title: "Bulk API 2.0 Ingest (Bulk API 2.0 Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.264.0.api_asynch.meta/api_asynch/datafiles_understanding_bulk2_ingest.htm"
---

Bulk API 2.0 is built for loading or deleting **large volumes** of records asynchronously. You upload CSV data; Salesforce splits it into batches and processes it in the background. You do not manage batches yourself, which makes it far simpler than the original Bulk API.

## The business scenario

Redwood Insurance (a fictional insurer) is migrating 3 million policy records from a legacy system into a custom object `Policy__c`. The legacy system will keep changing policies for two weeks, so the load must be repeatable: running it again should update existing rows, not duplicate them. Triggers that send customer emails must not fire during the load, and every failed row must be captured, fixed and loaded again.

## Before you start: setup

### In Salesforce

1. Create `Policy__c` with fields `Legacy_Id__c` (External ID, Unique), `Holder_Name__c`, `Premium__c` (currency) and `Account__c` (lookup to Account). Create `Legacy_Id__c` on Account too if you want to relate by external id.
2. Create a **Custom Permission** named `Bypass_Automation` and include it in a permission set assigned only to the load user. Your triggers and validation rules will check it.
3. Create an integration user, with **API Enabled**, access to `Policy__c`, and the permission set from step 2.
4. Load parent records (Accounts) first so lookups can resolve.
5. Run everything in a full or partial sandbox first, with a 1,000 row sample.

### In the external system

1. Export the legacy data to UTF-8 CSV with a header row of **field API names**, such as `Legacy_Id__c,Holder_Name__c,Premium__c`.
2. Use ISO dates (`2026-12-01`) and plain numbers without currency symbols.
3. Install Node 20 or newer for the loader in this article, and set `INSTANCE` and `TOKEN` environment variables.

## How it works

An ingest job moves through a fixed lifecycle:

1. **Create a job** that names the object, the operation, the line ending and, for upsert, the external id field.
2. **Upload CSV data** to the job.
3. **Close the job** by setting its state to `UploadComplete`.
4. **Poll** the job until it reports `JobComplete` or `Failed`.
5. **Download results**: successful, failed and unprocessed records.

Operations are `insert`, `update`, `upsert`, `delete` and `hardDelete`. Use it for tens of thousands of rows and up. For a few hundred rows, collections or Composite are simpler.

Key limits from the official limits page:

| Limit | Value |
|---|---|
| Records uploaded per 24-hour rolling period | 150,000,000 |
| Data per job | 150 MB after base64 encoding; upload no more than 100 MB |
| Field length | 131,072 characters |
| Fields per record | 5,000 |
| Characters per record | 400,000 |
| Job open time | 24 hours |
| Results retained | 7 days after completion |

Ingest jobs draw from the shared allocation of 15,000 batches per 24 hours. If a job has been retried more than 20 times, upload a smaller file.

## Basic example

The whole lifecycle in curl:

```bash
BASE="$INSTANCE/services/data/v67.0"
H="Authorization: Bearer $TOKEN"

# 1. Create the job (note the id in the reply)
curl -X POST "$BASE/jobs/ingest" -H "$H" -H "Content-Type: application/json" -d '{
  "object": "Policy__c",
  "operation": "upsert",
  "externalIdFieldName": "Legacy_Id__c",
  "contentType": "CSV",
  "lineEnding": "LF"
}'

# 2. Upload the CSV
curl -X PUT "$BASE/jobs/ingest/$JOB_ID/batches" -H "$H" -H "Content-Type: text/csv" --data-binary @policies.csv

# 3. Close the job
curl -X PATCH "$BASE/jobs/ingest/$JOB_ID" -H "$H" -H "Content-Type: application/json" -d '{"state":"UploadComplete"}'

# 4. Poll, then 5. download results
curl "$BASE/jobs/ingest/$JOB_ID" -H "$H"
curl "$BASE/jobs/ingest/$JOB_ID/failedResults/" -H "$H"
```

The sample file `policies.csv`:

```csv
Legacy_Id__c,Holder_Name__c,Premium__c
P-0001,Ana Silva,1200.50
P-0002,Ben Carter,980.00
```

This is enough for a first load. A real migration also needs file splitting, polling with limits, saved results and a retry of failed rows.

## Advanced end-to-end example

The loader below splits a large CSV into chunks below 100 MB, runs one job per chunk, saves results, and writes a retry file containing only the rows that failed.

**src/csv.mjs**

```javascript
// Split a CSV text into chunks, each at most maxBytes, repeating the header.
export function splitCsv(text, maxBytes) {
  const lines = text.split('\n').filter(l => l.length > 0);
  const header = lines.shift();
  const chunks = [];
  let current = [header];
  let size = Buffer.byteLength(header) + 1;
  for (const line of lines) {
    const bytes = Buffer.byteLength(line) + 1;
    if (size + bytes > maxBytes && current.length > 1) {
      chunks.push(current.join('\n') + '\n');
      current = [header];
      size = Buffer.byteLength(header) + 1;
    }
    current.push(line);
    size += bytes;
  }
  if (current.length > 1) {
    chunks.push(current.join('\n') + '\n');
  }
  return chunks;
}

// Salesforce failedResults rows start with sf__Id,sf__Error then the original columns.
export function failedRowsToRetryCsv(failedCsv) {
  const lines = failedCsv.split('\n').filter(l => l.length > 0);
  if (lines.length < 2) {
    return null;
  }
  const header = lines[0].split(',').slice(2).join(',');
  const body = lines.slice(1).map(l => l.split(',').slice(2).join(','));
  return [header, ...body].join('\n') + '\n';
}
```

**src/bulkIngest.mjs**

```javascript
const instance = process.env.INSTANCE;
const token = process.env.TOKEN;
const base = `${instance}/services/data/v67.0/jobs/ingest`;
const json = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ok(res, what) {
  if (!res.ok) {
    throw new Error(`${what} failed: ${res.status} ${await res.text()}`);
  }
  return res;
}

export async function runJob({ object, operation, externalId, csv, pollMs = 5000, maxPolls = 720 }) {
  const create = await ok(await fetch(base, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      object, operation, contentType: 'CSV', lineEnding: 'LF',
      ...(externalId ? { externalIdFieldName: externalId } : {})
    })
  }), 'create job');
  const job = await create.json();

  await ok(await fetch(`${base}/${job.id}/batches`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
    body: csv
  }), 'upload');

  await ok(await fetch(`${base}/${job.id}`, {
    method: 'PATCH', headers: json, body: JSON.stringify({ state: 'UploadComplete' })
  }), 'close job');

  let info;
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollMs);
    info = await (await ok(await fetch(`${base}/${job.id}`, { headers: json }), 'poll')).json();
    if (['JobComplete', 'Failed', 'Aborted'].includes(info.state)) {
      break;
    }
  }
  if (!['JobComplete', 'Failed', 'Aborted'].includes(info.state)) {
    throw new Error(`Job ${job.id} still ${info.state} after polling; check it in Setup > Bulk Data Load Jobs`);
  }
  return { id: job.id, info };
}

export async function download(jobId, kind) {
  const res = await ok(await fetch(`${base}/${jobId}/${kind}/`, { headers: { Authorization: `Bearer ${token}` } }), kind);
  return res.text();
}
```

**src/load.mjs**

```javascript
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { splitCsv, failedRowsToRetryCsv } from './csv.mjs';
import { runJob, download } from './bulkIngest.mjs';

const [file, object, externalId] = process.argv.slice(2);
const text = await readFile(file, 'utf8');
const chunks = splitCsv(text, 90 * 1024 * 1024);
await mkdir('results', { recursive: true });

let failedTotal = 0;
for (const [i, csv] of chunks.entries()) {
  const { id, info } = await runJob({ object, operation: 'upsert', externalId, csv });
  console.log(`chunk ${i + 1}/${chunks.length}: ${info.state} processed=${info.numberRecordsProcessed} failed=${info.numberRecordsFailed}`);
  await writeFile(`results/chunk-${i + 1}-success.csv`, await download(id, 'successfulResults'));
  const failed = await download(id, 'failedResults');
  await writeFile(`results/chunk-${i + 1}-failed.csv`, failed);
  const retry = failedRowsToRetryCsv(failed);
  if (retry) {
    failedTotal += Number(info.numberRecordsFailed);
    await writeFile(`results/chunk-${i + 1}-retry.csv`, retry);
  }
}
console.log(failedTotal === 0 ? 'All rows loaded.' : `${failedTotal} rows need attention: see results/*-retry.csv`);
```

**test/csv.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { splitCsv, failedRowsToRetryCsv } from '../src/csv.mjs';

test('every chunk repeats the header and stays under the limit', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `P-${i},Name ${i},10`);
  const text = ['Legacy_Id__c,Holder_Name__c,Premium__c', ...rows].join('\n') + '\n';
  const chunks = splitCsv(text, 300);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c) <= 300);
    assert.ok(c.startsWith('Legacy_Id__c,'));
  }
  const total = chunks.reduce((n, c) => n + c.trim().split('\n').length - 1, 0);
  assert.equal(total, 50);
});

test('retry file drops Salesforce columns and keeps the original rows', () => {
  const failed = 'sf__Id,sf__Error,Legacy_Id__c,Holder_Name__c\n,UNABLE_TO_LOCK_ROW,P-1,Ana\n,REQUIRED_FIELD_MISSING,P-2,Ben\n';
  assert.equal(failedRowsToRetryCsv(failed), 'Legacy_Id__c,Holder_Name__c\nP-1,Ana\nP-2,Ben\n');
});

test('no failures means no retry file', () => {
  assert.equal(failedRowsToRetryCsv('sf__Id,sf__Error,Legacy_Id__c\n'), null);
});
```

The matching Apex check lets triggers stand down for the load user, while keeping the rules that matter for everyone else:

**force-app/main/default/classes/AutomationGate.cls**

```apex
public with sharing class AutomationGate {
    // True when the running user holds the Bypass_Automation custom permission.
    public static Boolean bypassed() {
        return FeatureManagement.checkPermission('Bypass_Automation');
    }
}
```

Use it at the top of a trigger or handler with `if (AutomationGate.bypassed()) { return; }`. Test it by assigning a permission set that contains the custom permission to a test user with `System.runAs`.

Run the loader:

```bash
node --test
node src/load.mjs policies.csv Policy__c Legacy_Id__c
```

One honest limitation: the helper functions split lines on commas and newlines, so they are correct only for simple data. If a field can contain a comma or a line break inside quotes (a free-text description, for instance), use a proper CSV library such as `csv-parse` for splitting and for building the retry file. The structure of the loader stays the same; only those two functions change. Keep the unit tests and add a case with a quoted comma so a regression is caught immediately.

## What happens behind the scenes

When you close the job, Salesforce queues it and splits your CSV into internal batches. It processes them in parallel, which is fast but can cause **row lock contention**: two parallel batches that touch the same parent record can both try to lock it, and one fails with `UNABLE_TO_LOCK_ROW`. The unlocked rows succeed and the locked ones appear in `failedResults`. Sorting the CSV by parent id keeps rows for one parent together in one batch.

The platform fires triggers, flows and validation rules for each batch as ordinary DML, with the usual governor limits per batch. This is why automation can slow a load dramatically, and why the bypass permission is valuable. Upsert on an External ID is atomic per row, so a repeated load updates rather than duplicates.

Results are stored for seven days. Download them promptly, because the retry file is how you recover.

## Test it and verify

1. Run `node --test`. All three tests should pass.
2. Make a sample CSV of 1,000 policies and load it into a sandbox. Expect `JobComplete` and `failed=0`.
3. Load the same file again. Counts stay the same and the records show a new last-modified time.
4. Break two rows (blank a required field) and load. Confirm `results/chunk-1-retry.csv` holds exactly those two rows.
5. Fix them and load the retry file. Confirm the failed count is zero.
6. Open **Setup > Bulk Data Load Jobs** and compare the job's counts with your console output.

## Common mistakes and fixes

- **Header names that are not API names.** The job fails or columns are ignored. Use API names such as `Legacy_Id__c`.
- **Loading children before parents.** Lookups cannot resolve. Load parents first or use external-id relationships.
- **Running parallel jobs on the same parents.** This causes lock errors. Run sequentially or sort by parent.
- **Leaving automation on.** A trigger that emails customers will send millions of emails. Use the bypass.
- **Ignoring failed results.** The job says `JobComplete` even when some rows failed. Always check `numberRecordsFailed`.
- **One giant file.** Split into 50 to 100 MB pieces.

## Key takeaways

- Bulk API 2.0 is asynchronous: create, upload, close, poll, download.
- Upsert on an External ID makes migrations repeatable.
- Split large files, sort by parent and avoid parallel jobs on shared parents.
- Bypass automation deliberately for load users, and keep integrity rules that matter.
- Failed rows come back with the reason, so fix and resubmit only those.

## Where to go next

- Read [Bulk API 2.0 query jobs and advanced practices](/articles/bulk-api-2-query-and-advanced/) for exports and tuning.
- Read [Composite API guide](/articles/composite-api-guide/) for smaller transactional loads.
- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for repeatable loads.
