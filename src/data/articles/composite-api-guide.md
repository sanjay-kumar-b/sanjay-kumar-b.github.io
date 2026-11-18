---
title: "Composite API Guide: Composite, Batch, Tree and sObject Collections"
description: "Cut round trips and keep related changes together: the four REST composite resources with JSON examples, a tested Node helper and limits."
category: salesforce-development
tags: [Composite API, REST API, Integration, Intermediate]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/composite-api-guide.jpg
sources:
  - title: "REST API Developer Guide: Composite resources"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite.htm"
  - title: "Using Composite Graphs"
    url: "https://developer.salesforce.com/docs/platform/api-rest/guide/resources-composite-graph-introduction.html"
---

Every HTTP call costs latency and API quota. Composite resources bundle work so you make fewer calls, and some of them keep related changes together so they succeed or fail as one. This article explains the four resources, shows each with JSON, and builds a tested Node helper that uses them safely.

## The business scenario

Alder Events (a fictional conference organiser) registers attendees through its website. One registration creates an Account for the company, a Contact for the attendee and an Opportunity for the ticket sale, and these must exist together or not at all. A nightly job also needs to update 5,000 contact phone numbers from a directory, and the dashboard needs three unrelated lookups in one trip. Each need maps to a different composite resource.

## Before you start: setup

### In Salesforce

1. Create a field `Registration_Id__c` on Account, marked External ID and Unique.
2. Create an integration user with **API Enabled** and create and edit access on Account, Contact and Opportunity, including the fields you will set.
3. Check that no validation rule on these objects blocks API-created records, such as a rule that requires a field your payload does not send.
4. Get an access token as described in the OAuth article and note your My Domain URL.

### In the external system

1. Use Node 20 or newer. Set `INSTANCE` and `TOKEN` as environment variables.
2. Give each registration a stable id (`REG-2026-0412`) so repeats are safe.
3. Decide in advance what the site does when a request fails: retry, or show the user a message.

## How it works

| Resource | What it does | Subrequests or records | References between steps |
|---|---|---|---|
| `/composite` | Several REST calls in one request, run in order | up to 25 | Yes, with `@{ref.id}` |
| `/composite/batch` | Several independent calls | up to 25 | No |
| `/composite/tree` | Create a parent with nested children | up to 200 records | Built in |
| `/composite/sobjects` (collections) | Create, update, delete or read many records | up to 200 records | No |
| `/composite/graph` | Several independent graphs of dependent steps | up to 500 nodes | Yes |

The 25 and 500 figures come from the official Composite and Graph pages. Confirm the 200 and tree limits for your API version in the REST guide before depending on them.

Choose by the shape of the work:

- Parent then child using the new ids: `/composite` or `/composite/tree`.
- Many independent reads: `/composite/batch`.
- Hundreds of records of one type: collections.
- Larger dependency webs: composite graph, covered in the next article.
- Millions of rows: Bulk API 2.0.

## Basic example

`/composite` with a reference between two steps:

```json
{
  "allOrNone": true,
  "compositeRequest": [
    {
      "method": "POST",
      "url": "/services/data/v67.0/sobjects/Account",
      "referenceId": "newAcc",
      "body": { "Name": "Acme Ltd" }
    },
    {
      "method": "POST",
      "url": "/services/data/v67.0/sobjects/Contact",
      "referenceId": "newCon",
      "body": { "LastName": "Rao", "AccountId": "@{newAcc.id}" }
    }
  ]
}
```

Send it with `POST /services/data/v67.0/composite`. `@{newAcc.id}` takes the id from the first response. With `allOrNone` true, any failure rolls back the whole request. With false, successful steps stay.

The other three shapes, for comparison:

```json
{
  "haltOnError": false,
  "batchRequests": [
    { "method": "GET", "url": "v67.0/sobjects/Account/001Hn00001AbCdEQAT" },
    { "method": "GET", "url": "v67.0/query?q=SELECT+Id+FROM+Contact+LIMIT+5" }
  ]
}
```

That is `/composite/batch`: each subrequest runs separately, and one failing does not affect the others unless `haltOnError` is true.

```json
{
  "records": [{
    "attributes": { "type": "Account", "referenceId": "a1" },
    "Name": "Acme Ltd",
    "Contacts": { "records": [
      { "attributes": { "type": "Contact", "referenceId": "c1" }, "LastName": "Rao" }
    ]}
  }]
}
```

