---
title: "Agent API: Talk to Agentforce Agents from Your Own App"
description: "Set up an External Client App, get a token, create Agent API sessions and exchange messages through a tested Node backend proxy."
category: agentforce
tags: [Agentforce, Agent API, Integration, OAuth, Advanced]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/agent-api-custom-client.jpg
sources:
  - title: "Get Started with the Agent API"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-get-started.html"
  - title: "Agent API Examples"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-examples.html"
  - title: "Agent API Session Lifecycle"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-lifecycle.html"
---

The **Agent API** lets your own app (a website, mobile app, backend or voice system) hold a conversation with an Agentforce agent. This article sets up the credentials, then builds a small Node backend that keeps the secret on the server, opens a session per conversation, relays messages and ends the session. It has tests that run without an org.

## The business scenario

Northgate Retail (a fictional retailer) has a web store with its own chat panel, designed by its own front-end team. They want the Agentforce order-status agent behind that panel. The browser must never see a Salesforce secret, each shopper must get a separate conversation, idle sessions must be ended, and abuse (a script sending thousands of messages) must be limited.

## Before you start: setup

### In Salesforce

1. Agentforce must be enabled and at least one agent **activated**. Per the official guide, the agent cannot be of type "Agentforce (Default)", which the Agent API does not support. Note the agent's **Id**.
2. In Setup open **External Client Apps Manager** and choose **New External Client App**. Enable OAuth and add scopes `api`, `refresh_token` / `offline_access`, `chatbot_api` and `sfap_api`.
3. Enable the **Client Credentials Flow** and JWT-based access tokens for named users. On the **Policy** tab enable Client Credentials and set **Run As** to a user with at least API Only access. The guide also lists secret and PKCE requirement checkboxes to disable for this flow; follow the current page.
4. Copy the **Consumer Key** and **Consumer Secret** into your secret store.
5. Find your **My Domain** URL. The Agent API base URL is `https://api.salesforce.com` (Government Cloud uses `https://api.gov.salesforce.com`).
6. Do all of this in a sandbox first.

### In the external system

1. Create a backend service (Node 20 or newer) that holds the consumer key and secret as environment variables.
2. Decide how your web store identifies a shopper (a session cookie, for example). The backend maps that identity to a Salesforce `sessionId`.
3. Put the service behind HTTPS and apply rate limits.

## How it works

The lifecycle: create a session, send messages with the session id, end the session. The agent tracks context across the session. There is also an endpoint for feedback on a response. Use the **synchronous** endpoint for simple cases (the whole reply at once) and the **streaming** endpoint to show text as it arrives.

Per the guide, the **token** comes from your My Domain with the client credentials grant, and the response includes `api_instance_url`. A **session** is created with a POST to `/einstein/ai-agent/v1/agents/{AGENT_ID}/sessions`. The response contains `sessionId`, `_links` for `messages` (stream), `session` and `end`, and an initial `messages` array holding the greeting. The `_links` in the guide show:

- Stream: `https://api.salesforce.com/einstein/ai-agent/v1/sessions/{SESSION_ID}/messages/stream`
- End: `https://api.salesforce.com/einstein/ai-agent/v1/sessions/{SESSION_ID}`

**Accuracy note.** The Get Started page does **not** document the message request body or the HTTP methods for sending messages and ending the session. Take them from the **Agent API Examples** page or the official Postman collection and verify before coding. As commonly shown there, a message is sent to the session's messages endpoint as JSON containing a `message` object with a sequence number and text, and the session is ended with an HTTP DELETE on the session URL. In the code below, those two details live in one small function each, so you can correct them in one place.

## Basic example

Get a token:

```bash
curl -X POST "https://yourdomain.my.salesforce.com/services/oauth2/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=$CONSUMER_KEY" -d "client_secret=$CONSUMER_SECRET"
```

Create a session with the access token from the reply:

