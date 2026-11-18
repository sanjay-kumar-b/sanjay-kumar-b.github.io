---
title: "Partial Batch Failures: Per-Record Status and Retrying Only the Failures"
description: "Sync batches where some records fail: per-record status, external IDs, SaveResult mapping, backoff, dead-lettering and retry-only-failures in Apex and Node."
category: salesforce-development
tags: [Integration, Batch, Retries, External ID, Apex]
publishedAt: 2026-11-18
updatedAt: 2026-11-18
cover: /images/covers/batch-partial-failures-per-record-status-retry.jpg
sources:
  - title: "Apex Developer Guide: Database class and DML options"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
  - title: "Salesforce REST API Developer Guide: Composite and sObject Collections"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/"
---

A batch of 200 records goes out. The response says 198 worked and 2 failed. What happens next decides whether your integration is trustworthy. If you treat the batch as one unit, you either throw away 198 good results and resend all 200 (creating duplicates) or you ignore the 2 failures (losing data). The safe answer is to keep a status for every record, and to send again only the records that need it.

This article builds that pattern: a per-record status model, a rule for what is due for a retry, mapping of Salesforce `SaveResult` and API responses back to records by external id, backoff, and a dead state for records that need a human. For the single-request timeout problem, read [timeouts, duplicates and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/) first.

## The business scenario

Crestline Lending (a fictional lender) nightly syncs up to 50,000 customers from its core banking system into Salesforce Contacts, and pushes changes back out in batches of 200. Real failures are mixed: a few rows have invalid emails (permanent), a few hit a record lock (temporary), and now and then the whole call times out. Today any failure makes the job restart from the beginning, which re-sends everything and creates duplicate Contacts when the first run had partly succeeded.

The goal: every record reaches `Succeeded` or `Dead` with a reason, and a rerun never touches records that are already done.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox.
2. Add an **External ID** field to Contact: `Core_Id__c` (Text 40, External ID, Unique, case-insensitive off). Verify: it appears on the Contact object with Unique and External ID checked.
3. Create a custom object `Sync_Item__c` (one row per record to sync) with `Core_Id__c` (Text 40, External ID, Unique), `Status__c` (Picklist: Pending, Succeeded, Failed, Dead), `Attempts__c` (Number 2,0), `Last_Error__c` (Long Text 2000), `Next_Retry_At__c` (Date/Time), `Payload__c` (Long Text 32000). Verify: all fields exist.
4. Create a permission set that gives the integration user edit access to Contact and `Sync_Item__c`.

### In the external system

5. Confirm that the target API returns **a result per record** and not just one status for the call. Salesforce's own APIs do: the sObject Collections and Composite endpoints, and Bulk API job results (separate files for successful and failed records). Verify with `curl` on a two-record call where one record is invalid.
6. If the target returns a single status for the whole call, ask whether it has a per-record or "get results" endpoint. If not, split into smaller chunks so a failure affects fewer records, and rely on idempotent upserts.
7. Note the target's batch size limit (for example 200 for DML and sObject Collections) and whether `allOrNone` can be turned off.

## How it works

Five rules make partial failures safe:

1. **One row per record.** `Sync_Item__c` holds status, attempts, last error and the next retry time. The batch is only a transport.
2. **Match results by external id, not by position.** Positions drift when records are skipped; ids do not.
3. **Never use all-or-nothing for sync.** Send with `allOrNone=false` (Apex `Database.insert(records, false)`, Composite `allOrNone: false`) so good records are saved.
4. **Classify each failure.** Temporary (lock, timeout, 429, 5xx) is `Failed` with a retry time. Permanent (validation, bad data, 4xx) is `Dead` straight away.
5. **Retry only what is due.** Select `Pending` plus `Failed` rows whose time has come. Never send `Succeeded` or `Dead`.

Upserting on an external id makes step 5 safe even if a status update was lost: sending a record that had in fact succeeded updates it again instead of duplicating it.

