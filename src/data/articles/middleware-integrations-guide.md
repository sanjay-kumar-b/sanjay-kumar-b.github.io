---
title: "Middleware Integrations for Salesforce: MuleSoft, iPaaS and API-Led Design"
description: "When middleware pays off and what it does for Salesforce: a working Node example of transform, retry, dead-letter and write-back, plus API-led layers."
category: salesforce-development
tags: [Integration, MuleSoft, Middleware, Architecture, Advanced]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/middleware-integrations-guide.jpg
sources:
  - title: "MuleSoft documentation"
    url: "https://docs.mulesoft.com/"
  - title: "Integration Patterns (Salesforce Architects)"
    url: "https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns"
---

**Middleware** is software between systems that moves, transforms and orchestrates data. Examples include MuleSoft Anypoint Platform, Boomi, Workato, Informatica, Azure Logic Apps and Service Bus, AWS Step Functions, or a small custom service. Salesforce owns MuleSoft, so many Salesforce customers choose it, but the ideas apply to every tool. To make them concrete, this article builds the core of a middleware flow as a small Node service, so you can see what any tool is doing for you.

## The business scenario

Kestrel Manufacturing (a fictional company) sells through Salesforce, fulfils from an ERP that speaks XML, and tracks shipments in a logistics system. When an Opportunity is Closed Won, the ERP needs an XML order, the logistics system needs a shipment request, and Salesforce needs the ERP order number and status written back. Failures must be retried, bad messages must be parked, and operations staff need to trace one order across all three systems.

## Before you start: setup

### In Salesforce

1. Create a Platform Event `Order_Won__e` with fields `OpportunityId__c`, `AccountName__c`, `Amount__c` (number) and `Correlation_Id__c` (text), published from a record-triggered flow or Apex when an Opportunity becomes Closed Won.
2. On Opportunity, create `ERP_Order_Number__c` (text, External ID) and `Integration_Status__c` (picklist: Pending, Sent, Failed).
3. Create an External Client App for the middleware with client credentials, run as an integration user whose permission set allows read and edit on those fields and **subscribe** to `Order_Won__e`.
4. Do all of this in a sandbox first.

### In the external system

1. Register the middleware's service account in the ERP and the logistics system, and store each secret in a vault.
2. Set up separate endpoints and credentials for test and production. Never share them.
3. Provision a durable queue or dead-letter store in the middleware platform. In the example below it is a file; in production it is a managed queue.

## How it works

Middleware pays off when:

- Three or more systems must exchange data, so point-to-point wiring would become spaghetti.
- Data must be **transformed** between formats such as XML, EDI, CSV and JSON.
- You need **orchestration**: call A, then B, then update Salesforce.
- You need **central monitoring, retries and dead-letter queues**.
- Protocols differ: SOAP, SFTP, message queues or mainframes.
- You want business logic outside Apex.

When two systems exchange one simple message, a direct API call is fine. Middleware adds cost and operations work.

MuleSoft's **API-led connectivity** splits integrations into three layers:

1. **System APIs** are thin, stable wrappers over a system of record, such as the ERP or Salesforce.
2. **Process APIs** hold business logic that combines system APIs, such as "create customer order".
3. **Experience APIs** are shaped for one consumer, such as a mobile app or partner portal.

Each layer can change independently, and process APIs are reused by many experiences.

## Basic example

The simplest middleware flow is receive, transform, send:

```javascript
// simple-flow.mjs
export function toErpXml(order) {
  return `<Order><Customer>${order.AccountName__c}</Customer><Total>${order.Amount__c}</Total></Order>`;
}

export async function handle(order, postToErp) {
  await postToErp(toErpXml(order));
}
```

It has no retries, no logging and no protection against bad data, which is exactly what real middleware platforms add.

## Advanced end-to-end example

**src/transform.mjs**

```javascript
const escapeXml = value => String(value)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

export function validateEvent(event) {
  if (!event.OpportunityId__c) {
    return 'OpportunityId__c is required';
  }
  if (!event.AccountName__c) {
    return 'AccountName__c is required';
  }
  if (typeof event.Amount__c !== 'number' || event.Amount__c <= 0) {
    return 'Amount__c must be a positive number';
  }
  return null;
}

export function toErpXml(event) {
  return `<?xml version="1.0"?>\n<Order correlationId="${escapeXml(event.Correlation_Id__c)}">` +
    `<Reference>${escapeXml(event.OpportunityId__c)}</Reference>` +
    `<Customer>${escapeXml(event.AccountName__c)}</Customer>` +
    `<Total>${event.Amount__c.toFixed(2)}</Total></Order>`;
}

export function toShipment(event, erpOrderNumber) {
  return { orderNumber: erpOrderNumber, customer: event.AccountName__c, reference: event.OpportunityId__c };
}
```

