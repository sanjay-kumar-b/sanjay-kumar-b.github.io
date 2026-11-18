---
title: "OAuth for Salesforce Integrations: Flows and External Client Apps"
description: "Pick the right OAuth flow, set up an External Client App, and build a tested token client for client credentials and JWT bearer."
category: salesforce-development
tags: [OAuth, Integration, Security, Intermediate]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/oauth-flows-and-external-client-apps.jpg
sources:
  - title: "External Client Apps and Connected Apps (Mobile SDK guide)"
    url: "https://developer.salesforce.com/docs/platform/mobile-sdk/guide/connected-apps.html"
  - title: "Get Started with the Agent API (ECA setup example)"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-get-started.html"
---

Before any external program can call Salesforce, it must prove who it is and receive an **access token**. OAuth is the standard way to do that. This article explains which flow to choose, how to set up an **External Client App** (the current way to register an integration), and gives you a small, tested token client you can reuse.

## The business scenario

Harbor Logistics (a fictional shipper) runs a nightly job on its own server that reads shipment cases from Salesforce and updates their status. No human is present, so there is no login screen. The job must authenticate as a dedicated integration user, keep its secrets out of source code, refresh its token before it expires, and fail loudly when the credentials stop working.

## Before you start: setup

### In Salesforce

1. Create an integration user, with its own license type suited to API use, and a permission set that grants only the objects and fields the job needs. Name it clearly, for example `harbor.integration@yourcompany.com`.
2. Go to **Setup > External Client App Manager > New External Client App**. Give it a name, contact email and distribution state of **Local**.
3. In the **OAuth settings** enable OAuth, add the scope **Manage user data via APIs (api)**, and add `https://localhost/callback` as a callback URL if the form requires one.
4. For a server job with no user present, enable the **client credentials flow** and choose the **run as** user (your integration user). For a signed-token approach, enable the **JWT bearer flow** and upload the public certificate.
5. Save, then open the app's settings and copy the **Consumer Key** and **Consumer Secret**. Store them in your secret manager.
6. In the app's policies, restrict access to the permission set you created, and set IP restrictions if your server has a fixed address.
7. Find your **My Domain** login URL, such as `https://yourcompany.my.salesforce.com`. Token requests go to this domain.

Because Salesforce has been restricting the creation of new connected apps in favour of External Client Apps, expect the External Client App Manager to be the path in current orgs. Menu names change between releases, so confirm them against the current documentation linked below.

### In the external system

1. Put the consumer key and secret (or the private key for JWT) in environment variables or a secret manager, never in the repository.
2. Use Node 20 or newer so the built-in `fetch` and `crypto` modules are available.
3. Make the server clock accurate (NTP). JWT tokens carry an expiry and clock drift breaks them.

## How it works

You choose a flow by asking who is acting:

- **Client credentials.** A server acts as itself, as the configured run-as user. Simple, no user interaction. Best for back-end jobs.
- **JWT bearer.** A server signs a short token with a private key and exchanges it. No secret is sent over the wire. Best when you want key-based trust and tight control.
- **Authorization code with PKCE.** A real person logs in through a browser, and the app gets a token on their behalf. Best for web and mobile apps.
- **Username-password.** Avoid it. It sends credentials directly and is disabled or discouraged in modern orgs.

The result of every flow is an access token and the instance URL to call. The token is short lived. Your client asks for a new one when it is close to expiry, rather than on every request.

## Basic example

The shortest working token request for the client credentials flow is a single curl call.

```bash
curl -s -X POST "https://yourcompany.my.salesforce.com/services/oauth2/token" \
  -d "grant_type=client_credentials" \
  -d "client_id=$SF_CLIENT_ID" \
  -d "client_secret=$SF_CLIENT_SECRET"
```

The response is JSON.

```json
{
  "access_token": "00D...!AQ...",
  "instance_url": "https://yourcompany.my.salesforce.com",
  "token_type": "Bearer",
  "issued_at": "1731660000000",
  "scope": "api"
}
```

Use it like this:

```bash
curl -s "https://yourcompany.my.salesforce.com/services/data/v67.0/query?q=SELECT+Id+FROM+Account+LIMIT+1" \
  -H "Authorization: Bearer $ACCESS_TOKEN"
```

This is fine for a test. A real job needs caching, expiry handling, retries after an expired token, and tests.

## Advanced end-to-end example

The code below is a small Node package with a token provider that supports both flows, an API client that refreshes on `401`, a command-line job, and tests that run without a real org.

**src/config.mjs**

