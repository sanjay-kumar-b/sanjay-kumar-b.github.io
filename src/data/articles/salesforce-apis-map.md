---
title: "Salesforce APIs Map: REST, SOAP, GraphQL, Tooling, Metadata, Pub/Sub and More"
description: "A practical tour of Salesforce's APIs with runnable REST, GraphQL, Composite and Bulk examples and a decision guide for picking the right one."
category: salesforce-development
tags: [REST API, SOAP API, GraphQL, Integration, Intermediate]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/salesforce-apis-map.jpg
sources:
  - title: "Salesforce Platform APIs (Developer docs)"
    url: "https://developer.salesforce.com/docs/apis"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

Salesforce has many APIs, and choosing the wrong one is a common reason integrations are slow, fragile or expensive. This article gives you a map, then shows the four you will use most in working code: REST, GraphQL, Composite and Bulk.

## The business scenario

Cedar Health (a fictional clinic network) is building a patient portal and a nightly data sync. The portal needs a few fields from several related objects in one fast call. A back-office tool must create an Account, a Contact and a Case together or not at all. A nightly job loads 500,000 appointment rows from another system. Each need points to a different API.

## Before you start: setup

### In Salesforce

1. Make sure the org's edition includes API access. Developer Edition orgs, scratch orgs and sandboxes do.
2. Create an integration user with a permission set granting **API Enabled** and access to the objects used here.
3. Register an External Client App and get a token, as described in the OAuth article. The examples assume `$TOKEN` and `$INSTANCE` environment variables.
4. Create an External ID field `Appointment_Id__c` on a custom object `Appointment__c` with fields `Patient_Name__c` and `Scheduled_At__c` for the Bulk example.

### In the external system

1. Use Node 20 or newer and `curl`.
2. Store the token in an environment variable for the session, not in files.
3. Know your daily API request allocation. Check **Setup > System Overview** for API usage before large loads.

## How it works

Each API serves a purpose:

- **REST API.** JSON over HTTPS for records, queries and metadata. The default choice for most integrations.
- **SOAP API.** XML and a WSDL. Still used by older systems and some tools.
- **GraphQL API.** One request fetches several objects and exactly the fields you ask for. Good for user interfaces.
- **Composite and Composite Graph.** Bundle many REST calls into one request, with references between them and all-or-nothing options.
- **Bulk API 2.0.** Asynchronous loading and extraction of very large data sets as CSV.
- **Pub/Sub API and Platform Events.** Streaming events in and out, covered in the events article.
- **Tooling API and Metadata API.** Developer tools: inspect and deploy code, objects and configuration.
- **UI API and Connect REST API.** Data shaped for screens, and features such as Chatter and communities.
- **Agent API.** Talk to an Agentforce agent from your own application.

## Choosing quickly

Ask three questions in order:

1. **How much data?** Thousands of records or more per run points to Bulk API 2.0. A handful points to REST.
2. **Who consumes it?** A screen that needs several related objects in one trip points to GraphQL. A back-end job that creates linked records points to Composite.
3. **Is it data or tooling?** Business records use REST, GraphQL or Bulk. Code, objects and settings use the Tooling or Metadata APIs, usually through Salesforce CLI rather than hand-written calls.

Two more rules help. If the outside system needs to be told when something changes, do not poll the REST API every minute; subscribe to events instead, because polling wastes your allocation and still arrives late. And if the caller only needs to run one business action, wrap it in a custom Apex REST service so the caller does not need to know your data model at all.

## Basic example

A REST query is the first thing to try.

```bash
curl -s -G "$INSTANCE/services/data/v67.0/query" \
  --data-urlencode "q=SELECT Id, Name FROM Account ORDER BY CreatedDate DESC LIMIT 3" \
  -H "Authorization: Bearer $TOKEN"
```

The reply lists `records`, plus `totalSize` and `done`. If `done` is `false`, follow `nextRecordsUrl` for the next page. Always follow it, or you will silently lose rows.

## Advanced end-to-end example

The Node scripts below each call a different API and share a small helper. You can run them in order.

**lib/sf.mjs**

