---
title: "Deploying Agentforce Everywhere: Slack, Teams, Websites, Apps and APIs"
description: "Where an Agentforce agent can live and how to choose: a tested channel selector, a launch-readiness validator and a rollout checklist you can run."
category: agentforce
tags: [Agentforce, Slack, Microsoft Teams, Channels, Intermediate]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/agentforce-channels-overview.jpg
sources:
  - title: "Agentforce in Slack: custom Slack actions"
    url: "https://docs.slack.dev/ai/customizing-agentforce-agents-with-custom-slack-actions"
  - title: "Trailhead: Integrate Agentforce IT Service with Microsoft Teams"
    url: "https://trailhead.salesforce.com/content/learn/modules/microsoft-teams-integration-for-agentforce-it-service/integrate-agentforce-it-service-with-microsoft-teams"
  - title: "Agentforce Conversation Client"
    url: "https://developer.salesforce.com/docs/platform/accsdk/guide/"
  - title: "Get Started with the Agent API"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-get-started.html"
---

One agent definition can serve several **channels**. Choosing the channel is a product decision with security consequences: each one changes who the "user" is and what the agent can see. This article lists the channels, gives you a small, tested selector that turns requirements into a recommendation, and a launch-readiness validator so that no channel goes live with a gap.

## The business scenario

Evergreen Insurance (a fictional insurer) has one claims-status agent and four requests from different teams. Claims staff want it in Slack. The IT help desk wants a version in Microsoft Teams. Marketing wants it on the public website for policyholders. And a partner's developers want to call it from their own mobile app. The platform team must decide which channel serves each request, and prove each launch is ready.

## Before you start: setup

### In Salesforce

1. Build and test the agent in the builder first. It must be **Active** before any channel is connected.
2. Create separate agent users or permission sets per channel where identity differs, with least privilege. A public channel should never reuse the permissions of an internal one.
3. Check licensing and availability for each channel in the current documentation, because they differ and can change.
4. Decide where conversation logs go and who reviews them.

### In the external system

1. **Slack:** an admin of the Slack workspace who can install apps.
2. **Teams:** a Microsoft Entra ID administrator, because the Teams integration uses an Entra ID auth provider.
3. **Website:** a web owner who controls the allowed origins and a privacy notice.
4. **Custom app:** a backend developer, as shown in the Agent API article.
5. Node 20 or newer for the selector and validator in this article.

## How it works

| Channel | Good for | How |
|---|---|---|
| **Slack** | Employee assistance, sales and service swarming | Agentforce in Slack; custom Slack actions through Apex and the Slack Web API |
| **Microsoft Teams** | Employee service (for example IT help) | Teams integration for Employee Service, Teams apps for employees and fulfillers |
| **External website** | Customer service chat | Messaging for web (Enhanced Chat) or the Agentforce Conversation Client Web SDK |
| **Custom app, backend or voice** | Full control of the UI | Agent API |
| **Other AI clients** | Let outside agents use Salesforce | Hosted MCP servers |
| **Salesforce UI** | Agents inside Lightning | Standard deployment in the Salesforce app |

Details from the sources:

- **Slack.** Agentforce agents can be installed in Slack. Per the Slack developer guide for custom actions, you need a connected Salesforce org and Slack workspace, the agent **Active** before connecting, and the Slack integration installed.
- **Microsoft Teams.** The Trailhead module for Agentforce IT Service describes enabling Microsoft Teams for Employee Service, which installs an external client app, Entra ID auth provider, external credentials and named credentials. You replace placeholders for Tenant ID, Client ID and Secret, enable CORS for the OAuth endpoints and an allowed origin, configure Lightning Out session settings, install the Salesforce IT Service and IT Desk apps in Teams, and connect Microsoft Entra ID. Employees can create and track tickets and chat with an AI assistant; fulfillers can manage incidents and start a "swarm" channel. This is the documented Teams scenario; other uses may differ.
- **External websites.** The Agentforce Conversation Client (ACC) Web SDK adds the conversation experience to external web apps, with streaming text, feedback and theming. Its documentation says it is not the right choice for headless integrations (SMS or WhatsApp) or custom native mobile apps. It was labelled Beta on its overview page at the time of research, so check its status.
- **Agent API and MCP.** Use the Agent API when you need your own UI or backend flow, and Hosted MCP Servers so external AI clients can call governed Salesforce tools.

## Basic example

The decision, written as a short procedure:

1. Users in Slack or Teams all day: use those channels with narrow, action-focused agents.
2. Public customers: web messaging or the Conversation Client, with strong escalation to humans.
3. Custom experience or voice: Agent API.
4. Each channel changes **identity and permissions**: who is the user, and what can the agent see? Decide before launch.

## Advanced end-to-end example

**channels/select.mjs** encodes the table and the four rules, so a recommendation can be reproduced and challenged in code review.