```bash
curl -X POST "https://api.salesforce.com/einstein/ai-agent/v1/agents/$AGENT_ID/sessions" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
    "externalSessionKey": "'"$(uuidgen)"'",
    "instanceConfig": { "endpoint": "https://yourdomain.my.salesforce.com" },
    "streamingCapabilities": { "chunkTypes": ["Text"] },
    "bypassUser": true
  }'
```

`bypassUser: true` uses the agent-assigned user; `false` uses the token's user. This is enough to see the greeting. A real client needs token caching, one session per shopper, message sending, cleanup and limits.

## Advanced end-to-end example

**src/agentApi.mjs** is the client. It holds the token, creates sessions, sends messages and ends them.

```javascript
import { randomUUID } from 'node:crypto';

const API = process.env.AGENT_API_BASE || 'https://api.salesforce.com';

// VERIFY against the Agent API Examples page for your API version.
export function buildMessageBody(text, sequenceId) {
  return { message: { sequenceId, type: 'Text', text } };
}

// VERIFY: the guide's Get Started page does not state the method for ending a session.
export const END_METHOD = 'DELETE';

export class AgentApiClient {
  constructor({ domain, clientId, clientSecret, agentId, fetchImpl = fetch, clock = () => Date.now() }) {
    this.domain = domain;
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.agentId = agentId;
    this.fetch = fetchImpl;
    this.clock = clock;
    this.token = null;
  }

  async getToken() {
    if (this.token && this.token.expiresAt - this.clock() > 60_000) {
      return this.token.value;
    }
    const res = await this.fetch(`${this.domain}/services/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    if (!res.ok) {
      throw new Error(`Token request failed: ${res.status}`);
    }
    const data = await res.json();
    this.token = { value: data.access_token, expiresAt: this.clock() + (Number(data.expires_in) || 1500) * 1000 };
    return this.token.value;
  }

  async call(path, init = {}, retried = false) {
    const token = await this.getToken();
    const res = await this.fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers || {}) }
    });
    if (res.status === 401 && !retried) {
      this.token = null; // expired or revoked: get a new one once
      return this.call(path, init, true);
    }
    if (!res.ok) {
      throw new Error(`Agent API ${res.status} on ${path}`);
    }
    return res.status === 204 ? null : res.json();
  }

  async createSession() {
    const body = {
      externalSessionKey: randomUUID(),
      instanceConfig: { endpoint: this.domain },
      streamingCapabilities: { chunkTypes: ['Text'] },
      bypassUser: true
    };
    const data = await this.call(`/einstein/ai-agent/v1/agents/${this.agentId}/sessions`, {
      method: 'POST', body: JSON.stringify(body)
    });
    return { sessionId: data.sessionId, greeting: (data.messages ?? []).map(m => m.message ?? m.text ?? '').join(' ') };
  }

  sendMessage(sessionId, text, sequenceId) {
    return this.call(`/einstein/ai-agent/v1/sessions/${sessionId}/messages`, {
      method: 'POST', body: JSON.stringify(buildMessageBody(text, sequenceId))
    });
  }

  endSession(sessionId) {
    return this.call(`/einstein/ai-agent/v1/sessions/${sessionId}`, { method: END_METHOD });
  }
}
```

**src/conversations.mjs** maps shoppers to sessions, enforces limits and ends idle sessions.

```javascript
export class Conversations {
  constructor(client, { idleMs = 15 * 60_000, maxPerMinute = 10, clock = () => Date.now() } = {}) {
    this.client = client;
    this.idleMs = idleMs;
    this.maxPerMinute = maxPerMinute;
    this.clock = clock;
    this.byShopper = new Map();
  }

  allow(entry) {
    const now = this.clock();
    entry.recent = entry.recent.filter(t => now - t < 60_000);
    if (entry.recent.length >= this.maxPerMinute) {
      return false;
    }
    entry.recent.push(now);
    return true;
  }

