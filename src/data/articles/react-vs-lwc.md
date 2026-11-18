---
title: "React vs Lightning Web Components: When to Use Which"
description: "Compare React and LWC for Salesforce work with the same account list built both ways, a comparison table, and a tested decision helper."
category: react-and-salesforce
tags: [React, LWC, Architecture]
publishedAt: 2026-11-03
updatedAt: 2026-11-16
cover: /images/covers/react-vs-lwc.jpg
featured: true
sources:
  - title: "React documentation"
    url: "https://react.dev/learn"
  - title: "Lightning Web Components Developer Guide"
    url: "https://developer.salesforce.com/docs/platform/lwc/overview"
---

Both build component-based UIs with modern JavaScript. The difference is mostly **where they run and what they plug into**. This article compares them with the same small feature built twice, then gives you a decision helper whose rules you can read and argue with.

## The business scenario

Foxglove Property (a fictional estate agency) needs an **account list with a search box**: type part of a name and the list narrows. Two teams need it. The sales team wants it on the Salesforce Account home page, with Salesforce permissions applied. The marketing team wants the same list on a public partner portal on their own domain with their own branding. The same idea, two homes, so which tool belongs where?

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox with **My Domain** enabled, and a handful of Accounts for testing.
2. Install the Salesforce CLI and create an SFDX project for the LWC version. The learning roadmap article shows the project setup.
3. For the React version you will call Salesforce from outside, so create an External Client App with the `api` scope, as in the OAuth article, and a least-privilege integration user. The React app in this article uses a tiny backend proxy so the secret stays on the server.
4. Create a permission set granting read on Account for the LWC users and a separate one for the integration user.

### In the external system

1. Install Node 20 or newer.
2. Create the React app with `npm create vite@latest portal -- --template react` and add Vitest and React Testing Library for tests.
3. Decide where the proxy runs and how portal visitors are authenticated, because a public portal must never expose all accounts.

## How it works

**Lightning Web Components.** LWC is Salesforce's component model. It runs inside the Salesforce UI (record pages, apps, Experience Cloud, flows) and integrates directly with Lightning Data Service, Apex, permissions and platform events. You inherit Salesforce's design system, security and navigation.

**React.** React is a general-purpose library with a very large ecosystem. For Salesforce it is typically used for external apps and portals that talk to Salesforce through APIs, or in other contexts Salesforce supports. Salesforce's **Multi-Framework** lets you build React (generally available since July 2026) and Angular (GA since October 2026) apps as UIBundles hosted on the platform, with platform authentication and security, and **Microfrontends** embed externally hosted apps in Lightning pages. See the Multi-Framework, Microfrontends and decision-guide articles. Beta features around these change quickly, so check the current documentation.

| | LWC | React |
|---|---|---|
| Primary home | Inside Salesforce | Anywhere on the web |
| Data access | Lightning Data Service, Apex | REST or GraphQL APIs you secure yourself |
| Auth and permissions | Handled by the platform | You design it (OAuth, etc.) |
| Ecosystem | Smaller, Salesforce-focused | Very large |
| Hiring and skills reuse | Salesforce skill | Broad web skill |

Decision guide:

- Users already live in Salesforce and the UI belongs on a record page or app: **LWC**.
- A public site or customer product with its own branding and hosting: **React** (or similar), calling Salesforce APIs.
- Heavy reuse of third-party UI libraries: **React**.
- You want platform security, sharing and field-level security handled for you: **LWC**.

Learning React makes LWC easier: components, props, events and state are familiar ideas. Many developers learn both.

## Basic example

The same idea, side by side. First the React version, with state and a filter:

```jsx
import { useState } from 'react';

export function AccountSearch({ accounts }) {
  const [query, setQuery] = useState('');
  const shown = accounts.filter(a => a.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div>
      <input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search accounts" />
      <ul>{shown.map(a => <li key={a.id}>{a.name}</li>)}</ul>
    </div>
  );
}
```

And the LWC version. Notice the differences: a class instead of a function, `@track`-free reactive fields, a separate HTML template, and `for:each` instead of `map`.

```javascript
import { LightningElement, wire } from 'lwc';
import getAccounts from '@salesforce/apex/AccountSearchController.getAccounts';

export default class AccountSearch extends LightningElement {
  query = '';
  @wire(getAccounts) accounts;

  handleChange(event) {
    this.query = event.target.value;
  }

  get shown() {
    const list = this.accounts.data ?? [];
    return list.filter(a => a.Name.toLowerCase().includes(this.query.toLowerCase()));
  }
}
```

