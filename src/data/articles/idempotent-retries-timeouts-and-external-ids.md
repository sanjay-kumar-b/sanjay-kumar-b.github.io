---
title: "Safe Retries in Integrations: Timeouts, Duplicates and External IDs"
description: "Handle the timeout where the other side actually succeeded: idempotency keys, external IDs, a request ledger, retry classification and tests in Apex and Node."
category: salesforce-development
tags: [Integration, Retries, Idempotency, External ID, Apex]
publishedAt: 2026-11-18
updatedAt: 2026-11-18
cover: /images/covers/idempotent-retries-timeouts-and-external-ids.jpg
sources:
  - title: "Apex Developer Guide: Callouts"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
  - title: "Salesforce Help: External IDs and upsert"
    url: "https://help.salesforce.com/s/products/platform"
---

Every integration eventually meets this moment: your Apex code sends a request, waits 20 seconds, and gets a timeout. Did the other system do the work or not? You do not know. If you retry blindly and it had worked, you now have a duplicate payment, a second shipment, or two records for the same customer. If you do not retry and it had not worked, the order is lost.

The timeout where the other side actually succeeded is the hardest failure in integration work, because the error message tells you nothing about what happened. This article shows how to make that case safe, using three tools that work together: **idempotency keys** (so a repeated request is recognised), **external IDs** (so a repeated record is recognised) and a **request ledger** (so you always know what you sent and what you learned).

For batches where only some records fail, continue with [partial batch failures and per-record status](/articles/batch-partial-failures-per-record-status-retry/). For the general theory of reliability, see [integration reliability and idempotency](/articles/integration-reliability-idempotency/).

## The business scenario

Crestline Lending (a fictional lender) pushes each approved loan to its payment processor with `POST /charges`. A rep clicks Approve, a Queueable job calls the processor, and the processor returns a charge id. Three things go wrong in production: the processor sometimes takes longer than 20 seconds (timeout), sometimes answers `503` while busy, and once, after a network blip, a customer was charged twice because a retry repeated a request that had already succeeded.

The goal: a customer is charged exactly once, no matter how many times the job runs.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create a custom object `Integration_Request__c` (the ledger) with these fields: `Idempotency_Key__c` (Text 120, **External ID**, **Unique**), `Related_Id__c` (Text 18), `Status__c` (Picklist: Pending, Succeeded, Failed, Unknown), `Attempts__c` (Number 2,0), `External_Reference__c` (Text 80), `Last_Error__c` (Long Text 2000), `Request_Body__c` (Long Text 32000). Verify: the object and fields show in Object Manager, and the key field is marked Unique.
3. Create an External Credential and a Named Credential called `Payments` that points at the processor's base URL, and grant principal access through a permission set (see [Named Credentials](/articles/rest-callouts-named-credentials/)). Verify: anonymous Apex can call `callout:Payments/health`.
4. Give the integration user create and edit access to `Integration_Request__c`.

### In the external system

5. Confirm the processor supports idempotency. Look in its documentation for an `Idempotency-Key` header, how long keys are remembered (often 24 hours), and what it returns for a repeat (usually the original response). Verify: send the same key twice with `curl` and check that you get one charge.
6. If it has no idempotency support, ask whether you can send your own reference id and look charges up by it (`GET /charges?reference=...`). The ledger pattern below still works; the retry step becomes "look up, then create".
7. For practice without a vendor, run the Node simulation in the verify section.

## How it works

The whole design fits in four rules:

1. **Decide the key before the first attempt.** The key identifies the business operation ("charge loan L-100, version 1"), not the HTTP attempt. Every retry of that operation sends the same key.
2. **Write the intent to the ledger first.** A `Pending` row with the key exists before the callout starts, so a crash or timeout always leaves evidence.
3. **Classify every outcome.** Success, retry, fatal, or unknown. A timeout is *unknown*, never "failed".
4. **Retry unknown outcomes only with a key (or after a lookup).** Without protection, stop and reconcile instead.

External IDs play the same role inside Salesforce and when you write data back: an upsert on an external id turns "insert again" into "update the same record".

## Basic example

The smallest safe version: a stable key and one retry-aware client. This Node model is the logic we will mirror in Apex. It classifies results, backs off, and refuses to retry an unknown outcome unless a key is present.

