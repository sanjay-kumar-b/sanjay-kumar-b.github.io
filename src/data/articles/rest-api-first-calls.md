---
title: "Salesforce REST API from Zero: Your First Authenticated Calls"
description: "Learn the Salesforce REST API step by step: URLs, tokens, CRUD, SOQL, upsert and error handling, with curl and a tested Node client."
category: salesforce-development
tags: [REST API, Integration, Beginner]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/rest-api-first-calls.jpg
sources:
  - title: "REST API Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/"
  - title: "The Salesforce Developers Guide to the Summer '26 Release (API 67.0)"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

The REST API lets any system read and write Salesforce data over HTTPS using JSON. If you have never called it, this article walks through every step: getting a token, the four basic record operations, querying, upserting and reading errors. You will first use curl so you can see the raw requests, then build a small Node client with tests.

## The business scenario

Pioneer Books (a fictional online bookstore) keeps its customers in its own website database and wants each customer to appear in Salesforce as an Account. The website must create an Account when someone signs up, update it when they change details, look up accounts by name, and avoid creating duplicates if the same sign-up is sent twice.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org, scratch org or sandbox. Do not practise in production.
2. Create a custom text field on Account named `Website_Customer_Id__c`. Mark it **External ID** and **Unique**. This is the key that makes safe upserts possible.
3. Create an integration user and a permission set with **API Enabled**, create and edit access on Account, and read and edit access to the new field.
4. Register an External Client App with the **api** scope, as described in the OAuth article, and note the consumer key and secret.
5. Find your **My Domain** URL under **Setup > My Domain**, for example `https://pioneer-dev.my.salesforce.com`.

### In the external system

1. Install `curl` and Node 20 or newer.
2. Keep the access token in an environment variable named `TOKEN` and the domain in `INSTANCE`. Never paste a token into code or chat.
3. Decide the website's unique customer id format, such as `C-100234`, and keep it stable. It becomes the External ID.

## How it works

Every REST URL has the same shape: your domain, then `/services/data/`, then an **API version**, then a resource.

`https://<MyDomain>.my.salesforce.com/services/data/v67.0/sobjects/Account`

`v67.0` is the version that shipped with Summer '26. You can list the versions your org supports by opening `/services/data/`. Pin the version in your integration so a release never changes behaviour unexpectedly, and move it deliberately after testing.

Each call carries an `Authorization: Bearer <token>` header. The HTTP method says what you want: `GET` reads, `POST` creates, `PATCH` updates, `DELETE` removes. Salesforce replies with a status code, and for creates a JSON body containing the new id.

## Basic example

Set two variables, then try each operation in order.

```bash
export INSTANCE="https://pioneer-dev.my.salesforce.com"
export BASE="$INSTANCE/services/data/v67.0"
export TOKEN="00D...your_access_token"
```

You can print a token for an authorised org with the Salesforce CLI while learning:

```bash
sf org display --target-org myorg --verbose
```

Create, read, update and delete an Account:

```bash
# Create (returns {"id":"001...","success":true,"errors":[]})
curl -X POST "$BASE/sobjects/Account" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"Name":"Reader Co","Industry":"Retail"}'

# Read
curl "$BASE/sobjects/Account/001Hn00001AbCdEQAT?fields=Name,Industry" \
  -H "Authorization: Bearer $TOKEN"

# Update (204 No Content on success)
curl -X PATCH "$BASE/sobjects/Account/001Hn00001AbCdEQAT" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"Industry":"Media"}'

# Delete (204 No Content)
curl -X DELETE "$BASE/sobjects/Account/001Hn00001AbCdEQAT" \
  -H "Authorization: Bearer $TOKEN"
```

Query with SOQL. Remember to URL-encode the query:

```bash
curl -G "$BASE/query" -H "Authorization: Bearer $TOKEN" \
  --data-urlencode "q=SELECT Id, Name FROM Account WHERE Industry = 'Retail' LIMIT 10"
```

The reply has `records`, `totalSize` and `done`. If `done` is `false`, follow `nextRecordsUrl` to get the next page.

## Advanced end-to-end example

The Node client below handles the website's sign-up flow: it upserts by External ID, searches by name safely, pages through results, and turns Salesforce errors into readable messages.

**src/errors.mjs**