```javascript
export function recommend({ audience, wantsCustomUi, headless, usesSlack, usesTeams, externalAiClients }) {
  const picks = [];
  const warnings = [];

  if (externalAiClients) {
    picks.push({ channel: 'Hosted MCP servers', reason: 'Outside AI clients need governed tools, not a chat window.' });
  }
  if (wantsCustomUi || headless) {
    picks.push({ channel: 'Agent API', reason: 'Full control of the UI or no UI at all (voice, SMS, backend).' });
    if (headless) {
      warnings.push('The Conversation Client Web SDK is not intended for headless integrations such as SMS or WhatsApp.');
    }
  } else if (audience === 'public') {
    picks.push({ channel: 'External website', reason: 'Messaging for web or the Conversation Client suits public chat.' });
    warnings.push('Public audience: add strong escalation to humans and a separate least-privilege agent user.');
  } else if (audience === 'employees') {
    if (usesTeams) {
      picks.push({ channel: 'Microsoft Teams', reason: 'Employees already work in Teams; the documented scenario is IT service.' });
    }
    if (usesSlack) {
      picks.push({ channel: 'Slack', reason: 'Employees already work in Slack; use narrow, action-focused agents.' });
    }
    if (!usesTeams && !usesSlack) {
      picks.push({ channel: 'Salesforce UI', reason: 'No chat tool in common use; embed the agent in Lightning.' });
    }
  }

  if (picks.length === 0) {
    warnings.push('No channel matched. Check the audience value (public or employees).');
  }
  return { picks, warnings };
}
```

**channels/readiness.mjs** checks a launch plan, per channel, against the rollout checklist.

```javascript
const COMMON = ['agentActive', 'testedInBuilder', 'pilotGroupDefined', 'escalationPath', 'monitoringOwner', 'identityDecided'];

const SPECIFIC = {
  'Slack': ['slackAppInstalled', 'workspacesChosen'],
  'Microsoft Teams': ['entraConnected', 'corsAndOriginsSet', 'teamsAppsInstalled'],
  'External website': ['allowedOriginsSet', 'privacyNoticeShown', 'rateLimits'],
  'Agent API': ['secretsOnServerOnly', 'sessionsEnded', 'rateLimits'],
  'Hosted MCP servers': ['toolsReviewed', 'scopesLimited'],
  'Salesforce UI': ['permissionSetAssigned']
};

export function missing(channel, done) {
  const needed = [...COMMON, ...(SPECIFIC[channel] ?? [])];
  return needed.filter(item => done[item] !== true);
}

export function readiness(plan) {
  return plan.channels.map(({ channel, done }) => {
    const gaps = missing(channel, done);
    return { channel, ready: gaps.length === 0, gaps };
  });
}
```

**channels/channels.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { recommend } from './select.mjs';
import { missing, readiness } from './readiness.mjs';

test('public customers get the website channel with a warning about escalation', () => {
  const r = recommend({ audience: 'public' });
  assert.equal(r.picks[0].channel, 'External website');
  assert.ok(r.warnings.some(w => w.includes('escalation')));
});

test('employees on Slack and Teams get both', () => {
  const r = recommend({ audience: 'employees', usesSlack: true, usesTeams: true });
  assert.deepEqual(r.picks.map(p => p.channel), ['Microsoft Teams', 'Slack']);
});

test('headless needs the Agent API and warns about the Web SDK', () => {
  const r = recommend({ audience: 'public', headless: true });
  assert.equal(r.picks[0].channel, 'Agent API');
  assert.ok(r.warnings[0].includes('headless'));
});

test('external AI clients are pointed at MCP', () => {
  assert.equal(recommend({ audience: 'employees', externalAiClients: true }).picks[0].channel, 'Hosted MCP servers');
});

test('an unknown audience produces a warning, not a guess', () => {
  assert.ok(recommend({ audience: 'martians' }).warnings[0].includes('No channel matched'));
});

test('a channel is not ready until common and specific items are done', () => {
  const done = { agentActive: true, testedInBuilder: true, pilotGroupDefined: true, escalationPath: true, monitoringOwner: true, identityDecided: true };
  assert.deepEqual(missing('Slack', done), ['slackAppInstalled', 'workspacesChosen']);
  assert.deepEqual(missing('Slack', { ...done, slackAppInstalled: true, workspacesChosen: true }), []);
});