```javascript
const instance = process.env.INSTANCE;
const token = process.env.TOKEN;
export const version = 'v67.0';

export async function sf(path, init = {}) {
  const res = await fetch(`${instance}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers || {})
    }
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${res.status} ${path}: ${text}`);
  }
  return text ? JSON.parse(text) : null;
}

export async function queryAll(soql) {
  let page = await sf(`/services/data/${version}/query?q=${encodeURIComponent(soql)}`);
  const rows = [...page.records];
  while (!page.done) {
    page = await sf(page.nextRecordsUrl);
    rows.push(...page.records);
  }
  return rows;
}
```

**scripts/graphql.mjs** (portal screen: one call, three objects)

```javascript
import { sf, version } from '../lib/sf.mjs';

const query = `
  query PortalHome($accountId: ID) {
    uiapi {
      query {
        Account(where: { Id: { eq: $accountId } }) {
          edges {
            node {
              Name { value }
              Contacts {
                edges { node { Name { value } Email { value } } }
              }
              Cases(first: 5, orderBy: { CreatedDate: { order: DESC } }) {
                edges { node { Subject { value } Status { value } } }
              }
            }
          }
        }
      }
    }
  }`;

const accountId = process.argv[2];
const result = await sf(`/services/data/${version}/graphql`, {
  method: 'POST',
  body: JSON.stringify({ query, variables: { accountId } })
});
if (result.errors?.length) {
  console.error(result.errors);
  process.exit(1);
}
const node = result.data.uiapi.query.Account.edges[0]?.node;
console.log(JSON.stringify(node, null, 2));
```

**scripts/composite.mjs** (create Account, Contact and Case together)

```javascript
import { sf, version } from '../lib/sf.mjs';

const body = {
  allOrNone: true,
  compositeRequest: [
    {
      method: 'POST',
      url: `/services/data/${version}/sobjects/Account`,
      referenceId: 'newAccount',
      body: { Name: 'Cedar Clinic North' }
    },
    {
      method: 'POST',
      url: `/services/data/${version}/sobjects/Contact`,
      referenceId: 'newContact',
      body: { LastName: 'Okafor', AccountId: '@{newAccount.id}' }
    },
    {
      method: 'POST',
      url: `/services/data/${version}/sobjects/Case`,
      referenceId: 'newCase',
      body: {
        Subject: 'Welcome call',
        AccountId: '@{newAccount.id}',
        ContactId: '@{newContact.id}'
      }
    }
  ]
};

const result = await sf(`/services/data/${version}/composite`, {
  method: 'POST',
  body: JSON.stringify(body)
});
for (const r of result.compositeResponse) {
  console.log(r.referenceId, r.httpStatusCode, JSON.stringify(r.body));
}
```

**scripts/bulk-load.mjs** (Bulk API 2.0 ingest of a CSV)

```javascript
import { readFile } from 'node:fs/promises';
import { sf, version } from '../lib/sf.mjs';

const instance = process.env.INSTANCE;
const token = process.env.TOKEN;
const csv = await readFile(process.argv[2], 'utf8');

const job = await sf(`/services/data/${version}/jobs/ingest`, {
  method: 'POST',
  body: JSON.stringify({
    object: 'Appointment__c',
    operation: 'upsert',
    externalIdFieldName: 'Appointment_Id__c',
    contentType: 'CSV',
    lineEnding: 'LF'
  })
});

const upload = await fetch(`${instance}/services/data/${version}/jobs/ingest/${job.id}/batches`, {
  method: 'PUT',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/csv' },
  body: csv
});
if (upload.status !== 201) {
  throw new Error(`Upload failed: ${upload.status}`);
}

await sf(`/services/data/${version}/jobs/ingest/${job.id}`, {
  method: 'PATCH',
  body: JSON.stringify({ state: 'UploadComplete' })
});

let info;
do {
  await new Promise(r => setTimeout(r, 5000));
  info = await sf(`/services/data/${version}/jobs/ingest/${job.id}`);
  console.log(info.state, info.numberRecordsProcessed, info.numberRecordsFailed);
} while (!['JobComplete', 'Failed', 'Aborted'].includes(info.state));

if (info.numberRecordsFailed > 0) {
  const res = await fetch(`${instance}/services/data/${version}/jobs/ingest/${job.id}/failedResults`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  console.log(await res.text());
}
```