```html
<template>
  <lightning-input label="Search accounts" value={query} onchange={handleChange}></lightning-input>
  <ul>
    <template for:each={shown} for:item="a">
      <li key={a.Id}>{a.Name}</li>
    </template>
  </ul>
</template>
```

Both keep the query in state, derive the visible list while rendering and show it. The data source is where they diverge.

## Advanced end-to-end example

The Salesforce side is shared. This Apex class serves the LWC directly, and a tiny backend proxy serves React.

**force-app/main/default/classes/AccountSearchController.cls**

```apex
public with sharing class AccountSearchController {

    @AuraEnabled(cacheable=true)
    public static List<Account> getAccounts() {
        return [SELECT Id, Name, Industry FROM Account WITH USER_MODE ORDER BY Name LIMIT 200];
    }
}
```

**force-app/main/default/classes/AccountSearchControllerTest.cls**

```apex
@IsTest
private class AccountSearchControllerTest {

    @IsTest
    static void returnsAccountsSortedByName() {
        insert new List<Account>{ new Account(Name = 'Zed Ltd'), new Account(Name = 'Alpha Ltd') };
        List<Account> rows = AccountSearchController.getAccounts();
        System.assertEquals('Alpha Ltd', rows[0].Name);
        System.assertEquals(2, rows.size());
    }
}
```

**portal/server.mjs** is the portal's backend. It holds the Salesforce token on the server and returns only the fields the portal needs.

```javascript
import { createServer } from 'node:http';

const instance = process.env.SF_INSTANCE_URL;
const token = process.env.SF_TOKEN;

export function toPortalShape(records) {
  return records.map(r => ({ id: r.Id, name: r.Name, industry: r.Industry ?? null }));
}

createServer(async (req, res) => {
  if (req.method !== 'GET' || !req.url.startsWith('/api/accounts')) {
    res.writeHead(404).end();
    return;
  }
  const soql = 'SELECT Id, Name, Industry FROM Account ORDER BY Name LIMIT 100';
  const sf = await fetch(`${instance}/services/data/v67.0/query?q=${encodeURIComponent(soql)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!sf.ok) {
    res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Upstream failed' }));
    return;
  }
  const data = await sf.json();
  res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(toPortalShape(data.records)));
}).listen(3001);
```

**portal/src/AccountPortal.jsx** is the React page. It loads data, shows loading and error states, and reuses the search component.

```jsx
import { useEffect, useState } from 'react';
import { AccountSearch } from './AccountSearch.jsx';

export function AccountPortal() {
  const [state, setState] = useState({ accounts: [], loading: true, error: null });

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/accounts', { signal: controller.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('Could not load accounts'))))
      .then(accounts => setState({ accounts, loading: false, error: null }))
      .catch(error => {
        if (error.name !== 'AbortError') {
          setState({ accounts: [], loading: false, error: error.message });
        }
      });
    return () => controller.abort();
  }, []);

  if (state.loading) {
    return <p>Loading accounts</p>;
  }
  if (state.error) {
    return <p role="alert">{state.error}</p>;
  }
  return <AccountSearch accounts={state.accounts} />;
}
```

**portal/src/AccountSearch.test.jsx**

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AccountSearch } from './AccountSearch.jsx';

const accounts = [
  { id: '1', name: 'Alpha Ltd' },
  { id: '2', name: 'Beta Holdings' },
  { id: '3', name: 'Alpine Group' }
];

describe('AccountSearch', () => {
  it('shows every account at first', () => {
    render(<AccountSearch accounts={accounts} />);
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('narrows the list as the user types, ignoring case', async () => {
    render(<AccountSearch accounts={accounts} />);
    await userEvent.type(screen.getByPlaceholderText('Search accounts'), 'ALP');
    expect(screen.getAllByRole('listitem').map(li => li.textContent)).toEqual(['Alpha Ltd', 'Alpine Group']);
  });

  it('shows nothing when no account matches', async () => {
    render(<AccountSearch accounts={accounts} />);
    await userEvent.type(screen.getByPlaceholderText('Search accounts'), 'zzz');
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
  });
});
```

The choice itself can be written down as a function, so the rules are visible and testable. This helper was written for this article; it encodes the decision guide above, not a Salesforce rule.

**decide/choose.mjs**

