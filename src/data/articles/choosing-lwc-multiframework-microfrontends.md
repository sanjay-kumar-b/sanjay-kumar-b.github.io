---
title: "LWC, Multi-Framework or Microfrontends? A Decision Guide for Salesforce UIs"
description: "Compare Lightning Web Components, Multi-Framework UIBundles, Microfrontends and external apps with a scoring tool, a setup checklist and a tested decision model."
category: react-and-salesforce
tags: [LWC, Multi-Framework, Microfrontends, React, Architecture, Advanced]
publishedAt: 2026-11-12
updatedAt: 2026-11-16
cover: /images/covers/choosing-lwc-multiframework-microfrontends.jpg
sources:
  - title: "Salesforce Microfrontends (Developers Blog)"
    url: "https://developer.salesforce.com/blogs/2026/10/salesforce-microfrontends-embed-web-apps-in-lightning"
  - title: "Salesforce Multi-Framework Overview"
    url: "https://developer.salesforce.com/docs/platform/multiframework/guide/multiframework-overview.html"
  - title: "What's New in Salesforce Multi-Framework (Winter '27)"
    url: "https://developer.salesforce.com/blogs/2026/10/whats-new-in-salesforce-multi-framework-angular-is-now-ga"
---

Salesforce now offers several ways to build a UI. Salesforce describes Microfrontends, LWC and Multi-Framework as **complementary**, not replacements for one another. The hard part is choosing. This guide gives you the options, the questions that decide, the setup each option needs, and a small scoring tool you can run and test so the decision is recorded and repeatable.

## The business scenario

Juniper Consulting has four UI requests in one quarter. Sales wants a pricing configurator on the Opportunity page, and a React version already exists. Operations wants a new internal dashboard app with rich interaction, and the team knows React. Support wants a small "escalate" panel on the Case page. Marketing wants a public customer portal with its own login. One technology for all four would be wrong. You need a method that picks per request and explains why.

## Before you start: setup

### In Salesforce

Setup depends on the option you pick, so confirm these before committing:

1. **Org and release.** Check that your org is on the release that supports the feature. Multi-Framework React was reported as GA in July 2026 and Angular in October 2026, and some related features were Beta, so read the current documentation and pilot first.
2. **Developer tooling.** Use a Developer Edition org or sandbox, Salesforce CLI, and Visual Studio Code with the Salesforce extensions.
3. **For LWC:** nothing beyond a deployable project and the permission to deploy.
4. **For a Multi-Framework app:** enable the features named in the Multi-Framework documentation for your org, and decide the target (employee app or the `Experience` target for customer-facing).
5. **For a microfrontend:** follow the UI Embedding setup in the blog post, and decide which values the host page passes to the guest.
6. **For an external app:** create an External Client App for OAuth, with the smallest scopes.
7. **Security review:** confirm who may see the data and which profile or permission sets apply.

### In the external system

1. For a microfrontend or external app, host the web app on HTTPS, with a Content Security Policy that allows the Salesforce origin to frame it (for embedding).
2. Give the guest app its own authentication plan: reuse the host's context only as far as the documentation allows, otherwise sign in separately.
3. Prepare a build and release pipeline; the guest app deploys on its own schedule, independent of Salesforce releases.
4. Agree on the contract between host and guest: a short list of inputs, nothing more.

## How it works

| Option | What it is | Runs | Frameworks |
|---|---|---|---|
| **LWC** | Platform-native components | Inside Lightning pages, Experience Cloud | LWC |
| **Multi-Framework app (UIBundle)** | Whole app hosted by Salesforce | Salesforce-hosted (`salesforce.app` for employee apps) | React and Angular GA (Vue planned) |
| **Microfrontend (UI Embedding)** | External app embedded in a Lightning page | Your infrastructure, in a sandboxed iframe | Any web tech |
| **External app + APIs** | A separate product using Salesforce APIs | Anywhere | Anything |

Data access differs too. LWC uses Lightning Data Service, wire adapters and Apex. A Multi-Framework app uses the Data SDK with GraphQL (`@salesforce/platform-sdk`), with platform security enforced. A microfrontend gets whatever the host passes plus the guest's own authentication and API calls. An external app uses REST, GraphQL, Composite or Agent APIs with OAuth.

**Decision questions**, in order:

1. Does it belong on a record page or app page? LWC is the default. If a web app already exists to reuse, a microfrontend.
2. Is it a whole new app for employees? A Multi-Framework app hosted on the platform.
3. Is it customer or partner facing? Multi-Framework with the `Experience` target, Experience Cloud with LWC, or an external app.
4. Must it live outside Salesforce, with its own hosting and login? External app.
5. Do you need managed packaging? Per the Winter '27 post, Multi-Framework supports packaging for non-site apps only; LWC packaging is mature.
6. Team skills and hiring.
7. Maturity risk: LWC is the most established.

## Basic example