  async say(shopperId, text) {
    if (typeof text !== 'string' || text.length === 0 || text.length > 1000) {
      throw new Error('Message must be 1 to 1000 characters');
    }
    let entry = this.byShopper.get(shopperId);
    if (!entry) {
      const { sessionId, greeting } = await this.client.createSession();
      entry = { sessionId, sequence: 0, recent: [], lastUsed: this.clock(), greeting };
      this.byShopper.set(shopperId, entry);
    }
    if (!this.allow(entry)) {
      const err = new Error('Too many messages, please slow down');
      err.status = 429;
      throw err;
    }
    entry.sequence += 1;
    entry.lastUsed = this.clock();
    return this.client.sendMessage(entry.sessionId, text, entry.sequence);
  }

  async sweep() {
    const now = this.clock();
    let ended = 0;
    for (const [shopper, entry] of this.byShopper) {
      if (now - entry.lastUsed > this.idleMs) {
        this.byShopper.delete(shopper);
        await this.client.endSession(entry.sessionId).catch(() => {});
        ended++;
      }
    }
    return ended;
  }
}
```

**src/server.mjs** exposes one endpoint to your front end. The browser never sees Salesforce credentials.

```javascript
import { createServer } from 'node:http';
import { AgentApiClient } from './agentApi.mjs';
import { Conversations } from './conversations.mjs';

const client = new AgentApiClient({
  domain: process.env.SF_DOMAIN,
  clientId: process.env.SF_CLIENT_ID,
  clientSecret: process.env.SF_CLIENT_SECRET,
  agentId: process.env.AGENT_ID
});
const conversations = new Conversations(client);
setInterval(() => conversations.sweep(), 60_000).unref();

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/chat') {
    res.writeHead(404).end();
    return;
  }
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 5000) {
      res.writeHead(413).end();
      return;
    }
  }
  try {
    const { shopperId, text } = JSON.parse(body);
    const reply = await conversations.say(String(shopperId), text);
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
  } catch (err) {
    res.writeHead(err.status || 400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
  }
}).listen(3000);
```

**test/conversations.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentApiClient, buildMessageBody } from '../src/agentApi.mjs';
import { Conversations } from '../src/conversations.mjs';

function fakeClient() {
  const calls = { created: 0, sent: [], ended: [] };
  return {
    calls,
    createSession: async () => ({ sessionId: 's' + (++calls.created), greeting: 'Hi' }),
    sendMessage: async (id, text, seq) => { calls.sent.push({ id, text, seq }); return { ok: true }; },
    endSession: async id => { calls.ended.push(id); }
  };
}

test('each shopper gets one session and increasing sequence numbers', async () => {
  const client = fakeClient();
  const c = new Conversations(client);
  await c.say('a', 'hello');
  await c.say('a', 'again');
  await c.say('b', 'hi');
  assert.equal(client.calls.created, 2);
  assert.deepEqual(client.calls.sent.map(s => s.seq), [1, 2, 1]);
});

test('too many messages in a minute are rejected with 429', async () => {
  const c = new Conversations(fakeClient(), { maxPerMinute: 2 });
  await c.say('a', '1');
  await c.say('a', '2');
  await assert.rejects(() => c.say('a', '3'), err => err.status === 429);
});

test('idle sessions are ended by the sweep', async () => {
  let now = 0;
  const client = fakeClient();
  const c = new Conversations(client, { idleMs: 1000, clock: () => now });
  await c.say('a', 'hello');
  now = 5000;
  assert.equal(await c.sweep(), 1);
  assert.deepEqual(client.calls.ended, ['s1']);
});

test('empty or huge messages are refused', async () => {
  const c = new Conversations(fakeClient());
  await assert.rejects(() => c.say('a', ''));
  await assert.rejects(() => c.say('a', 'x'.repeat(2000)));
});

test('the client refreshes its token once after a 401', async () => {
  const tokens = ['old', 'new'];
  const seen = [];
  const fetchStub = async (url, init) => {
    if (url.endsWith('/services/oauth2/token')) {
      return { ok: true, status: 200, json: async () => ({ access_token: tokens.shift(), expires_in: 600 }) };
    }
    seen.push(init.headers.Authorization);
    return seen.length === 1
      ? { ok: false, status: 401, json: async () => ({}) }
      : { ok: true, status: 200, json: async () => ({ sessionId: 'abc', messages: [{ message: 'Hello' }] }) };
  };
  const client = new AgentApiClient({ domain: 'https://d.test', clientId: 'i', clientSecret: 's', agentId: 'a1', fetchImpl: fetchStub });
  const session = await client.createSession();
  assert.equal(session.sessionId, 'abc');
  assert.deepEqual(seen, ['Bearer old', 'Bearer new']);
});

test('message body is built in one place', () => {
  assert.deepEqual(buildMessageBody('hi', 3), { message: { sequenceId: 3, type: 'Text', text: 'hi' } });
});
```