test('readiness reports each channel separately', () => {
  const out = readiness({ channels: [{ channel: 'Salesforce UI', done: {} }] });
  assert.equal(out[0].ready, false);
  assert.ok(out[0].gaps.includes('permissionSetAssigned'));
});
```

A launch plan to feed the validator:

```json
{
  "channels": [
    {
      "channel": "Slack",
      "done": {
        "agentActive": true, "testedInBuilder": true, "pilotGroupDefined": true,
        "escalationPath": true, "monitoringOwner": true, "identityDecided": true,
        "slackAppInstalled": true, "workspacesChosen": false
      }
    }
  ]
}
```

**channels/check.mjs** prints the result for a plan file and fails when anything is missing.

```javascript
import { readFile } from 'node:fs/promises';
import { readiness } from './readiness.mjs';

const plan = JSON.parse(await readFile(process.argv[2] ?? 'plan.json', 'utf8'));
const results = readiness(plan);
for (const r of results) {
  console.log(`${r.ready ? 'READY ' : 'NOT READY'} ${r.channel}${r.gaps.length ? ': missing ' + r.gaps.join(', ') : ''}`);
}
process.exit(results.every(r => r.ready) ? 0 : 1);
```

For the website channel, two small protections belong in front of any custom proxy: an allowed-origins check and a per-visitor limit. This helper is written for this article:

**channels/webGuard.mjs**

```javascript
export function originAllowed(origin, allowList) {
  if (!origin) {
    return false;
  }
  try {
    return allowList.includes(new URL(origin).origin);
  } catch {
    return false;
  }
}

export class RateLimiter {
  constructor({ limit = 10, windowMs = 60_000, clock = () => Date.now() } = {}) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.clock = clock;
    this.hits = new Map();
  }

  take(key) {
    const now = this.clock();
    const recent = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}
```

**channels/webGuard.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { originAllowed, RateLimiter } from './webGuard.mjs';

test('only listed origins are allowed', () => {
  const list = ['https://www.evergreen.example'];
  assert.equal(originAllowed('https://www.evergreen.example', list), true);
  assert.equal(originAllowed('https://evil.example', list), false);
  assert.equal(originAllowed(undefined, list), false);
  assert.equal(originAllowed('not a url', list), false);
});

test('the limiter blocks after the limit and recovers after the window', () => {
  let now = 0;
  const limiter = new RateLimiter({ limit: 2, windowMs: 1000, clock: () => now });
  assert.equal(limiter.take('v1'), true);
  assert.equal(limiter.take('v1'), true);
  assert.equal(limiter.take('v1'), false);
  assert.equal(limiter.take('v2'), true);
  now = 1500;
  assert.equal(limiter.take('v1'), true);
});
```

Run everything:

```bash
node --test channels
node channels/check.mjs plan.json
```

## What happens behind the scenes

All channels talk to the same agent, but each reaches it through a different door with a different identity. In Slack and Teams, the platform connectors map the chat user to a Salesforce context and the agent's actions run as an agent user whose permissions you control. On a website, the visitor is anonymous, so the agent should run as a low-privilege user and only reveal data the visitor has proven they own (for example by matching an email in an action). With the Agent API, your backend is the door: it holds the credentials, so *it* decides who gets which session.

That is why identity is on the readiness list for every channel. A channel launch that skips "who is the user, and what can they see?" is the most common cause of a privacy incident. The checklist also repeats items that do not depend on the channel, such as an escalation path and a named owner, because they matter equally everywhere.

## Test it and verify

1. Run `node --test channels` and confirm all nine tests pass.
2. Call `recommend` with your own requirements and challenge the answer with a colleague.
3. Fill in `plan.json` for the channel you are launching and run the readiness command. Fix every gap.
4. Activate the agent, confirm it works in the builder, then follow the channel's setup documentation.
5. Start with an internal pilot group and read real conversations daily for the first week.
6. Check each channel's identity: sign in as a normal user and confirm the agent cannot reveal anything that user could not see.

## Common mistakes and fixes

- **Connecting a channel before the agent is Active.** Slack requires it. Activate first.
- **Reusing internal permissions for a public channel.** Create a separate least-privilege agent user.
- **Using the Web SDK for SMS or WhatsApp.** It is not meant for headless use; use the Agent API.
- **Skipping escalation on public chat.** Provide a clear handoff to a person.
- **Assuming a Beta feature is stable.** Check status before you commit a launch date.
- **No monitoring owner.** Name someone accountable for conversations and incidents.

## Key takeaways

- One agent can serve Slack, Teams, websites, custom apps, MCP clients and Lightning.
- Choose the channel by where users are, and decide identity and permissions per channel.
- Public channels need the strongest escalation and the least privilege.
- Write the choice and the launch checklist down, and validate them in code.
- Pilot internally first, then widen.

## Where to go next

- Read [Agent API: talk to agents from your own app](/articles/agent-api-custom-client/) for the custom-app channel.
- Read [Agentforce in Slack: custom Slack actions](/articles/agentforce-slack-custom-actions/) for the Slack tutorial.
- Read [Agentforce conversation client on an external site](/articles/agentforce-conversation-client-external-site/) for the website channel.
