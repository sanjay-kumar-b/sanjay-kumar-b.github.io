---
title: "Composite Graph API: Modelling Dependent Record Creation at Scale"
description: "Submit many independent graphs of dependent records in one call: graph rules, sizing, a tested Node builder, per-graph retries and rollback behaviour."
category: salesforce-development
tags: [Composite API, REST API, Integration, Advanced]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/composite-graph-advanced.jpg
sources:
  - title: "Using Composite Graphs"
    url: "https://developer.salesforce.com/docs/platform/api-rest/guide/resources-composite-graph-introduction.html"
  - title: "REST API Developer Guide: Composite resources"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/resources_composite.htm"
---

Composite graphs extend the `/composite` resource. A regular composite request allows 25 subrequests; a composite graph request allows **500**, split into independent graphs that each succeed or fail on their own. The rules in this article come from the official Composite Graph documentation, and the code is a builder and runner you can adapt.

## The business scenario

Harvest Foods (a fictional wholesaler) imports 2,000 customer onboarding bundles every night from a partner portal. Each bundle creates an Account, a Contact and an Opportunity that must all exist together. If one bundle has a bad email address, the other 1,999 must still load, and the failed one must be identified so it can be fixed and resent without duplicating anything.

## Before you start: setup

### In Salesforce

1. Create External ID fields: `Bundle_Id__c` on Account (Unique, case sensitive). Optional but recommended for traceability.
2. Create an integration user with **API Enabled** and create access on Account, Contact and Opportunity.
3. Review validation rules on those objects. A bundle fails as a whole if any of its records breaks a rule, so know the rules before loading.
4. Obtain a token using the OAuth article and note the My Domain URL.

### In the external system

1. Give each bundle a stable id from the portal. It becomes the graph id and `Bundle_Id__c`.
2. Validate bundles before sending (email format, required names) to avoid avoidable failures.
3. Use Node 20 or newer, and set `INSTANCE` and `TOKEN`.

## How it works

A request contains one or more **graphs**. Each graph has a `graphId` and a `compositeRequest` array of subrequests that may depend on each other.

Rules from the documentation:

- `graphId` must be unique in the operation, start with an alphanumeric character, be under 40 characters and contain no period.
- Each subrequest has `url`, `method`, `referenceId` and, for POST and PATCH, `body`.
- Supported subrequest URLs: `POST /sobjects/<sObject>`; `GET`, `PATCH` and `DELETE` on `/sobjects/<sObject>/<id>`; and external-id forms `/sobjects/<sObject>/<customFieldName>/<externalId>`.
- Each graph is **implicitly all-or-none**: it fully succeeds or fully rolls back.
- A subrequest cannot reference a subrequest in a different graph, so graphs must be independent. A failed graph does not block the others.
- A later subrequest reads an earlier result with `@{referenceId.field}`.

**Depth**: nodes with no parents are at depth 1, and a node's depth is the longest chain of references leading to it. Keep chains short so failures are easy to debug.

**Sizing**: the official guidance is to keep graphs small. It recommends 50 graphs of 10 nodes rather than one graph of 500 nodes, because a large graph rolls back entirely on a single failure and is slower to process.

## Basic example

```json
{
  "graphs": [
    {
      "graphId": "g1",
      "compositeRequest": [
        {
          "url": "/services/data/v67.0/sobjects/Account",
          "method": "POST",
          "referenceId": "refAccount",
          "body": { "Name": "Acme Ltd" }
        },
        {
          "url": "/services/data/v67.0/sobjects/Opportunity",
          "method": "POST",
          "referenceId": "refOpp",
          "body": {
            "Name": "Acme renewal",
            "AccountId": "@{refAccount.id}",
            "StageName": "Prospecting",
            "CloseDate": "2027-03-31"
          }
        }
      ]
    }
  ]
}
```

Send it with `POST /services/data/v67.0/composite/graph`. The documentation also shows a graph that starts with a `GET` and uses `@{refAccount.Name}` in a later step.

## Advanced end-to-end example

**src/graphs.mjs**