**src/pipeline.mjs**

```javascript
import { validateEvent, toErpXml, toShipment } from './transform.mjs';

export class TransientError extends Error {}

export async function withRetry(fn, { attempts = 4, baseMs = 500, sleep = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!(err instanceof TransientError) || i === attempts) {
        throw err;
      }
      await sleep(baseMs * 2 ** (i - 1) + Math.floor(Math.random() * 100));
    }
  }
  throw last;
}

// systems = { erp, logistics, salesforce, deadLetter, log }
export async function processOrder(event, systems) {
  const cid = event.Correlation_Id__c || 'no-correlation-id';
  const log = (msg, extra = {}) => systems.log({ cid, msg, ...extra });

  const problem = validateEvent(event);
  if (problem) {
    await systems.deadLetter({ event, reason: problem, retryable: false });
    log('rejected', { problem });
    return 'rejected';
  }

  try {
    const erp = await withRetry(() => systems.erp(toErpXml(event), cid), systems.retry);
    await withRetry(() => systems.logistics(toShipment(event, erp.orderNumber), cid), systems.retry);
    await systems.salesforce(event.OpportunityId__c, { ERP_Order_Number__c: erp.orderNumber, Integration_Status__c: 'Sent' });
    log('completed', { orderNumber: erp.orderNumber });
    return 'completed';
  } catch (err) {
    await systems.deadLetter({ event, reason: err.message, retryable: err instanceof TransientError });
    await systems.salesforce(event.OpportunityId__c, { Integration_Status__c: 'Failed' }).catch(() => {});
    log('failed', { error: err.message });
    return 'failed';
  }
}
```

**src/salesforce.mjs** (write-back through REST, one call per order)

```javascript
export function makeSalesforceWriter(instance, token) {
  return async function update(opportunityId, fields) {
    const res = await fetch(`${instance}/services/data/v67.0/sobjects/Opportunity/${opportunityId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(fields)
    });
    if (!res.ok) {
      throw new Error(`Salesforce write-back failed: ${res.status}`);
    }
  };
}
```

**test/pipeline.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { processOrder, TransientError, withRetry } from '../src/pipeline.mjs';
import { toErpXml } from '../src/transform.mjs';

const event = { OpportunityId__c: '006A', AccountName__c: 'Smith & Sons', Amount__c: 1200, Correlation_Id__c: 'c-1' };

function fakeSystems(overrides = {}) {
  const calls = { dead: [], sf: [], logs: [] };
  const systems = {
    erp: async () => ({ orderNumber: 'ERP-9' }),
    logistics: async () => ({}),
    salesforce: async (id, fields) => { calls.sf.push({ id, fields }); },
    deadLetter: async item => { calls.dead.push(item); },
    log: entry => calls.logs.push(entry),
    retry: { attempts: 3, baseMs: 0, sleep: async () => {} },
    ...overrides
  };
  return { systems, calls };
}

test('happy path writes the ERP number back', async () => {
  const { systems, calls } = fakeSystems();
  assert.equal(await processOrder(event, systems), 'completed');
  assert.deepEqual(calls.sf[0].fields, { ERP_Order_Number__c: 'ERP-9', Integration_Status__c: 'Sent' });
});

test('invalid events go to the dead letter store without calling systems', async () => {
  const { systems, calls } = fakeSystems({ erp: async () => { throw new Error('must not be called'); } });
  assert.equal(await processOrder({ ...event, Amount__c: -5 }, systems), 'rejected');
  assert.equal(calls.dead[0].retryable, false);
});

test('transient ERP errors are retried then succeed', async () => {
  let n = 0;
  const { systems } = fakeSystems({ erp: async () => { if (++n < 3) throw new TransientError('503'); return { orderNumber: 'ERP-1' }; } });
  assert.equal(await processOrder(event, systems), 'completed');
  assert.equal(n, 3);
});

test('permanent failure is dead-lettered and flagged in Salesforce', async () => {
  const { systems, calls } = fakeSystems({ logistics: async () => { throw new Error('unknown postcode'); } });
  assert.equal(await processOrder(event, systems), 'failed');
  assert.equal(calls.dead[0].retryable, false);
  assert.equal(calls.sf.at(-1).fields.Integration_Status__c, 'Failed');
});

test('XML escapes special characters', () => {
  assert.ok(toErpXml(event).includes('Smith &amp; Sons'));
});

test('withRetry gives up after the attempt limit', async () => {
  let n = 0;
  await assert.rejects(() => withRetry(async () => { n++; throw new TransientError('x'); }, { attempts: 2, baseMs: 0, sleep: async () => {} }));
  assert.equal(n, 2);
});
```