That is `/composite/tree/Account`: a parent and children created together, all or nothing. Finally, sObject collections take a list of records of the same or mixed types and a flag:

```json
{
  "allOrNone": false,
  "records": [
    { "attributes": { "type": "Account" }, "Name": "A" },
    { "attributes": { "type": "Account" }, "Name": "B" }
  ]
}
```

## Advanced end-to-end example

**src/composite.mjs**

```javascript
const V = 'v67.0';
const base = () => `${process.env.INSTANCE}/services/data/${V}`;
const headers = () => ({
  Authorization: `Bearer ${process.env.TOKEN}`,
  'Content-Type': 'application/json'
});

async function post(path, body, method = 'POST') {
  const res = await fetch(`${base()}${path}`, { method, headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${await res.text()}`);
  }
  return res.json();
}

// Build the three-record registration as one atomic composite request.
export function buildRegistration(reg) {
  return {
    allOrNone: true,
    compositeRequest: [
      {
        method: 'POST',
        url: `/services/data/${V}/sobjects/Account`,
        referenceId: 'acct',
        body: { Name: reg.company, Registration_Id__c: reg.id }
      },
      {
        method: 'POST',
        url: `/services/data/${V}/sobjects/Contact`,
        referenceId: 'person',
        body: { LastName: reg.lastName, Email: reg.email, AccountId: '@{acct.id}' }
      },
      {
        method: 'POST',
        url: `/services/data/${V}/sobjects/Opportunity`,
        referenceId: 'deal',
        body: {
          Name: `${reg.company} ticket`, StageName: 'Closed Won', CloseDate: reg.date,
          Amount: reg.amount, AccountId: '@{acct.id}'
        }
      }
    ]
  };
}

// Every subrequest must be checked: HTTP 200 only means the envelope arrived.
export function assertAllSucceeded(response) {
  const failed = response.compositeResponse.filter(r => r.httpStatusCode >= 400);
  if (failed.length > 0) {
    const detail = failed.map(f => `${f.referenceId}: ${JSON.stringify(f.body)}`).join('; ');
    throw new Error(`Composite failed: ${detail}`);
  }
  return Object.fromEntries(response.compositeResponse.map(r => [r.referenceId, r.body.id]));
}

export async function register(reg) {
  return assertAllSucceeded(await post('/composite', buildRegistration(reg)));
}

// Collections accept up to 200 records: send in chunks and gather per-record errors.
export function chunk(list, size = 200) {
  const out = [];
  for (let i = 0; i < list.length; i += size) {
    out.push(list.slice(i, i + size));
  }
  return out;
}

export async function updateContacts(updates) {
  const errors = [];
  for (const part of chunk(updates)) {
    const records = part.map(u => ({ attributes: { type: 'Contact' }, Id: u.id, Phone: u.phone }));
    const results = await post('/composite/sobjects', { allOrNone: false, records }, 'PATCH');
    results.forEach((r, i) => {
      if (!r.success) {
        errors.push({ id: part[i].id, errors: r.errors });
      }
    });
  }
  return errors;
}

export async function dashboard() {
  const result = await post('/composite/batch', {
    haltOnError: false,
    batchRequests: [
      { method: 'GET', url: `${V}/query?q=SELECT+COUNT()+FROM+Account` },
      { method: 'GET', url: `${V}/query?q=SELECT+COUNT()+FROM+Contact` },
      { method: 'GET', url: `${V}/limits` }
    ]
  });
  return result.results.map(r => ({ status: r.statusCode, body: r.result }));
}
```

**test/composite.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRegistration, assertAllSucceeded, chunk } from '../src/composite.mjs';

const reg = { id: 'REG-1', company: 'Acme', lastName: 'Rao', email: 'r@a.com', date: '2026-12-01', amount: 900 };

test('registration links contact and opportunity to the new account', () => {
  const req = buildRegistration(reg);
  assert.equal(req.allOrNone, true);
  assert.equal(req.compositeRequest.length, 3);
  assert.equal(req.compositeRequest[1].body.AccountId, '@{acct.id}');
  assert.equal(req.compositeRequest[2].body.AccountId, '@{acct.id}');
});

test('success returns the new ids by reference', () => {
  const ids = assertAllSucceeded({ compositeResponse: [
    { referenceId: 'acct', httpStatusCode: 201, body: { id: '001A' } },
    { referenceId: 'person', httpStatusCode: 201, body: { id: '003B' } }
  ]});
  assert.deepEqual(ids, { acct: '001A', person: '003B' });
});

test('a failed subrequest is reported with its reference', () => {
  assert.throws(() => assertAllSucceeded({ compositeResponse: [
    { referenceId: 'acct', httpStatusCode: 400, body: [{ errorCode: 'REQUIRED_FIELD_MISSING' }] }
  ]}), /acct.*REQUIRED_FIELD_MISSING/);
});

test('chunk splits 450 records into 200, 200 and 50', () => {
  const sizes = chunk(Array.from({ length: 450 }, (_, i) => i)).map(c => c.length);
  assert.deepEqual(sizes, [200, 200, 50]);
});
```