```javascript
// A small model of safe retries: classify outcomes, back off, and use idempotency keys.

export const OUTCOME = { SUCCESS: 'success', RETRY: 'retry', UNKNOWN: 'unknown', FATAL: 'fatal' };

// Decide what an attempt's result means. "unknown" is the dangerous one: the other
// side may have done the work even though we never saw the answer.
export function classify(result) {
  if (result.error === 'timeout' || result.error === 'connection-reset') {
    return OUTCOME.UNKNOWN;
  }
  if (result.error === 'connection-refused' || result.error === 'dns') {
    return OUTCOME.RETRY; // the request never reached the server
  }
  const status = result.status;
  if (status >= 200 && status < 300) {
    return OUTCOME.SUCCESS;
  }
  if (status === 408 || status === 429 || status === 502 || status === 503 || status === 504) {
    return OUTCOME.RETRY;
  }
  if (status >= 500) {
    return OUTCOME.UNKNOWN; // a plain 500 may have failed halfway through
  }
  return OUTCOME.FATAL; // 400, 401, 403, 404, 409, 422 ...
}

// Exponential backoff with "full jitter"; Retry-After (seconds) wins when present.
export function delayMs(attempt, { base = 200, cap = 10000, retryAfter, random = Math.random } = {}) {
  if (retryAfter !== undefined) {
    return Math.min(Number(retryAfter) * 1000, cap);
  }
  return Math.floor(random() * Math.min(cap, base * 2 ** attempt));
}

// A pretend payment API. It can "lose" the response after doing the work.
export class FakeServer {
  constructor({ script = [] } = {}) {
    this.script = [...script]; // per-call behaviour: 'ok', 'lose-response', 'busy', 'bad', or a number
    this.charges = [];
    this.byKey = new Map();
  }

  handle(request) {
    const step = this.script.shift() ?? 'ok';
    if (step === 'busy') {
      return { status: 429, retryAfter: 1 };
    }
    if (step === 'bad') {
      return { status: 400 };
    }
    if (typeof step === 'number') {
      return { status: step };
    }

    const key = request.headers?.['Idempotency-Key'];
    if (key && this.byKey.has(key)) {
      const saved = this.byKey.get(key);
      if (saved.fingerprint !== JSON.stringify(request.body)) {
        return { status: 422, body: { error: 'Key reused with a different request' } };
      }
      return { status: 200, body: saved.response, replayed: true };
    }

    const charge = { id: 'ch_' + (this.charges.length + 1), amount: request.body.amount };
    this.charges.push(charge);
    if (key) {
      this.byKey.set(key, { fingerprint: JSON.stringify(request.body), response: charge });
    }
    if (step === 'lose-response') {
      return { error: 'timeout' }; // the work is done; the caller never hears about it
    }
    return { status: 201, body: charge };
  }
}

export async function sendWithRetry(server, request, { maxAttempts = 4, sleep = async () => {}, random = () => 0.5 } = {}) {
  const log = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = server.handle(request);
    const kind = classify(result);
    log.push({ attempt: attempt + 1, kind, status: result.status, error: result.error });

    if (kind === OUTCOME.SUCCESS) {
      return { ok: true, body: result.body, log };
    }
    if (kind === OUTCOME.FATAL) {
      return { ok: false, reason: 'fatal', log };
    }
    const hasKey = Boolean(request.headers?.['Idempotency-Key']);
    if (kind === OUTCOME.UNKNOWN && !hasKey) {
      // Without a key a retry could do the work twice. Stop and ask a human or reconcile.
      return { ok: false, reason: 'unknown-outcome', log };
    }
    await sleep(delayMs(attempt, { retryAfter: result.retryAfter, random }));
  }
  return { ok: false, reason: 'out-of-attempts', log };
}

// A stable key for one logical operation: same inputs give the same key, so a retry reuses it.
export function keyFor(operation, recordId, version) {
  return `${operation}:${recordId}:${version}`;
}
```

Its tests prove the behaviour, including the dangerous case where the server did the work and then lost the response:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FakeServer, OUTCOME, classify, delayMs, keyFor, sendWithRetry } from './retryKit.mjs';

const payment = key => ({
  body: { orderId: 'O-1', amount: 100 },
  headers: key ? { 'Idempotency-Key': key } : {}
});