```javascript
const V = 'v67.0';
export const MAX_NODES_PER_REQUEST = 500;
export const NODES_PER_BUNDLE = 3;

export function safeGraphId(bundleId) {
  // Alphanumeric start, under 40 characters, no periods.
  const cleaned = String(bundleId).replace(/[^A-Za-z0-9_-]/g, '-');
  return ('g' + cleaned).slice(0, 39);
}

export function bundleToGraph(bundle) {
  return {
    graphId: safeGraphId(bundle.id),
    compositeRequest: [
      {
        url: `/services/data/${V}/sobjects/Account`,
        method: 'POST',
        referenceId: 'acct',
        body: { Name: bundle.company, Bundle_Id__c: bundle.id }
      },
      {
        url: `/services/data/${V}/sobjects/Contact`,
        method: 'POST',
        referenceId: 'contact',
        body: { LastName: bundle.lastName, Email: bundle.email, AccountId: '@{acct.id}' }
      },
      {
        url: `/services/data/${V}/sobjects/Opportunity`,
        method: 'POST',
        referenceId: 'opp',
        body: {
          Name: `${bundle.company} onboarding`, StageName: 'Prospecting',
          CloseDate: bundle.closeDate, AccountId: '@{acct.id}'
        }
      }
    ]
  };
}

// Pack graphs into requests of at most `nodeBudget` nodes in total.
export function packRequests(bundles, nodeBudget = 300) {
  const perRequest = Math.max(1, Math.floor(Math.min(nodeBudget, MAX_NODES_PER_REQUEST) / NODES_PER_BUNDLE));
  const requests = [];
  for (let i = 0; i < bundles.length; i += perRequest) {
    requests.push({ graphs: bundles.slice(i, i + perRequest).map(bundleToGraph) });
  }
  return requests;
}
```

**src/runner.mjs**

```javascript
import { packRequests, safeGraphId } from './graphs.mjs';

const url = () => `${process.env.INSTANCE}/services/data/v67.0/composite/graph`;
const headers = () => ({ Authorization: `Bearer ${process.env.TOKEN}`, 'Content-Type': 'application/json' });

export function summarize(response) {
  const ok = [];
  const failed = [];
  for (const g of response.graphs) {
    if (g.isSuccessful) {
      ok.push(g.graphId);
    } else {
      const bad = g.graphResponse.compositeResponse.find(r => r.httpStatusCode >= 400);
      failed.push({ graphId: g.graphId, reason: bad ? JSON.stringify(bad.body) : 'rolled back' });
    }
  }
  return { ok, failed };
}

export async function loadBundles(bundles, send = defaultSend) {
  const byGraph = new Map(bundles.map(b => [safeGraphId(b.id), b]));
  const result = { loaded: 0, failed: [] };
  for (const req of packRequests(bundles)) {
    const response = await send(req);
    const { ok, failed } = summarize(response);
    result.loaded += ok.length;
    for (const f of failed) {
      result.failed.push({ bundle: byGraph.get(f.graphId), reason: f.reason });
    }
  }
  return result;
}

async function defaultSend(body) {
  const res = await fetch(url(), { method: 'POST', headers: headers(), body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Graph request failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}
```

**test/graphs.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { bundleToGraph, packRequests, safeGraphId } from '../src/graphs.mjs';
import { summarize, loadBundles } from '../src/runner.mjs';

const bundle = n => ({ id: `B.${n}`, company: `Co ${n}`, lastName: 'Rao', email: 'r@x.com', closeDate: '2027-01-31' });

test('graph ids satisfy the documented rules', () => {
  const id = safeGraphId('.bad.id.' + 'x'.repeat(80));
  assert.match(id, /^[A-Za-z0-9]/);
  assert.ok(id.length < 40);
  assert.ok(!id.includes('.'));
});

test('children reference the account created in the same graph', () => {
  const g = bundleToGraph(bundle(1));
  assert.equal(g.compositeRequest.length, 3);
  assert.equal(g.compositeRequest[1].body.AccountId, '@{acct.id}');
});

test('requests never exceed 500 nodes', () => {
  const reqs = packRequests(Array.from({ length: 1000 }, (_, i) => bundle(i)), 900);
  for (const r of reqs) {
    assert.ok(r.graphs.length * 3 <= 500);
  }
  assert.equal(reqs.reduce((n, r) => n + r.graphs.length, 0), 1000);
});

test('summarize separates successful and failed graphs', () => {
  const out = summarize({ graphs: [
    { graphId: 'a', isSuccessful: true, graphResponse: { compositeResponse: [] } },
    { graphId: 'b', isSuccessful: false, graphResponse: { compositeResponse: [{ httpStatusCode: 400, body: [{ errorCode: 'INVALID_EMAIL_ADDRESS' }] }] } }
  ]});
  assert.deepEqual(out.ok, ['a']);
  assert.match(out.failed[0].reason, /INVALID_EMAIL_ADDRESS/);
});