## Basic example

The model in Node, small enough to read in one sitting. `runPass` selects due items, sends them in chunks, and applies a per-record result.

```javascript
// Per-record status and retry-only-failures for a batch sync.

export const STATUS = { PENDING: 'Pending', SUCCEEDED: 'Succeeded', FAILED: 'Failed', DEAD: 'Dead' };

export function newItem(externalId, payload) {
  return { externalId, payload, status: STATUS.PENDING, attempts: 0, error: null, nextRetryAt: 0 };
}

// Which items should this run send? Pending, or Failed whose wait is over. Never Succeeded or Dead.
export function selectDue(items, now) {
  return items.filter(i =>
    i.status === STATUS.PENDING || (i.status === STATUS.FAILED && i.nextRetryAt <= now));
}

export function isRetryable(error) {
  return error.retryable === true;
}

export function backoffMs(attempts, base = 1000, cap = 60000) {
  return Math.min(cap, base * 2 ** (attempts - 1));
}

// Apply a per-record result list returned by the target system, matched by externalId.
export function applyResults(items, results, now, maxAttempts = 3) {
  const byId = new Map(results.map(r => [r.externalId, r]));
  for (const item of items) {
    const r = byId.get(item.externalId);
    item.attempts += 1;
    if (!r) {
      // The response did not mention this record: treat as unknown and retry it.
      markFailure(item, { message: 'No result returned', retryable: true }, now, maxAttempts);
    } else if (r.success) {
      item.status = STATUS.SUCCEEDED;
      item.error = null;
    } else {
      markFailure(item, r.error, now, maxAttempts);
    }
  }
}

function markFailure(item, error, now, maxAttempts) {
  item.error = error.message;
  if (!isRetryable(error) || item.attempts >= maxAttempts) {
    item.status = STATUS.DEAD;
    return;
  }
  item.status = STATUS.FAILED;
  item.nextRetryAt = now + backoffMs(item.attempts);
}

export function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

// One full sync pass. "send" takes a chunk and returns per-record results (or throws for a whole-call failure).
export async function runPass(items, send, { now = 0, chunkSize = 200, maxAttempts = 3 } = {}) {
  for (const group of chunk(selectDue(items, now), chunkSize)) {
    try {
      applyResults(group, await send(group), now, maxAttempts);
    } catch (e) {
      applyResults(group, group.map(g => ({
        externalId: g.externalId, success: false,
        error: { message: e.message, retryable: true }
      })), now, maxAttempts);
    }
  }
  return summarize(items);
}

export function summarize(items) {
  const counts = { Pending: 0, Succeeded: 0, Failed: 0, Dead: 0 };
  items.forEach(i => { counts[i.status] += 1; });
  return counts;
}
```

The tests describe the behaviour you want from any implementation:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STATUS, chunk, newItem, runPass, selectDue, summarize } from './batchKit.mjs';

const make = n => Array.from({ length: n }, (_, i) => newItem('C-' + i, { name: 'Customer ' + i }));

// A target that fails specific records with specific errors, and records every record it receives.
function target(rules) {
  const seen = [];
  const send = async group => group.map(g => {
    seen.push(g.externalId);
    const rule = rules[g.externalId];
    if (rule && rule.times > 0) {
      rule.times -= 1;
      return { externalId: g.externalId, success: false, error: rule.error };
    }
    return { externalId: g.externalId, success: true };
  });
  return { send, seen };
}

const temp = { message: 'Row locked', retryable: true };
const perm = { message: 'Invalid email', retryable: false };

test('one bad record does not stop the others', async () => {
  const items = make(5);
  const t = target({ 'C-2': { times: 99, error: perm } });
  const counts = await runPass(items, t.send);
  assert.deepEqual(counts, { Pending: 0, Succeeded: 4, Failed: 0, Dead: 1 });
  assert.equal(items[2].error, 'Invalid email');
});