test('classify separates retryable, unknown and fatal results', () => {
  assert.equal(classify({ status: 201 }), OUTCOME.SUCCESS);
  assert.equal(classify({ status: 429 }), OUTCOME.RETRY);
  assert.equal(classify({ status: 503 }), OUTCOME.RETRY);
  assert.equal(classify({ status: 500 }), OUTCOME.UNKNOWN);
  assert.equal(classify({ error: 'timeout' }), OUTCOME.UNKNOWN);
  assert.equal(classify({ error: 'connection-refused' }), OUTCOME.RETRY);
  assert.equal(classify({ status: 400 }), OUTCOME.FATAL);
  assert.equal(classify({ status: 409 }), OUTCOME.FATAL);
});

test('a timeout after the server finished does NOT blindly retry without a key', async () => {
  const server = new FakeServer({ script: ['lose-response'] });
  const result = await sendWithRetry(server, payment(null));
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unknown-outcome');
  assert.equal(server.charges.length, 1, 'the work was done once; we must reconcile, not repeat');
});

test('a naive retry loop charges the customer twice', async () => {
  const server = new FakeServer({ script: ['lose-response', 'ok'] });
  for (let i = 0; i < 2; i++) {
    server.handle(payment(null)); // what a careless "retry on any error" loop does
  }
  assert.equal(server.charges.length, 2);
});

test('with an idempotency key a retry after a lost response charges once', async () => {
  const server = new FakeServer({ script: ['lose-response', 'ok'] });
  const result = await sendWithRetry(server, payment('charge:O-1:1'));
  assert.equal(result.ok, true);
  assert.equal(server.charges.length, 1);
  assert.equal(result.body.id, 'ch_1');
  assert.deepEqual(result.log.map(l => l.kind), [OUTCOME.UNKNOWN, OUTCOME.SUCCESS]);
});

test('reusing a key with a different payload is rejected', async () => {
  const server = new FakeServer();
  await sendWithRetry(server, payment('k'));
  const other = { body: { orderId: 'O-1', amount: 999 }, headers: { 'Idempotency-Key': 'k' } };
  const result = await sendWithRetry(server, other);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'fatal');
});

test('429 waits for Retry-After and then succeeds', async () => {
  const waits = [];
  const server = new FakeServer({ script: ['busy', 'ok'] });
  const result = await sendWithRetry(server, payment('k2'), { sleep: async ms => waits.push(ms) });
  assert.equal(result.ok, true);
  assert.deepEqual(waits, [1000]);
});

test('a 400 is never retried', async () => {
  const server = new FakeServer({ script: ['bad', 'ok'] });
  const result = await sendWithRetry(server, payment('k3'));
  assert.equal(result.reason, 'fatal');
  assert.equal(result.log.length, 1);
});

test('retries stop after the attempt limit', async () => {
  const server = new FakeServer({ script: [503, 503, 503, 503, 503] });
  const result = await sendWithRetry(server, payment('k4'), { maxAttempts: 3 });
  assert.equal(result.reason, 'out-of-attempts');
  assert.equal(result.log.length, 3);
});

test('backoff grows, is capped and uses jitter', () => {
  assert.equal(delayMs(0, { random: () => 1 }), 200);
  assert.equal(delayMs(3, { random: () => 1 }), 1600);
  assert.equal(delayMs(10, { random: () => 1, cap: 5000 }), 5000);
  assert.equal(delayMs(2, { random: () => 0 }), 0);
});