Run it:

```bash
node --test
SF_DOMAIN=https://yourdomain.my.salesforce.com SF_CLIENT_ID=... SF_CLIENT_SECRET=... AGENT_ID=... node src/server.mjs
```

## What happens behind the scenes

The token request goes to your My Domain, which checks the consumer key and secret and issues a token for the configured run-as user. The Agent API lives on `api.salesforce.com`, so session and message calls go there with the bearer token, and `instanceConfig.endpoint` tells it which org to use. When you create a session, Salesforce starts a conversation for the agent, returns the greeting and a `sessionId`, and keeps the context (what the shopper said before, variables, action results) until the session ends or times out.

Each message you send is processed by the agent's reasoning engine exactly as in the builder preview: choose a subagent, apply instructions, run actions as the agent's user, reply. `bypassUser: true` makes the agent use its assigned user; with `false` it uses the token's user, which is useful when you need user-level permissions but means every shopper acts as the same Salesforce user, so it is rarely right for public chat.

Your backend adds what the API does not provide: mapping a shopper to a session, ending idle sessions so they do not linger, and limiting abuse before it costs money.

## Test it and verify

1. Run `node --test` and confirm all six tests pass.
2. In a sandbox, create the External Client App and call the token curl command. Confirm you receive an `access_token`.
3. Run the session curl command with your agent id. Confirm a `sessionId` and a greeting.
4. Check the Agent API Examples page and confirm `buildMessageBody` and `END_METHOD` match your API version. Fix them if not.
5. Start the server, then `curl -X POST localhost:3000/chat -d '{"shopperId":"s1","text":"Where is order ORD-1001?"}'`. Confirm a reply.
6. Send eleven messages in a minute and confirm the eleventh returns 429.
7. Wait past the idle limit (or lower it in a test) and confirm the session is ended.

## Common mistakes and fixes

- **Using the Agentforce (Default) agent.** The Agent API does not support it. Use a custom activated agent.
- **Calling Salesforce from the browser.** The consumer secret leaks. Always proxy through your backend.
- **One session for everyone.** Conversations mix. Create one session per conversation.
- **Never ending sessions.** Sweep idle ones and end on logout.
- **Trusting the shopper id from the browser.** Authenticate shoppers yourself and derive the id on the server.
- **Copying request fields from memory.** Verify message and end-session details against the Examples page.

## Key takeaways

- The Agent API gives your own app a conversation with an Agentforce agent: token, session, messages, end.
- Keep secrets on the backend and map each shopper to their own session.
- Limit message size and rate, and end idle sessions.
- Isolate unverified request details so they are easy to fix.
- Authenticating your own users is your responsibility.

## Where to go next

- Read [Agentforce channels overview](/articles/agentforce-channels-overview/) to compare the Agent API with ready-made channels.
- Read [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/) for the token setup in more depth.
- Read [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/) before exposing an agent to the public.