test('the second pass retries only the failures', async () => {
  const items = make(5);
  const t = target({ 'C-1': { times: 1, error: temp }, 'C-3': { times: 1, error: temp } });
  await runPass(items, t.send, { now: 0 });
  t.seen.length = 0;
  await runPass(items, t.send, { now: 10_000 });
  assert.deepEqual(t.seen.sort(), ['C-1', 'C-3']);
  assert.equal(summarize(items).Succeeded, 5);
});

test('failures wait for their backoff before being retried', async () => {
  const items = make(2);
  const t = target({ 'C-0': { times: 1, error: temp } });
  await runPass(items, t.send, { now: 0 });
  assert.equal(selectDue(items, 500).length, 0);
  assert.equal(selectDue(items, 1000).length, 1);
});

test('records become Dead after the maximum attempts', async () => {
  const items = make(1);
  const t = target({ 'C-0': { times: 99, error: temp } });
  await runPass(items, t.send, { now: 0, maxAttempts: 3 });
  await runPass(items, t.send, { now: 100_000, maxAttempts: 3 });
  await runPass(items, t.send, { now: 200_000, maxAttempts: 3 });
  assert.equal(items[0].status, STATUS.DEAD);
  assert.equal(items[0].attempts, 3);
});

test('a record missing from the response is retried, not assumed done', async () => {
  const items = make(2);
  await runPass(items, async () => [{ externalId: 'C-0', success: true }]);
  assert.equal(items[0].status, STATUS.SUCCEEDED);
  assert.equal(items[1].status, STATUS.FAILED);
});

test('a whole-call failure marks every record in the chunk as retryable', async () => {
  const items = make(3);
  await runPass(items, async () => { throw new Error('timeout'); });
  assert.deepEqual(summarize(items), { Pending: 0, Succeeded: 0, Failed: 3, Dead: 0 });
});

test('succeeded records are never sent again', async () => {
  const items = make(3);
  const t = target({});
  await runPass(items, t.send);
  t.seen.length = 0;
  await runPass(items, t.send, { now: 999_999 });
  assert.equal(t.seen.length, 0);
});