A decision written as plain code: the first question that matches wins.

```javascript
export function quickPick(req) {
  if (req.mustLiveOutsideSalesforce) return 'External app';
  if (req.placement === 'record-page') {
    return req.existingWebApp ? 'Microfrontend' : 'LWC';
  }
  if (req.placement === 'new-employee-app') return 'Multi-Framework app';
  if (req.placement === 'customer-facing') return 'Experience Cloud or Multi-Framework (Experience target)';
  return 'LWC';
}
```

Quick and readable, but it ignores trade-offs such as team skills and packaging. The advanced example weighs them.

## Advanced end-to-end example

A weighted scoring tool. Each option gets a score from 0 to 5 per criterion, each request weights the criteria, and the tool returns a ranked list with reasons. The scores below encode the facts in this article; adjust them to your organisation, and keep the file in version control so the decision is reviewable.

**decide/options.mjs**

```javascript
// Scores 0 (poor) to 5 (excellent) for each criterion.
export const CRITERIA = [
  'nativeFit',        // lives naturally inside Lightning pages
  'reuseExistingWeb', // can reuse a web app that already exists
  'richInteraction',  // complex, app-like UI
  'maturity',         // proven in production
  'packaging',        // managed packaging support
  'externalReach',    // customers outside Salesforce, own hosting and login
  'teamSkillsWeb'     // fits React or Angular skills
];

export const OPTIONS = {
  'LWC': {
    nativeFit: 5, reuseExistingWeb: 1, richInteraction: 3,
    maturity: 5, packaging: 5, externalReach: 2, teamSkillsWeb: 2
  },
  'Multi-Framework app': {
    nativeFit: 3, reuseExistingWeb: 3, richInteraction: 5,
    maturity: 3, packaging: 2, externalReach: 3, teamSkillsWeb: 5
  },
  'Microfrontend': {
    nativeFit: 3, reuseExistingWeb: 5, richInteraction: 4,
    maturity: 3, packaging: 1, externalReach: 3, teamSkillsWeb: 5
  },
  'External app': {
    nativeFit: 1, reuseExistingWeb: 4, richInteraction: 5,
    maturity: 4, packaging: 0, externalReach: 5, teamSkillsWeb: 5
  }
};
```

**decide/score.mjs**

```javascript
import { CRITERIA, OPTIONS } from './options.mjs';

// weights: { criterion: 0..3 }, must: criteria an option must score at least 2 on
export function rank(weights, { must = [] } = {}) {
  for (const name of Object.keys(weights)) {
    if (!CRITERIA.includes(name)) {
      throw new Error('Unknown criterion: ' + name);
    }
  }
  const results = [];
  for (const [option, scores] of Object.entries(OPTIONS)) {
    const blocked = must.filter(c => scores[c] < 2);
    if (blocked.length > 0) {
      results.push({ option, total: 0, excluded: true, reasons: blocked.map(c => `${c} is too weak`) });
      continue;
    }
    let total = 0;
    const strengths = [];
    for (const [criterion, weight] of Object.entries(weights)) {
      total += weight * scores[criterion];
      if (weight >= 2 && scores[criterion] >= 4) {
        strengths.push(criterion);
      }
    }
    results.push({ option, total, excluded: false, reasons: strengths.map(c => `strong on ${c}`) });
  }
  return results.sort((a, b) => b.total - a.total);
}

export function explain(results) {
  return results
    .map(r => (r.excluded
      ? `${r.option}: excluded (${r.reasons.join('; ')})`
      : `${r.option}: ${r.total} points${r.reasons.length ? ' (' + r.reasons.join('; ') + ')' : ''}`))
    .join('\n');
}
```

**decide/requests.mjs** records the four requests.

```javascript
export const REQUESTS = {
  'Pricing configurator on Opportunity': {
    weights: { nativeFit: 2, reuseExistingWeb: 3, richInteraction: 2, teamSkillsWeb: 1 },
    must: []
  },
  'Internal operations dashboard': {
    weights: { richInteraction: 3, teamSkillsWeb: 2, nativeFit: 1, maturity: 1 },
    must: []
  },
  'Escalate panel on Case': {
    weights: { nativeFit: 3, maturity: 2, packaging: 1 },
    must: []
  },
  'Public customer portal with own login': {
    weights: { externalReach: 3, richInteraction: 1, teamSkillsWeb: 1 },
    must: ['externalReach']
  }
};
```

**decide/run.mjs**

```javascript
import { REQUESTS } from './requests.mjs';
import { explain, rank } from './score.mjs';

for (const [name, request] of Object.entries(REQUESTS)) {
  console.log('== ' + name);
  console.log(explain(rank(request.weights, { must: request.must })));
  console.log('');
}
```