```javascript
export function loadConfig(env = process.env) {
  const required = ['SF_LOGIN_URL', 'SF_CLIENT_ID'];
  for (const key of required) {
    if (!env[key]) {
      throw new Error(`Missing environment variable ${key}`);
    }
  }
  const flow = env.SF_FLOW || 'client_credentials';
  if (flow === 'client_credentials' && !env.SF_CLIENT_SECRET) {
    throw new Error('SF_CLIENT_SECRET is required for client_credentials');
  }
  if (flow === 'jwt_bearer' && !(env.SF_PRIVATE_KEY && env.SF_USERNAME)) {
    throw new Error('SF_PRIVATE_KEY and SF_USERNAME are required for jwt_bearer');
  }
  return {
    loginUrl: env.SF_LOGIN_URL.replace(/\/$/, ''),
    clientId: env.SF_CLIENT_ID,
    clientSecret: env.SF_CLIENT_SECRET,
    privateKey: env.SF_PRIVATE_KEY,
    username: env.SF_USERNAME,
    apiVersion: env.SF_API_VERSION || 'v67.0',
    flow
  };
}
```

**src/jwt.mjs**

```javascript
import { createSign } from 'node:crypto';

const b64url = value =>
  Buffer.from(value).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');

export function buildAssertion({ clientId, username, loginUrl, privateKey }, now = Date.now()) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: clientId,
    sub: username,
    aud: loginUrl,
    exp: Math.floor(now / 1000) + 180
  };
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signature = createSign('RSA-SHA256').update(unsigned).sign(privateKey);
  const encoded = signature.toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${unsigned}.${encoded}`;
}
```

**src/tokenProvider.mjs**

```javascript
import { buildAssertion } from './jwt.mjs';

export class TokenProvider {
  constructor(config, fetchImpl = fetch, clock = () => Date.now()) {
    this.config = config;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.cached = null;
  }

  async getToken(forceRefresh = false) {
    const stillValid = this.cached && this.cached.expiresAt - this.clock() > 60_000;
    if (!forceRefresh && stillValid) {
      return this.cached;
    }
    const body = new URLSearchParams();
    if (this.config.flow === 'jwt_bearer') {
      body.set('grant_type', 'urn:ietf:params:oauth:grant-type:jwt-bearer');
      body.set('assertion', buildAssertion(this.config, this.clock()));
    } else {
      body.set('grant_type', 'client_credentials');
      body.set('client_id', this.config.clientId);
      body.set('client_secret', this.config.clientSecret);
    }
    const res = await this.fetch(`${this.config.loginUrl}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    if (!res.ok) {
      // Never log the secret. The error body names the reason, for example invalid_client.
      throw new Error(`Token request failed (${res.status}): ${text}`);
    }
    const data = JSON.parse(text);
    // Salesforce does not always return expires_in, so assume a conservative 20 minutes.
    const lifetimeMs = (Number(data.expires_in) || 1200) * 1000;
    this.cached = {
      accessToken: data.access_token,
      instanceUrl: data.instance_url,
      expiresAt: this.clock() + lifetimeMs
    };
    return this.cached;
  }
}
```

**src/salesforceClient.mjs**

```javascript
export class SalesforceClient {
  constructor(config, tokenProvider, fetchImpl = fetch) {
    this.config = config;
    this.tokens = tokenProvider;
    this.fetch = fetchImpl;
  }

  async request(path, init = {}, retried = false) {
    const token = await this.tokens.getToken(retried);
    const res = await this.fetch(`${token.instanceUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token.accessToken}`,
        'Content-Type': 'application/json',
        ...(init.headers || {})
      }
    });
    if (res.status === 401 && !retried) {
      return this.request(path, init, true); // token expired or revoked: refresh once
    }
    if (!res.ok) {
      throw new Error(`Salesforce ${res.status}: ${await res.text()}`);
    }
    return res.status === 204 ? null : res.json();
  }

  query(soql) {
    return this.request(`/services/data/${this.config.apiVersion}/query?q=${encodeURIComponent(soql)}`);
  }

  updateCase(id, fields) {
    return this.request(`/services/data/${this.config.apiVersion}/sobjects/Case/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(fields)
    });
  }
}
```

**src/job.mjs**

```javascript
import { loadConfig } from './config.mjs';
import { TokenProvider } from './tokenProvider.mjs';
import { SalesforceClient } from './salesforceClient.mjs';