test('chunks respect the size limit', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.equal(chunk([], 200).length, 0);
});
```

Run `node --test tools/batchKit.test.mjs`. Expected: 8 tests pass. Note the test "a record missing from the response is retried, not assumed done": silence is not success.

## Advanced end-to-end example

Now the Apex implementation for the Salesforce side.

### 1. Loading a batch with per-record results

```apex
public with sharing class ContactSync {
    public class ItemResult {
        public String coreId;
        public Boolean success;
        public String message;
        public Boolean retryable;
    }

    // Upsert on the external id with allOrNone=false and map each result back by index,
    // then to the external id, so we can update the matching Sync_Item__c.
    public static List<ItemResult> upsertContacts(List<Contact> contacts) {
        List<Database.UpsertResult> saved = Database.upsert(
            contacts, Contact.Core_Id__c, false);
        List<ItemResult> out = new List<ItemResult>();
        for (Integer i = 0; i < saved.size(); i++) {
            ItemResult r = new ItemResult();
            r.coreId = contacts[i].Core_Id__c;
            r.success = saved[i].isSuccess();
            if (!r.success) {
                Database.Error err = saved[i].getErrors()[0];
                r.message = err.getStatusCode() + ': ' + err.getMessage();
                r.retryable = isRetryable(err.getStatusCode());
            }
            out.add(r);
        }
        return out;
    }

    public static Boolean isRetryable(StatusCode code) {
        return code == StatusCode.UNABLE_TO_LOCK_ROW
            || code == StatusCode.SERVER_UNAVAILABLE
            || code == StatusCode.REQUEST_RUNNING_TOO_LONG;
    }
}
```

The results list from `Database.upsert` is in the same order as the input list, which is why indexing is safe *inside one Apex call*. For external APIs, use the id in the response.

### 2. Status rules (pure Apex)

```apex
public with sharing class SyncRules {
    public static final Integer MAX_ATTEMPTS = 3;

    public static Integer backoffMinutes(Integer attempts) {
        return Math.min(60, (Integer) Math.pow(2, attempts - 1));
    }

    public static void apply(Sync_Item__c item, Boolean success, String message,
                             Boolean retryable, Datetime now) {
        item.Attempts__c = (item.Attempts__c == null ? 0 : item.Attempts__c) + 1;
        if (success) {
            item.Status__c = 'Succeeded';
            item.Last_Error__c = null;
            return;
        }
        item.Last_Error__c = message;
        if (!retryable || item.Attempts__c >= MAX_ATTEMPTS) {
            item.Status__c = 'Dead';
            return;
        }
        item.Status__c = 'Failed';
        item.Next_Retry_At__c = now.addMinutes(backoffMinutes((Integer) item.Attempts__c));
    }

    public static Boolean isDue(Sync_Item__c item, Datetime now) {
        return item.Status__c == 'Pending'
            || (item.Status__c == 'Failed' && item.Next_Retry_At__c <= now);
    }
}
```

### 3. The Queueable that retries only the due items

```apex
public with sharing class SyncPassJob implements Queueable {
    private static final Integer CHUNK = 200;

    public void execute(QueueableContext ctx) {
        Datetime now = Datetime.now();
        List<Sync_Item__c> due = [
            SELECT Id, Core_Id__c, Status__c, Attempts__c, Payload__c, Next_Retry_At__c
            FROM Sync_Item__c
            WHERE Status__c = 'Pending'
               OR (Status__c = 'Failed' AND Next_Retry_At__c <= :now)
            ORDER BY CreatedDate
            LIMIT :CHUNK
        ];
        if (due.isEmpty()) {
            return;
        }

        List<Contact> contacts = new List<Contact>();
        for (Sync_Item__c item : due) {
            Map<String, Object> data = (Map<String, Object>) JSON.deserializeUntyped(item.Payload__c);
            contacts.add(new Contact(
                Core_Id__c = item.Core_Id__c,
                LastName = (String) data.get('lastName'),
                Email = (String) data.get('email')
            ));
        }

        List<ContactSync.ItemResult> results = ContactSync.upsertContacts(contacts);
        Map<String, ContactSync.ItemResult> byId = new Map<String, ContactSync.ItemResult>();
        for (ContactSync.ItemResult r : results) {
            byId.put(r.coreId, r);
        }
        for (Sync_Item__c item : due) {
            ContactSync.ItemResult r = byId.get(item.Core_Id__c);
            if (r == null) {
                SyncRules.apply(item, false, 'No result returned', true, now);
            } else {
                SyncRules.apply(item, r.success, r.message, r.retryable, now);
            }
        }
        update due;

        // More work waiting? Chain, but only if something is still due.
        Integer remaining = [
            SELECT COUNT() FROM Sync_Item__c
            WHERE Status__c = 'Pending'
               OR (Status__c = 'Failed' AND Next_Retry_At__c <= :now)
        ];
        if (remaining > 0 && !Test.isRunningTest()) {
            System.enqueueJob(new SyncPassJob());
        }
    }
}
```

Records that are `Failed` with a future retry time are not chained forever; a scheduled job (below) wakes the pass up later.

### 4. The scheduled sweeper

```apex
public with sharing class SyncSweeper implements Schedulable {
    public void execute(SchedulableContext ctx) {
        Integer waiting = [
            SELECT COUNT() FROM Sync_Item__c
            WHERE Status__c = 'Pending'
               OR (Status__c = 'Failed' AND Next_Retry_At__c <= :Datetime.now())
        ];
        if (waiting > 0) {
            System.enqueueJob(new SyncPassJob());
        }
    }
}
```

Schedule it every 15 minutes (Setup, Apex Classes, Schedule Apex, or `System.schedule` with a cron expression).

### 5. Tests

```apex
@IsTest
private class SyncRulesTest {
    @IsTest
    static void successMarksSucceeded() {
        Sync_Item__c item = new Sync_Item__c(Status__c = 'Pending', Attempts__c = 0);
        SyncRules.apply(item, true, null, false, Datetime.now());
        System.assertEquals('Succeeded', item.Status__c);
        System.assertEquals(1, item.Attempts__c);
    }