test('keys are stable for the same operation and change for a new one', () => {
  assert.equal(keyFor('charge', 'O-1', 3), keyFor('charge', 'O-1', 3));
  assert.notEqual(keyFor('charge', 'O-1', 3), keyFor('charge', 'O-1', 4));
});
```

Run them with `node --test tools/retryKit.test.mjs`. Expected: 10 tests pass. Read the test named "with an idempotency key a retry after a lost response charges once": the first attempt returns a timeout after the charge exists, the second attempt reuses the key, the server replays the saved answer, and the ledger of charges still has exactly one entry.

## Advanced end-to-end example

Now the Salesforce side. The pieces: a pure classifier you can unit test, a ledger-backed service, a Queueable that re-enqueues itself with a delay, and mocked tests.

### 1. The retry policy (pure Apex)

```apex
public with sharing class RetryPolicy {
    public enum Outcome { SUCCESS, RETRY, UNKNOWN, FATAL }

    public static Outcome classify(Integer statusCode, Boolean timedOut) {
        if (timedOut == true) {
            return Outcome.UNKNOWN;
        }
        if (statusCode >= 200 && statusCode < 300) {
            return Outcome.SUCCESS;
        }
        if (statusCode == 408 || statusCode == 429 || statusCode == 502
            || statusCode == 503 || statusCode == 504) {
            return Outcome.RETRY;
        }
        if (statusCode >= 500) {
            return Outcome.UNKNOWN;
        }
        return Outcome.FATAL;
    }

    // Minutes to wait before attempt number "attempt" (1-based). Queueable allows 0 to 10.
    public static Integer delayMinutes(Integer attempt) {
        Integer minutes = (Integer) Math.pow(2, attempt - 1);
        return Math.min(minutes, 10);
    }

    public static Boolean mayRetry(Outcome outcome, Boolean hasKey) {
        if (outcome == Outcome.RETRY) {
            return true;
        }
        return outcome == Outcome.UNKNOWN && hasKey;
    }
}
```

### 2. The ledger and the idempotent call

```apex
public with sharing class ChargeService {
    public class ChargeResult {
        public Boolean done;
        public Boolean retry;
        public String reference;
        public String message;
    }

    public static String keyFor(Id loanId, Integer version) {
        return 'charge:' + loanId + ':' + version;
    }

    // Creates the Pending row once; repeated calls return the same row (upsert on the external id).
    public static Integration_Request__c openLedger(Id loanId, Integer version, String body) {
        String key = keyFor(loanId, version);
        List<Integration_Request__c> existing = [
            SELECT Id, Status__c, Attempts__c, External_Reference__c, Request_Body__c
            FROM Integration_Request__c WHERE Idempotency_Key__c = :key LIMIT 1
        ];
        if (!existing.isEmpty()) {
            return existing[0];
        }
        Integration_Request__c row = new Integration_Request__c(
            Idempotency_Key__c = key,
            Related_Id__c = loanId,
            Status__c = 'Pending',
            Attempts__c = 0,
            Request_Body__c = body
        );
        insert row;
        return row;
    }

    public static ChargeResult send(Integration_Request__c row) {
        ChargeResult result = new ChargeResult();
        if (row.Status__c == 'Succeeded') {
            result.done = true;
            result.reference = row.External_Reference__c;
            result.message = 'Already completed';
            return result;
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Payments/charges');
        req.setMethod('POST');
        req.setTimeout(20000);
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Idempotency-Key', row.Idempotency_Key__c);
        req.setBody(row.Request_Body__c);

        row.Attempts__c = (row.Attempts__c == null ? 0 : row.Attempts__c) + 1;
        Integer status = 0;
        Boolean timedOut = false;
        String body = '';
        try {
            HttpResponse res = new Http().send(req);
            status = res.getStatusCode();
            body = res.getBody();
        } catch (System.CalloutException e) {
            timedOut = true;
            result.message = e.getMessage();
        }

        RetryPolicy.Outcome outcome = RetryPolicy.classify(status, timedOut);
        result.done = outcome == RetryPolicy.Outcome.SUCCESS;
        result.retry = RetryPolicy.mayRetry(outcome, true);

        if (result.done) {
            Map<String, Object> parsed = (Map<String, Object>) JSON.deserializeUntyped(body);
            row.Status__c = 'Succeeded';
            row.External_Reference__c = String.valueOf(parsed.get('id'));
            result.reference = row.External_Reference__c;
        } else {
            row.Status__c = outcome == RetryPolicy.Outcome.FATAL ? 'Failed' : 'Unknown';
            row.Last_Error__c = (result.message != null ? result.message : 'HTTP ' + status);
        }
        update row;
        return result;
    }
}
```

Two details matter. The row is updated *after* the callout, never before it in the same transaction, because DML before a callout throws "uncommitted work pending". That is why the Pending row is created in the transaction that enqueues the job, and the callout runs in the job.

### 3. The Queueable that retries with a delay

```apex
public with sharing class ChargeJob implements Queueable, Database.AllowsCallouts {
    private Id requestId;
    private Integer maxAttempts;

    public ChargeJob(Id requestId, Integer maxAttempts) {
        this.requestId = requestId;
        this.maxAttempts = maxAttempts;
    }

    public void execute(QueueableContext ctx) {
        Integration_Request__c row = [
            SELECT Id, Idempotency_Key__c, Status__c, Attempts__c,
                   External_Reference__c, Request_Body__c
            FROM Integration_Request__c WHERE Id = :requestId
        ];
        ChargeService.ChargeResult result = ChargeService.send(row);
        if (result.done || !result.retry) {
            return;
        }
        Integer attempts = (Integer) row.Attempts__c;
        if (attempts >= maxAttempts) {
            row.Status__c = 'Failed';
            row.Last_Error__c = 'Gave up after ' + attempts + ' attempts. Reconcile manually.';
            update row;
            return;
        }
        System.enqueueJob(new ChargeJob(requestId, maxAttempts),
                          RetryPolicy.delayMinutes(attempts));
    }
}
```

### 4. Tests with mocks

```apex
@IsTest
private class ChargeServiceTest {
    private class SequenceMock implements HttpCalloutMock {
        private List<Integer> codes;
        private Integer index = 0;
        public Integer calls = 0;
        SequenceMock(List<Integer> codes) { this.codes = codes; }

        public HttpResponse respond(HttpRequest req) {
            calls++;
            Integer code = codes[Math.min(index++, codes.size() - 1)];
            if (code == 0) {
                throw new CalloutException('Read timed out');
            }
            HttpResponse res = new HttpResponse();
            res.setStatusCode(code);
            res.setBody('{"id":"ch_1"}');
            return res;
        }
    }

    @IsTest
    static void successMarksLedgerSucceeded() {
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 201 }));
        Integration_Request__c row = ChargeService.openLedger(
            '001000000000001AAA', 1, '{"amount":100}');
        Test.startTest();
        ChargeService.ChargeResult r = ChargeService.send(row);
        Test.stopTest();
        System.assertEquals(true, r.done);
        System.assertEquals('ch_1', r.reference);
    }

    @IsTest
    static void timeoutIsUnknownAndRetryable() {
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 0 }));
        Integration_Request__c row = ChargeService.openLedger(
            '001000000000001AAA', 1, '{"amount":100}');
        ChargeService.ChargeResult r = ChargeService.send(row);
        System.assertEquals(false, r.done);
        System.assertEquals(true, r.retry);
        System.assertEquals('Unknown', [SELECT Status__c FROM Integration_Request__c LIMIT 1].Status__c);
    }

    @IsTest
    static void secondRunWithSameKeyDoesNotCallOutAgain() {
        SequenceMock mock = new SequenceMock(new List<Integer>{ 201 });
        Test.setMock(HttpCalloutMock.class, mock);
        Integration_Request__c row = ChargeService.openLedger(
            '001000000000001AAA', 1, '{"amount":100}');
        ChargeService.send(row);
        Integration_Request__c again = ChargeService.openLedger(
            '001000000000001AAA', 1, '{"amount":100}');
        ChargeService.send(again);
        System.assertEquals(1, mock.calls);
        System.assertEquals(1, [SELECT COUNT() FROM Integration_Request__c]);
    }

    @IsTest
    static void badRequestIsFatalAndNotRetried() {
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 400 }));
        Integration_Request__c row = ChargeService.openLedger(
            '001000000000001AAA', 1, '{"amount":-5}');
        ChargeService.ChargeResult r = ChargeService.send(row);
        System.assertEquals(false, r.retry);
        System.assertEquals('Failed', [SELECT Status__c FROM Integration_Request__c LIMIT 1].Status__c);
    }

    @IsTest
    static void policyBacksOffAndCaps() {
        System.assertEquals(1, RetryPolicy.delayMinutes(1));
        System.assertEquals(4, RetryPolicy.delayMinutes(3));
        System.assertEquals(10, RetryPolicy.delayMinutes(8));
        System.assertEquals(false, RetryPolicy.mayRetry(RetryPolicy.Outcome.UNKNOWN, false));
    }
}
```

The Apex above is syntax-checked but was not compiled against an org: run the tests in your scratch org and adjust field API names if yours differ.

### 5. Writing data back with an external ID

When the processor sends a webhook or your job syncs records, upsert on the external id so a repeated message updates instead of duplicating:

```apex
public with sharing class ChargeWriteBack {
    public static void apply(String loanExternalId, String chargeRef) {
        Loan__c loan = new Loan__c(
            Loan_Number__c = loanExternalId,
            Charge_Reference__c = chargeRef,
            Payment_Status__c = 'Paid'
        );
        // Loan_Number__c is an External ID field. Same input twice gives one record.
        Database.UpsertResult result = Database.upsert(loan, Loan__c.Loan_Number__c, false);
        if (!result.isSuccess()) {
            throw new IntegrationException(result.getErrors()[0].getMessage());
        }
    }
    public class IntegrationException extends Exception {}
}
```

## What happens behind the scenes

1. The rep approves the loan. A trigger or flow calls `openLedger`, which inserts one `Pending` row with key `charge:<loanId>:1` and enqueues `ChargeJob`. If the same approval fires twice, the unique External ID on the key makes the second insert fail or find the first row, so only one job per operation is meaningful.
2. The job loads the row and calls `callout:Payments/charges` with the `Idempotency-Key` header. The platform adds the credentials.
3. Case A, success: `201` with a charge id. The row becomes `Succeeded` and stores the reference.
4. Case B, `503`: the processor says it is busy. The row becomes `Unknown`, the job re-enqueues itself one minute later, and the retry carries the same key.
5. Case C, timeout after the work was done: the row becomes `Unknown`. The retry sends the same key; the processor recognises it and replays the original answer, so the customer is charged once.
6. Case D, `400`: a permanent error. The row becomes `Failed` and nothing retries, because repeating a bad request cannot help.
7. After the maximum attempts, the row is marked `Failed` with a message, and a person reconciles by looking the charge up by reference.

## Choosing the right hook

Pick what suits the system you integrate with. Systems that accept an `Idempotency-Key` header are the easy case. Systems that accept a client-supplied reference id need a lookup step before creating. Systems with neither need a lookup by natural attributes (order number, amount, timestamp window), and if even that is impossible, a timeout must be treated as "needs a human". When you own the receiving side, add idempotency there: store the key and the response, and return the saved response for repeats, as the Node simulation does.

Also decide how long keys live. A key that expires after 24 hours is useless if your retries can run three days later, so make the retry window shorter than the key lifetime, or create a new operation version deliberately.

## Test it and verify

1. Run `node --test tools/retryKit.test.mjs`. Expected: 10 pass.
2. Run the Apex tests: `sf apex run test --tests ChargeServiceTest --result-format human --wait 10`. Expected: 5 pass.
3. Set the Named Credential to a test server where you control the behaviour. Approve a loan and check `Integration_Request__c`: one row, `Succeeded`, attempts 1.
4. Make the server sleep 30 seconds on the first call and then work normally. Expected: attempt 1 ends `Unknown`, attempt 2 (one minute later) ends `Succeeded`, the server shows one charge.
5. Make the server answer `400`. Expected: one attempt, status `Failed`, no further jobs in Apex Jobs.
6. Try to insert a second ledger row with the same key by hand. Expected: a duplicate value error, which proves the unique External ID.

## Common mistakes and fixes

- **Symptom: customers are charged twice after a timeout.** Cause: retrying without a key, or generating a new key per attempt. Fix: build the key from the business operation and reuse it.
- **Symptom: `You have uncommitted work pending` when logging.** Cause: DML before the callout in the same transaction. Fix: create the ledger row earlier, and update after the callout.
- **Symptom: the same job runs twice and both call out.** Cause: no ledger check. Fix: check `Status__c` and attempts before sending, and keep the unique key.
- **Symptom: a timeout is stored as "Failed".** Cause: treating every exception as a failure. Fix: timeouts and plain `500`s are *unknown*.
- **Symptom: key reused with a different payload.** Cause: the amount changed between attempts. Fix: include a version in the key, and create a new version when the data changes.
- **Symptom: retries hammer a struggling service.** Cause: immediate retries. Fix: exponential backoff with jitter, honour `Retry-After`, and cap attempts.
- **Symptom: duplicate records inside Salesforce.** Cause: plain insert for inbound messages. Fix: upsert on an External ID field.

## Key takeaways

- A timeout means "unknown", not "failed". Design for the case where the other side succeeded.
- Choose the idempotency key from the business operation and send the same key on every retry.
- Write a ledger row before calling out, and record the outcome after.
- Retry only retryable or unknown outcomes, with backoff, a cap and a clear final state.
- Use External IDs and upsert so repeated inbound data updates rather than duplicates.

## Where to go next

- [Partial batch failures: per-record status and retry only the failures](/articles/batch-partial-failures-per-record-status-retry/)
- [Safe retries for Agentforce actions](/articles/agentforce-actions-safe-retries-idempotency/)
- [Outbound callouts: advanced patterns](/articles/outbound-callouts-advanced/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