export async function run(env = process.env, fetchImpl = fetch) {
  const config = loadConfig(env);
  const client = new SalesforceClient(config, new TokenProvider(config, fetchImpl), fetchImpl);
  const result = await client.query(
    "SELECT Id, Status FROM Case WHERE Status = 'Shipped' AND IsClosed = false LIMIT 50"
  );
  for (const row of result.records) {
    await client.updateCase(row.Id, { Status: 'Delivered' });
  }
  return result.records.length;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  run().then(
    count => console.log(`Updated ${count} cases`),
    err => { console.error(err.message); process.exit(1); }
  );
}
```

**test/auth.test.mjs** (run with `node --test`)

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { TokenProvider } from '../src/tokenProvider.mjs';
import { SalesforceClient } from '../src/salesforceClient.mjs';
import { buildAssertion } from '../src/jwt.mjs';
import { loadConfig } from '../src/config.mjs';

const config = {
  loginUrl: 'https://login.test', clientId: 'cid', clientSecret: 'sec',
  apiVersion: 'v67.0', flow: 'client_credentials'
};

function reply(status, body) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body), json: async () => body };
}

test('token is cached until close to expiry', async () => {
  let calls = 0;
  let now = 0;
  const fetchStub = async () => { calls++; return reply(200, { access_token: 't1', instance_url: 'https://i.test', expires_in: 600 }); };
  const provider = new TokenProvider(config, fetchStub, () => now);
  await provider.getToken();
  await provider.getToken();
  assert.equal(calls, 1);
  now = 560_000;
  await provider.getToken();
  assert.equal(calls, 2);
});

test('client refreshes once after a 401', async () => {
  const tokens = ['old', 'new'];
  const seen = [];
  const fetchStub = async (url, init) => {
    if (url.endsWith('/services/oauth2/token')) {
      return reply(200, { access_token: tokens.shift(), instance_url: 'https://i.test', expires_in: 600 });
    }
    seen.push(init.headers.Authorization);
    return seen.length === 1 ? reply(401, {}) : reply(200, { records: [] });
  };
  const client = new SalesforceClient(config, new TokenProvider(config, fetchStub), fetchStub);
  const result = await client.query('SELECT Id FROM Case');
  assert.deepEqual(result, { records: [] });
  assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
});

test('token failure surfaces the reason', async () => {
  const fetchStub = async () => reply(400, { error: 'invalid_client' });
  const provider = new TokenProvider(config, fetchStub);
  await assert.rejects(() => provider.getToken(), /invalid_client/);
});

test('JWT assertion has three parts and the right claims', () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const jwt = buildAssertion({ clientId: 'cid', username: 'a@b.com', loginUrl: 'https://login.test', privateKey }, 1_000_000);
  const parts = jwt.split('.');
  assert.equal(parts.length, 3);
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  assert.equal(claims.iss, 'cid');
  assert.equal(claims.sub, 'a@b.com');
  assert.equal(claims.exp, 1180);
});

test('config rejects missing secrets', () => {
  assert.throws(() => loadConfig({ SF_LOGIN_URL: 'https://x', SF_CLIENT_ID: 'c' }), /SF_CLIENT_SECRET/);
});
```

Run the unit tests, then the real job against a sandbox:

```bash
node --test
export SF_LOGIN_URL="https://yourcompany--sandbox.sandbox.my.salesforce.com"
export SF_CLIENT_ID="3MVG9..."
export SF_CLIENT_SECRET="..."
node src/job.mjs
```

## What happens behind the scenes

When the server posts to `/services/oauth2/token`, Salesforce finds the External Client App by consumer key, checks the flow is enabled and the secret matches, then issues a token for the run-as user. Every later API call carries that token. Salesforce resolves the user and applies their permissions and your app's policies, so the integration can only do what that user may do.

With JWT bearer, no secret travels. Salesforce verifies the signature with the public certificate you uploaded, checks that `iss` is your consumer key, `sub` is an allowed user and `aud` is the login URL, and that the token has not expired. If any claim is wrong the request fails, usually with `invalid_grant`.

Your client caches the token and refreshes about a minute before expiry. A `401` still happens if an admin revokes the session, so the client refreshes once and retries.

## Test it and verify

1. Run `node --test` and confirm all five tests pass. They use stubbed `fetch`, so no org is needed.
2. In a sandbox, create the External Client App and integration user as described, then export the environment variables.
3. Run `node src/job.mjs` with no shipped cases. Expect "Updated 0 cases", which proves the token and query work.
4. Create a Case with status `Shipped`, run again, and check it becomes `Delivered`.
5. Rotate the secret in Salesforce and rerun. Expect a clear `invalid_client` error and exit code 1.
6. Open **Setup > Login History** and confirm the integration user's logins appear.

## Common mistakes and fixes

- **Calling the wrong domain.** Token requests go to your My Domain URL, or the sandbox variant, not an old `login.salesforce.com` host for an org that requires My Domain.
- **No run-as user for client credentials.** The token request fails until the app is assigned a user.
- **Too many permissions.** An integration with System Administrator access is a breach waiting to happen. Use a permission set.
- **Committing secrets.** Rotate any secret that has been in source control.
- **Requesting a token per call.** You hit login limits and slow everything down. Cache.
- **Ignoring clock drift with JWT.** Keep the lifetime short and the server time correct.

## Key takeaways

- Choose the flow by who is acting: a server, a person or a signed key.
- Register integrations as External Client Apps and run them as a least-privilege user.
- Keep secrets in a secret manager and rotate them.
- Cache tokens, refresh before expiry and retry once on `401`.
- Test your token handling with stubs so failures are caught before production.

## Where to go next

- Read [Salesforce APIs map](/articles/salesforce-apis-map/) to see what to call once you have a token.
- Read [Inbound Apex REST services](/articles/apex-rest-services-inbound/) for a custom endpoint to call.
- Read [Outbound callouts](/articles/rest-callouts-named-credentials/) for the opposite direction.