```javascript
export function choose({ usersInSalesforce, publicAudience, ownBrandAndHosting, needsPlatformSecurity, heavyThirdPartyUi }) {
  const reasons = [];
  let lwc = 0;
  let react = 0;

  if (usersInSalesforce) { lwc += 2; reasons.push('Users already live in Salesforce (LWC).'); }
  if (needsPlatformSecurity) { lwc += 2; reasons.push('Platform sharing and field-level security come built in (LWC).'); }
  if (publicAudience) { react += 2; reasons.push('Public audience on your own domain (React).'); }
  if (ownBrandAndHosting) { react += 1; reasons.push('Own branding and hosting (React).'); }
  if (heavyThirdPartyUi) { react += 1; reasons.push('Heavy reuse of third-party UI libraries (React).'); }

  const winner = lwc === react ? 'either, or both' : lwc > react ? 'LWC' : 'React';
  return { winner, lwc, react, reasons };
}
```

**decide/choose.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { choose } from './choose.mjs';

test('a record-page widget for Salesforce users is LWC', () => {
  assert.equal(choose({ usersInSalesforce: true, needsPlatformSecurity: true }).winner, 'LWC');
});

test('a branded public portal is React', () => {
  assert.equal(choose({ publicAudience: true, ownBrandAndHosting: true }).winner, 'React');
});

test('conflicting needs are reported as a tie, not forced', () => {
  const out = choose({ usersInSalesforce: true, publicAudience: true });
  assert.equal(out.winner, 'either, or both');
  assert.equal(out.reasons.length, 2);
});
```

## What happens behind the scenes

In LWC, the framework runs inside the Salesforce page. The `@wire` call goes to Apex through Lightning Data Service, Apex runs in user mode, and Salesforce applies sharing and field permissions before a single row reaches the browser. You wrote no login, no token handling and no CORS settings.

In React on your own domain, none of that exists unless you build it. The browser cannot hold a Salesforce secret, so a backend does the call, and the backend becomes the security boundary: it decides who may see which accounts, and it controls which fields leave. That is a lot of freedom and a lot of responsibility. The shape of the data also changes: Apex returns `Name` and `Industry` as Salesforce names, and your proxy maps them to `name` and `industry`, which keeps Salesforce details out of the front end.

Both frameworks use the same core idea: state changes cause a re-render, and the view is a function of state. That is why skills transfer. The syntax differs (class and template versus function and JSX), but "derive the visible list from the query while rendering" is the same line of thought in both.

## Test it and verify

1. Deploy `AccountSearchController` and its test to a sandbox and run the test.
2. Add the LWC to an app page in App Builder. Type in the search box and confirm the list narrows, as a user with only read access to Account.
3. In the React project run `npm test` and confirm three passing tests, then run `node --test decide`.
4. Start `portal/server.mjs` with `SF_INSTANCE_URL` and `SF_TOKEN` set, run the React app, and confirm the same list appears.
5. Break the token on purpose. Confirm the portal shows "Could not load accounts" instead of crashing.
6. Check the browser network tab for the portal and confirm no Salesforce token is visible.

## Common mistakes and fixes

- **Choosing by fashion.** Choose by where the users are and who must be trusted.
- **Putting Salesforce secrets in a React front end.** Always use a backend.
- **Rebuilding Salesforce security in React by accident.** If you need sharing and field-level security, ask whether LWC is the better home.
- **Forcing LWC onto a public brand site.** If the audience and brand sit outside Salesforce, React is usually simpler.
- **Ignoring newer options.** Multi-Framework and Microfrontends change the trade-offs. Check the current documentation.
- **Duplicating logic in both.** Put shared rules in Apex or an API and keep both UIs thin.

## Key takeaways

- LWC lives inside Salesforce and inherits its security and navigation; React lives anywhere and you secure it yourself.
- The same state-driven thinking applies to both, so skills transfer.
- Choose by user location, audience, branding and security needs.
- With React, a backend is your security boundary.
- Check Multi-Framework and Microfrontends for newer hosting options.

## Where to go next

- Read [React from zero](/articles/react-fundamentals-zero-to-hero/) to learn the React side.
- Read [LWC lifecycle and the wire service](/articles/lwc-lifecycle-and-wire/) to learn the LWC side.
- Read [Choosing between LWC, Multi-Framework and Microfrontends](/articles/choosing-lwc-multiframework-microfrontends/) for the newer hosting options.