**decide/score.test.mjs** (uses Node's built-in test runner: `node --test`)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank } from './score.mjs';
import { REQUESTS } from './requests.mjs';

function winner(name) {
  const request = REQUESTS[name];
  return rank(request.weights, { must: request.must })[0].option;
}

test('a small panel on a record page goes to LWC', () => {
  assert.equal(winner('Escalate panel on Case'), 'LWC');
});

test('an existing React widget on a record page becomes a microfrontend', () => {
  assert.equal(winner('Pricing configurator on Opportunity'), 'Microfrontend');
});

test('a rich internal app with a React team goes to a Multi-Framework app or the external option', () => {
  const top = winner('Internal operations dashboard');
  assert.ok(['Multi-Framework app', 'External app', 'Microfrontend'].includes(top));
  assert.notEqual(top, 'LWC');
});

test('a public portal with its own login is an external app', () => {
  assert.equal(winner('Public customer portal with own login'), 'External app');
});

test('options that fail a must-have are excluded and listed last', () => {
  // Managed packaging is a must-have: options scoring below 2 on it drop out.
  const results = rank({ richInteraction: 3 }, { must: ['packaging'] });
  const external = results.find(r => r.option === 'External app');
  const micro = results.find(r => r.option === 'Microfrontend');
  assert.equal(external.excluded, true);
  assert.equal(micro.excluded, true);
  assert.equal(results[results.length - 1].excluded, true);
  assert.equal(results[0].excluded, false);
});

test('an unknown criterion is rejected so typos cannot skew a decision', () => {
  assert.throws(() => rank({ nativfit: 3 }), /Unknown criterion/);
});
```

Add a `package.json` next to the `decide` folder so the commands are easy to remember:

```json
{
  "name": "ui-decision-record",
  "private": true,
  "type": "module",
  "scripts": {
    "decide": "node decide/run.mjs",
    "test": "node --test decide/*.test.mjs"
  }
}
```

Run:

```bash
node decide/run.mjs
node --test decide/*.test.mjs
```

## What happens behind the scenes

Each option has a different runtime. An LWC is compiled by the Lightning platform and runs in the page with Salesforce's own security model, so it can use Lightning Data Service and wire adapters without a separate login. A Multi-Framework app is hosted by Salesforce, but you build it with React or Angular, and it reads data through the Data SDK with the platform enforcing security. A microfrontend is different in kind: your own server hosts it, and Salesforce shows it inside a **sandboxed iframe**. The browser's iframe sandbox means the guest cannot reach into the Lightning page, and the page cannot reach into the guest. They communicate only through the values the host passes. An external app has no connection to the page at all and calls Salesforce APIs after OAuth.

Those differences are why the scoring table looks the way it does. The sandbox gives a microfrontend isolation and reuse of existing code, but costs packaging and some load time. Platform hosting gives native security, but Multi-Framework is newer, so its maturity score is lower. The numbers are judgement, not measurement, and the tool's value is that it forces the judgement to be written down and challenged.

The `must` list is a hard filter. A public portal with its own login cannot be an LWC however well LWC scores on other criteria, so options that score below 2 on a must-have criterion are excluded rather than merely ranked lower.

## Test it and verify

1. Run `node --test decide/*.test.mjs` and confirm that all six tests pass.
2. Run `node decide/run.mjs` and read the four rankings. Argue with them: if a result surprises you, either the scores or the weights are wrong, and that is useful to discover.
3. Build a one-day **pilot** for the top choice: a hello-world version that reads one record, deployed to a sandbox. Confirm that deployment, login and data access all work before committing.
4. Measure load time of the pilot in the browser's Network tab, especially for an embedded iframe.
5. Record the decision, the scores, and the date in your repository so the team can revisit it when a feature leaves Beta.

## Common mistakes and fixes

- **Choosing by fashion.** Use the most native option that meets the need.
- **Ignoring Beta status.** Confirm maturity in the current documentation and pilot first.
- **Two stacks everywhere.** Maintaining LWC and React both is costly; limit the second stack to where it pays off.
- **Passing too much into a microfrontend.** Treat the guest as a separate application and pass only minimal values.
- **Forgetting performance.** Embedded iframes add latency; measure.
- **Forgetting packaging.** If you distribute a managed package, check what each option supports before building.
- **Skipping the written record.** Without it, the same debate returns every quarter.

## Key takeaways

- LWC, Multi-Framework, microfrontends and external apps are complementary.
- Ask placement, audience, reuse, packaging, skills and maturity, in that spirit.
- Use the most native option that meets the need.
- Write the decision as data so it can be tested and reviewed.
- Pilot small before committing, especially with newer features.

## Where to go next

- Read [Salesforce microfrontends and UI embedding](/articles/salesforce-microfrontends-ui-embedding/) for the embedding setup.
- Read [Getting started with Salesforce Multi-Framework](/articles/salesforce-multi-framework-getting-started/) for the hosted app route.
- Read [React vs Lightning Web Components](/articles/react-vs-lwc/) for a side-by-side code comparison.