Environment settings belong in configuration, never in code:

```yaml
# config/production.yaml
salesforce:
  instance: https://kestrel.my.salesforce.com
  clientIdRef: vault://kestrel/sf/client-id
  clientSecretRef: vault://kestrel/sf/client-secret
  eventChannel: /event/Order_Won__e
erp:
  baseUrl: https://erp.kestrel.example/api
  credentialRef: vault://kestrel/erp/key
logistics:
  baseUrl: https://ship.kestrel.example/v2
  credentialRef: vault://kestrel/ship/key
retry:
  attempts: 4
  baseMs: 500
deadLetter:
  queue: kestrel-order-dlq
```

## What happens behind the scenes

Salesforce publishes `Order_Won__e` to the event bus after the transaction commits. The middleware holds a subscription through the Pub/Sub API and receives events in order for that channel, along with a replay id so it can resume from where it stopped after a restart. For each event the pipeline validates, transforms, calls the ERP, then logistics, then writes the result back through one REST call.

The retry wrapper separates **transient** failures (timeouts, 503, 429) from **permanent** ones (bad data, unknown postcode). Only transient failures are retried, with growing delays plus random jitter so many failing messages do not retry in lockstep. A permanent failure goes to the dead-letter store with the full event so a person can fix it and replay. The correlation id travels in every call and every log line, so one search finds the whole journey of one order.

## Typical flows with Salesforce

Three shapes cover most projects. **Salesforce to ERP**: a platform event or Change Data Capture event is consumed by the middleware through the Pub/Sub API, which transforms it and posts to the ERP, then writes status back with the REST or Composite API, exactly as in the example. **Nightly bulk**: the middleware reads from the warehouse and loads through Bulk API 2.0. **Real-time lookups**: an Apex callout calls a process API, which calls several systems and returns one combined answer within a few seconds.

## A design checklist

1. **Authentication:** one integration user and one external client app per integration, with least privilege.
2. **Idempotency:** use External IDs so replays do not duplicate.
3. **Error handling:** retry transient errors with backoff, send poison messages to a dead-letter queue, and alert people.
4. **Back-pressure:** respect Salesforce API limits and daily allocations.
5. **Observability:** carry a correlation id end to end and log it in both systems.
6. **Environments:** separate credentials and endpoints per sandbox and production.
7. **Ownership:** document which system is the source of truth for each field.

## Test it and verify

1. Run `node --test` and confirm all six tests pass.
2. In a sandbox, publish an `Order_Won__e` event by closing a test Opportunity and confirm the middleware logs a line with its correlation id.
3. Stop the ERP stub and send another order. Confirm retries with growing delays and then a dead-letter entry marked retryable.
4. Send an event with `Amount__c` of zero. Confirm it is rejected immediately and not retried.
5. Open the Opportunity and confirm `Integration_Status__c` and `ERP_Order_Number__c` show the outcome.

## Common mistakes and fixes

- **Adding middleware for one simple call.** You pay for operations you do not need.
- **One API call per record.** You will meet Salesforce limits fast. Prefer Composite, collections and Bulk API 2.0.
- **Retrying permanent errors.** They never succeed and fill queues.
- **No correlation id.** Support cannot trace an order across systems.
- **Shared credentials across environments.** A test run can touch production.
- **No ownership rules.** Write down which system is the source of truth for each field.

## Key takeaways

- Use middleware for three or more systems, format differences, orchestration and central monitoring.
- Layer APIs: system, process, experience.
- Separate transient from permanent failures, retry the first and park the second.
- Carry a correlation id end to end.
- Respect Salesforce API limits and keep credentials per environment.

## Where to go next

- Read [Cross-system integration patterns](/articles/cross-system-integration-patterns/) to choose a pattern before choosing a tool.
- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for retries and reconciliation.
- Read [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/) for the subscription side.