```javascript
export class SalesforceError extends Error {
  constructor(status, errors) {
    const first = Array.isArray(errors) && errors[0] ? errors[0] : {};
    super(`${status} ${first.errorCode || 'ERROR'}: ${first.message || 'Request failed'}`);
    this.status = status;
    this.errorCode = first.errorCode;
    this.fields = first.fields || [];
    // 5xx, 429 and 503 are temporary; 4xx are not.
    this.retryable = status >= 500 || status === 429;
  }
}

export async function parseError(res) {
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = [{ errorCode: 'NON_JSON', message: res.statusText }];
  }
  return new SalesforceError(res.status, body);
}
```

**src/client.mjs**

```javascript
import { parseError } from './errors.mjs';

export class RestClient {
  constructor({ instance, token, version = 'v67.0', fetchImpl = fetch }) {
    this.instance = instance;
    this.token = token;
    this.version = version;
    this.fetch = fetchImpl;
  }

  async call(path, init = {}) {
    const res = await this.fetch(`${this.instance}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
    if (!res.ok) {
      throw await parseError(res);
    }
    return res.status === 204 ? null : res.json();
  }

  base() {
    return `/services/data/${this.version}`;
  }

  // Create or update by the website's own id. Safe to repeat.
  async upsertCustomer(customerId, fields) {
    const path = `${this.base()}/sobjects/Account/Website_Customer_Id__c/${encodeURIComponent(customerId)}`;
    const result = await this.call(path, { method: 'PATCH', body: JSON.stringify(fields) });
    // 201 returns {id, success}; 204 (an update) returns nothing.
    return result ? { created: true, id: result.id } : { created: false };
  }

  async query(soql) {
    let page = await this.call(`${this.base()}/query?q=${encodeURIComponent(soql)}`);
    const rows = [...page.records];
    while (!page.done) {
      page = await this.call(page.nextRecordsUrl);
      rows.push(...page.records);
    }
    return rows;
  }

  // Quote user input so a name like O'Neil cannot break or hijack the query.
  findByName(name) {
    const safe = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    return this.query(`SELECT Id, Name, Website_Customer_Id__c FROM Account WHERE Name = '${safe}'`);
  }

  async deleteAccount(id) {
    await this.call(`${this.base()}/sobjects/Account/${id}`, { method: 'DELETE' });
  }
}
```

**src/signup.mjs**

```javascript
import { RestClient } from './client.mjs';

export async function handleSignup(client, customer) {
  const result = await client.upsertCustomer(customer.id, {
    Name: customer.name,
    Industry: 'Retail',
    Description: `Signed up ${customer.signedUpAt}`
  });
  return result.created ? 'created' : 'updated';
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const client = new RestClient({ instance: process.env.INSTANCE, token: process.env.TOKEN });
  const outcome = await handleSignup(client, {
    id: 'C-100234', name: 'Reader Co', signedUpAt: new Date().toISOString()
  });
  console.log(outcome);
}
```

**test/client.test.mjs** (run with `node --test`)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RestClient } from '../src/client.mjs';
import { handleSignup } from '../src/signup.mjs';

function respond(status, body) {
  return { ok: status < 400, status, statusText: 'x', json: async () => body };
}

test('upsert reports created for 201 and updated for 204', async () => {
  const replies = [respond(201, { id: '001A', success: true }), respond(204, null)];
  const client = new RestClient({ instance: 'https://i.test', token: 't', fetchImpl: async () => replies.shift() });
  assert.equal(await handleSignup(client, { id: 'C-1', name: 'A', signedUpAt: 'now' }), 'created');
  assert.equal(await handleSignup(client, { id: 'C-1', name: 'A', signedUpAt: 'now' }), 'updated');
});

test('upsert uses the external id URL', async () => {
  let seen;
  const client = new RestClient({ instance: 'https://i.test', token: 't', fetchImpl: async url => { seen = url; return respond(204, null); } });
  await client.upsertCustomer('C 1/2', { Name: 'A' });
  assert.ok(seen.endsWith('/Account/Website_Customer_Id__c/C%201%2F2'));
});

test('errors become readable and flag retryability', async () => {
  const client = new RestClient({
    instance: 'https://i.test', token: 't',
    fetchImpl: async () => respond(400, [{ errorCode: 'REQUIRED_FIELD_MISSING', message: 'Required fields are missing: [Name]', fields: ['Name'] }])
  });
  await assert.rejects(() => client.upsertCustomer('C-1', {}), err => {
    assert.match(err.message, /REQUIRED_FIELD_MISSING/);
    assert.equal(err.retryable, false);
    return true;
  });
});

test('query follows pages', async () => {
  const pages = [
    respond(200, { done: false, nextRecordsUrl: '/n', records: [{ Id: '1' }] }),
    respond(200, { done: true, records: [{ Id: '2' }] })
  ];
  const client = new RestClient({ instance: 'https://i.test', token: 't', fetchImpl: async () => pages.shift() });
  assert.equal((await client.query('SELECT Id FROM Account')).length, 2);
});

test('findByName escapes quotes', async () => {
  let seen;
  const client = new RestClient({ instance: 'https://i.test', token: 't', fetchImpl: async url => { seen = decodeURIComponent(url); return respond(200, { done: true, records: [] }); } });
  await client.findByName("O'Neil");
  assert.ok(seen.includes("Name = 'O\\'Neil'"));
});
```