    @IsTest
    static void permanentErrorIsDeadImmediately() {
        Sync_Item__c item = new Sync_Item__c(Status__c = 'Pending', Attempts__c = 0);
        SyncRules.apply(item, false, 'INVALID_EMAIL_ADDRESS', false, Datetime.now());
        System.assertEquals('Dead', item.Status__c);
    }

    @IsTest
    static void temporaryErrorWaitsThenGoesDeadAtTheLimit() {
        Datetime now = Datetime.newInstance(2026, 11, 18, 10, 0, 0);
        Sync_Item__c item = new Sync_Item__c(Status__c = 'Pending', Attempts__c = 0);
        SyncRules.apply(item, false, 'locked', true, now);
        System.assertEquals('Failed', item.Status__c);
        System.assertEquals(now.addMinutes(1), item.Next_Retry_At__c);
        SyncRules.apply(item, false, 'locked', true, now);
        SyncRules.apply(item, false, 'locked', true, now);
        System.assertEquals('Dead', item.Status__c);
    }

    @IsTest
    static void onlyDueItemsAreSelected() {
        Datetime now = Datetime.newInstance(2026, 11, 18, 10, 0, 0);
        System.assertEquals(true, SyncRules.isDue(new Sync_Item__c(Status__c = 'Pending'), now));
        System.assertEquals(false, SyncRules.isDue(new Sync_Item__c(Status__c = 'Succeeded'), now));
        System.assertEquals(false, SyncRules.isDue(new Sync_Item__c(Status__c = 'Dead'), now));
        System.assertEquals(false, SyncRules.isDue(new Sync_Item__c(
            Status__c = 'Failed', Next_Retry_At__c = now.addMinutes(5)), now));
        System.assertEquals(true, SyncRules.isDue(new Sync_Item__c(
            Status__c = 'Failed', Next_Retry_At__c = now.addMinutes(-1)), now));
    }

    @IsTest
    static void upsertOnExternalIdDoesNotDuplicate() {
        List<Contact> batch = new List<Contact>{
            new Contact(Core_Id__c = 'C-1', LastName = 'Ng'),
            new Contact(Core_Id__c = 'C-2', LastName = '')   // invalid: LastName is required
        };
        List<ContactSync.ItemResult> first = ContactSync.upsertContacts(batch);
        System.assertEquals(true, first[0].success);
        System.assertEquals(false, first[1].success);
        ContactSync.upsertContacts(new List<Contact>{
            new Contact(Core_Id__c = 'C-1', LastName = 'Ng') });
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Core_Id__c = 'C-1']);
    }
}
```

The Apex is syntax-checked but not compiled here. Run it in a scratch org and adjust field names. The `StatusCode` values should be checked against your org's error output.

### 6. The same idea over the REST API

For an external system pushing into Salesforce, use sObject Collections with `allOrNone` false and an external id upsert, then read the per-record results:

```bash
curl -s -X PATCH "$INSTANCE/services/data/v62.0/composite/sobjects/Contact/Core_Id__c" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"allOrNone": false, "records": [
        {"attributes": {"type": "Contact"}, "Core_Id__c": "C-1", "LastName": "Ng"},
        {"attributes": {"type": "Contact"}, "Core_Id__c": "C-2", "LastName": ""}
      ]}'