test('loadBundles returns the failed bundle for a retry', async () => {
  const bundles = [bundle(1), bundle(2)];
  const send = async req => ({ graphs: req.graphs.map((g, i) => ({
    graphId: g.graphId, isSuccessful: i === 0,
    graphResponse: { compositeResponse: [{ httpStatusCode: i === 0 ? 201 : 400, body: [{ errorCode: 'BAD' }] }] }
  }))});
  const out = await loadBundles(bundles, send);
  assert.equal(out.loaded, 1);
  assert.equal(out.failed[0].bundle.id, 'B.2');
});
```

Run it from a nightly script:

```javascript
import { loadBundles } from './src/runner.mjs';
import { readFile, writeFile } from 'node:fs/promises';

const bundles = JSON.parse(await readFile('bundles.json', 'utf8'));
const { loaded, failed } = await loadBundles(bundles);
console.log(`Loaded ${loaded} bundles, ${failed.length} failed`);
if (failed.length > 0) {
  await writeFile('retry.json', JSON.stringify(failed.map(f => f.bundle), null, 2));
}
```

## What happens behind the scenes

Salesforce validates the request first: graph ids, subrequest URLs, references and depth. Then it executes each graph in its own transaction, in dependency order, filling in `@{ref.field}` values as steps complete. If any subrequest in a graph fails, that graph's transaction rolls back, so no half-built bundle remains, and the response marks it `isSuccessful: false`. Other graphs are untouched.

Because a failed graph leaves nothing behind, resubmitting it is safe, and the `Bundle_Id__c` unique field is the second safety net: if a repeat arrives for a bundle that did succeed, the duplicate fails instead of creating a second Account. That is why the retry file contains only the failed bundles and why you keep the External ID unique.

Each subrequest still runs its own triggers, flows and validation, so graphs save round trips, not processing work.

## Choosing graph over the alternatives

Use a graph when each unit of work is a small web of dependent records and the units are independent of each other: importing orders, each with an account, order, lines and a campaign member, is one graph per order and many graphs per request. Onboarding bundles where either everything is created or nothing is are another good fit.

Do not use a graph when records do not depend on each other. Thousands of independent accounts are better served by sObject Collections, which handle 200 records per call, or by Bulk API 2.0 for very large volumes. Graphs add structure you do not need in that case, and a request full of one-node graphs is just a slower collection call.

Think about **what the failure looks like to the business** before you choose the unit. If a customer bundle without its opportunity is useless, the graph boundary should include the opportunity. If the opportunity can be created later without harm, a smaller graph (account and contact only) fails less often and is easier to fix. The graph boundary is a business decision about what must never exist alone.

When a failure happens, log the graph id, the failing reference id and the error code together. The reference id tells you which step broke, and the error code tells you why, so a support person can fix the data without reading the whole payload.

## Test it and verify

1. Run `node --test` and confirm five passing tests.
2. Create `bundles.json` with three bundles in a sandbox and run the script. Expect `Loaded 3 bundles, 0 failed`, and three linked sets of records.
3. Make one bundle's `email` invalid (such as `nope`). Run again with new ids. Expect `2 loaded, 1 failed` and a `retry.json` with that bundle only.
4. Fix the email and rerun with just that file. Expect one loaded.
5. Send the original three again and confirm they fail on the unique `Bundle_Id__c` rather than duplicating.

## Common mistakes and fixes

- **One 500-node graph.** One failure rolls back everything. Use many small graphs.
- **References across graphs.** They do not work. Keep each graph self-contained.
- **A graph id with a period or over 39 characters.** The request is rejected. Sanitise it.
- **Assuming HTTP 200 means success.** Check each graph's `isSuccessful`.
- **Retrying everything.** Resend only failed graphs.
- **Using a graph for independent rows.** Collections or Bulk API 2.0 are simpler and faster.

## Key takeaways

- A graph is an all-or-none unit of dependent subrequests, and one request can hold many independent graphs.
- Keep graphs small, around 10 nodes, and chains shallow.
- Check `isSuccessful` per graph and resend only failures.
- Use External IDs so retries cannot create duplicates.
- Choose graphs only when records truly depend on each other.

## Where to go next

- Read [Composite API guide](/articles/composite-api-guide/) for the simpler resources.
- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for safe retries.
- Read [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/) when records are independent and numerous.