A sample CSV for the Bulk script:

```bash
cat > appointments.csv <<'CSV'
Appointment_Id__c,Patient_Name__c,Scheduled_At__c
A-1001,Ana Silva,2026-12-01T09:00:00Z
A-1002,Ben Carter,2026-12-01T09:30:00Z
CSV
INSTANCE=$INSTANCE TOKEN=$TOKEN node scripts/bulk-load.mjs appointments.csv
```

**test/sf.test.mjs** (offline test of the pagination helper)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';

process.env.INSTANCE = 'https://i.test';
process.env.TOKEN = 't';

test('queryAll follows nextRecordsUrl until done', async () => {
  const pages = [
    { done: false, nextRecordsUrl: '/next', records: [{ Id: '1' }] },
    { done: true, records: [{ Id: '2' }] }
  ];
  globalThis.fetch = async () => {
    const body = JSON.stringify(pages.shift());
    return { ok: true, status: 200, text: async () => body };
  };
  const { queryAll } = await import('../lib/sf.mjs');
  const rows = await queryAll('SELECT Id FROM Account');
  assert.deepEqual(rows.map(r => r.Id), ['1', '2']);
});
```

## What happens behind the scenes

REST and GraphQL are synchronous. The platform authenticates you, checks permissions, runs your request in a transaction and returns the answer. GraphQL differs in that the server resolves the related objects for you in one trip, which saves network round trips and trims the payload to the fields you named.

Composite sends several sub-requests in one HTTP call. With `allOrNone` set, if any sub-request fails, all the others are rolled back. Reference ids such as `@{newAccount.id}` are replaced with the real id once that step succeeds.

Bulk API 2.0 is asynchronous. You create a job, upload CSV data, mark it complete, and Salesforce processes it in the background in chunks, without counting every row as a separate API call. You poll until the job ends, then fetch successful and failed results. That is why it suits hundreds of thousands of rows, while REST would be slow and costly.

A note on **API versions**. Every URL contains a version such as `v67.0`. Salesforce keeps old versions working for a long time, which is why code that has not been touched for years still runs, but new fields and features appear only in newer versions. Keep the version in one constant, as the helper above does, so upgrading is a one-line change that you test in a sandbox first.

A note on **limits**. Each org has a rolling 24-hour allocation of API requests that depends on its edition and licenses, and a separate cap on how many requests can be in progress at once. An integration that loops over thousands of records making one call each can use the whole allocation and block every other integration. Prefer calls that carry many records, and check usage before and after any large run.

## Test it and verify

1. Run `node --test` to check the pagination helper.
2. Run the curl query and confirm three accounts appear.
3. Run `node scripts/graphql.mjs <accountId>` and confirm contacts and cases print together. If you receive an error about a field, check the user's field access.
4. Run `node scripts/composite.mjs`. Confirm three `201` responses, then temporarily remove the `LastName` from the Contact body and confirm that nothing is created.
5. Run the Bulk script with the sample CSV and confirm `JobComplete` with zero failures. Open the Appointment records to verify two rows.
6. Check **Setup > System Overview** to see how few API calls the Bulk run used compared with the others.

## Common mistakes and fixes

- **Using REST for huge loads.** It burns your API allocation. Use Bulk API 2.0.
- **Ignoring `nextRecordsUrl`.** You process only the first page. Always loop until `done`.
- **Hard-coding an old API version.** Use a current version and plan to review it at each release.
- **One call per record.** Batch with Composite or Collections instead.
- **Using the Metadata API for data.** It deploys configuration, not records.
- **Not handling partial failures.** Check `numberRecordsFailed` and fetch the failure file.

## Key takeaways

- REST is the default, GraphQL is best for screens that need several related objects, Composite groups calls, and Bulk handles volume.
- Pub/Sub and Platform Events are for streaming.
- Tooling and Metadata APIs are for developer tooling, not business data.
- Always paginate, check each result and use External IDs for upserts.
- Watch your API usage before building large integrations.

## Where to go next

- Read [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/) to get the token used here.
- Read [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/) for streaming.
- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for retries and reconciliation.