## What happens behind the scenes

When your request arrives, Salesforce checks the bearer token, finds the user behind it, and applies that user's object and field permissions. The request then runs in a normal transaction, so validation rules, triggers and flows on Account all fire exactly as they would for a user saving in the browser. If a validation rule fails you get a `400` with its message.

An upsert with an External ID asks the database: "is there a row whose `Website_Customer_Id__c` equals this value?" If yes, it updates (`204`); if not, it inserts (`201`). The unique index guarantees there can never be two, which is why repeating the same sign-up is safe.

Queries return up to 2,000 records per page. Salesforce keeps a cursor for the rest and hands you its address in `nextRecordsUrl`, which is why the client loops until `done` is true.

A few details are worth knowing early. The `fields` query string on a read limits the response to the columns you name, which keeps payloads small and is polite to the platform. Field names in JSON are API names, so custom fields end in `__c`. Dates are ISO 8601 strings in UTC, such as `2026-12-01T09:00:00Z`, and picklist values must match an active value exactly.

Also remember that the REST API is not free. Each call counts against the org's rolling 24-hour API allocation, so a loop that makes one request per record can be expensive. When you need to create or change many records together, move to the composite resources described in the next article in this series, or to Bulk API 2.0 for very large volumes. For a few records per minute, plain REST is perfectly fine and the easiest to debug.

## Test it and verify

1. Run `node --test` and confirm five passing tests.
2. Run the create curl command and check the Account in the org.
3. Run `node src/signup.mjs` twice. The first prints `created`, the second `updated`, and the org has one Account.
4. Remove the token variable and run again. Expect a `401` error message, proving that errors surface.
5. Query for a name containing an apostrophe, such as `O'Neil Books`, and confirm it returns without a syntax error.

## Common mistakes and fixes

- **Not URL-encoding SOQL.** Spaces and quotes break the URL. Use `--data-urlencode` or `encodeURIComponent`.
- **Building SOQL from raw input.** This allows injection. Escape quotes or use a fixed filter.
- **Expecting a body from PATCH.** An update returns `204` with nothing.
- **Ignoring `done`.** You get the first page only.
- **Reading errors as text.** Salesforce returns a JSON array with `errorCode` and `message`.
- **Hard-coding secrets.** Use environment variables.

| Status | Usually means |
|---|---|
| 400 | Bad JSON or field values; `errorCode` explains |
| 401 | Expired or invalid token |
| 403 | Missing permission or API access |
| 404 | Wrong id or URL |
| 429 or 5xx | Temporary; retry with backoff |

## Key takeaways

- A REST URL is domain, version, resource, and every call needs a bearer token.
- `POST` creates, `GET` reads, `PATCH` updates and `DELETE` removes.
- Upsert on an External ID to make syncs repeatable.
- Page through query results and read the JSON error array.
- Pin the API version and move it on purpose.

## Where to go next

- Read [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/) to get a token properly.
- Read [Composite API guide](/articles/composite-api-guide/) to cut the number of calls.
- Read [Salesforce APIs map](/articles/salesforce-apis-map/) to see the other APIs.