# Response: an array with one entry per record, in order:
# [{"id":"003...","success":true,"errors":[],"created":true},
#  {"success":false,"errors":[{"statusCode":"REQUIRED_FIELD_MISSING","message":"...","fields":["LastName"]}]}]
```

Check the current API version number in your org before using this call.

## What happens behind the scenes

1. A loader inserts one `Sync_Item__c` per source record with status `Pending`. The unique external id means a record loaded twice is one row.
2. `SyncPassJob` selects up to 200 due rows: `Pending`, plus `Failed` rows whose retry time has passed.
3. The job upserts the Contacts with `allOrNone=false`. Salesforce saves the good ones and returns an error for each bad one, so no transaction rolls back because of a neighbour.
4. Each result is mapped to its `Sync_Item__c` by external id. Success sets `Succeeded`. A lock error sets `Failed` with a retry time. An invalid email sets `Dead` immediately.
5. The job saves the status changes and chains itself only if rows are still due. The scheduled sweeper wakes it when backed-off rows become due.
6. On the next pass only the 2 failed records are sent, never the 198 that succeeded. After three attempts a stubborn record goes `Dead` with its last error, visible in a list view for a person to fix.
7. If the whole call fails (limit exception, outage), the rows stay `Pending` or are marked `Failed`, and the same rules apply.

## Choosing where the retry state lives

Keeping status on a separate `Sync_Item__c` row is the safest because the state survives a failed batch. If a record is a Salesforce record you own, a status field on it is simpler, but remember a failed transaction rolls that field back too. For very large volumes, Bulk API 2.0 returns separate success and failure result files, so load the failed file into your status table and re-submit only those rows. Keep chunk sizes moderate: a smaller chunk limits how many records a lock or an error can affect.

Use a dead state, and a list view or report on it. A dead item with the last error and attempt count is a task for a person. Without it, failures turn into silently missing data.

## Test it and verify

1. Run `node --test tools/batchKit.test.mjs`. Expected: 8 pass.
2. Run the Apex tests: `sf apex run test --tests SyncRulesTest --result-format human --wait 10`. Expected: 5 pass.
3. Insert five `Sync_Item__c` rows, one with an empty last name in its payload. Run `System.enqueueJob(new SyncPassJob());` from anonymous Apex. Expected: four `Succeeded`, one `Dead` with the required-field error.
4. Fix the payload of the dead row, set it to `Pending`, and run the job again. Expected: only that row is processed, and the Contact count rises by one.
5. Run the job again. Expected: nothing is sent; no duplicates are created.

## Common mistakes and fixes

- **Symptom: one bad record rolls back the whole batch.** Cause: `insert` or `update` with the default all-or-none behaviour. Fix: `Database.insert(records, false)` or `Database.upsert(records, field, false)`.
- **Symptom: errors are attached to the wrong record.** Cause: matching results to records by guesswork. Fix: match by external id, or by index only inside the same Apex call.
- **Symptom: a rerun creates duplicate Contacts.** Cause: plain insert. Fix: upsert on a unique External ID field.
- **Symptom: the whole file is resent after a small failure.** Cause: no per-record status. Fix: keep a status row per record and select only due rows.
- **Symptom: a permanently bad record is retried forever.** Cause: no classification or cap. Fix: permanent errors go straight to `Dead`, and temporary ones stop after a maximum.
- **Symptom: silence from the API is treated as success.** Cause: only failures are processed. Fix: treat a record missing from the response as retryable.
- **Symptom: retry storm after an outage.** Cause: immediate retries. Fix: backoff with a stored next-retry time and a scheduled sweeper.

## Key takeaways

- Track status per record, not per batch.
- Send with allOrNone off, and match results by external id.
- Classify failures: temporary goes to `Failed` with backoff, permanent goes to `Dead`.
- Select only `Pending` and due `Failed` rows, so retries touch only the failures.
- Upserts on an external id keep a repeated send harmless.

## Where to go next

- [Timeouts, duplicates and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/)
- [Safe retries for Agentforce actions](/articles/agentforce-actions-safe-retries-idempotency/)
- [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/)
- [Composite API guide](/articles/composite-api-guide/)
- [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/)