Use it from a route handler:

```javascript
import { register } from './src/composite.mjs';

const ids = await register({
  id: 'REG-2026-0412', company: 'Northwind', lastName: 'Okafor',
  email: 'okafor@northwind.test', date: '2026-12-01', amount: 1200
});
console.log(ids); // { acct: '001...', person: '003...', deal: '006...' }
```

## What happens behind the scenes

A `/composite` request is one HTTP call but Salesforce executes the subrequests in order, each as its own REST call with its own validation, triggers and flows. With `allOrNone` true, Salesforce wraps them so that if any step fails, the earlier ones are rolled back. The platform replaces each `@{ref.id}` with the real id as soon as that step finishes, so later steps can use it.

`/composite/batch` is different: the subrequests do not share a transaction, so they cannot depend on each other. It exists to save round trips for independent reads. Collections process many records in one call, using the same DML rules as Apex, so `allOrNone: false` allows some rows to succeed while others fail, and the response is an array with one result per record in the same order.

Each subrequest still counts toward the limits of the operation it performs, so composite saves latency and some API calls, but it does not make heavy work free.

Three design choices in the helper deserve a comment. First, `register` returns ids keyed by reference name, so the calling code never needs to parse the raw response. Second, the registration uses `allOrNone: true` because a ticket sale without its account is worse than a failed request that the website can simply retry. Third, `updateContacts` uses `allOrNone: false` on purpose: a directory update of 5,000 phone numbers should not be abandoned because one contact was deleted last week. It collects the failures and returns them so someone can review them.

A final point on retries. If the registration request times out, you do not know whether Salesforce created the records. Because the Account carries `Registration_Id__c`, you can query for that value before retrying, or switch the first step to an upsert on that External ID. Either way the website never creates the same registration twice, which is the property that makes composite requests safe to repeat.

## Test it and verify

1. Run `node --test` and confirm four passing tests.
2. Call `register` in a sandbox and confirm three new records appear, linked.
3. Break it on purpose by sending a Contact without `LastName`. Confirm the thrown error names the `person` step and that no Account was left behind.
4. Run `updateContacts` with 450 updates, one with an invalid id. Confirm 449 changed and exactly one error is returned with that id.
5. Call `dashboard()` and confirm three results, each with its own status.

## Common mistakes and fixes

- **Trusting the outer HTTP 200.** Check every `httpStatusCode` in the response array.
- **Using batch for dependent steps.** References do not work there; use `/composite`.
- **Exceeding 25 subrequests.** Split the request or use a graph.
- **Using `allOrNone: false` when you need atomic results.** You will get half-created data.
- **No external IDs.** A retried request creates duplicates. Use upsert URLs or an External ID field.
- **Sending huge bodies.** Very large payloads time out. Keep requests reasonable.

## Key takeaways

- Composite resources reduce round trips; pick the one that matches the shape of your work.
- `/composite` gives ordered, dependent steps with references; `allOrNone` makes them atomic.
- `/composite/batch` is for independent calls, collections for many records of a type.
- Always inspect every subrequest result.
- Combine with External IDs so retries are safe.

## Where to go next

- Read [Composite Graph advanced guide](/articles/composite-graph-advanced/) for larger dependency webs.
- Read [REST API from zero](/articles/rest-api-first-calls/) for the single-call basics.
- Read [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/) when volume grows.
