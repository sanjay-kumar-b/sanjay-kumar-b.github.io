---
title: "Multi-Framework Data SDK, Metadata and Deployment Explained"
description: "Query and mutate Salesforce data from React with the Data SDK through a testable data layer, define UIBundle metadata, deploy and grant access."
category: react-and-salesforce
tags: [Multi-Framework, React, Data SDK, GraphQL, Advanced]
publishedAt: 2026-11-12
updatedAt: 2026-11-16
cover: /images/covers/multi-framework-data-sdk-and-deployment.jpg
sources:
  - title: "Build with React on Salesforce: Multi-Framework Is Now GA"
    url: "https://developer.salesforce.com/blogs/2026/07/build-with-react-on-salesforce-multi-framework-is-now-ga"
  - title: "Salesforce Multi-Framework Overview"
    url: "https://developer.salesforce.com/docs/platform/multiframework/guide/multiframework-overview.html"
  - title: "What's New in Salesforce Multi-Framework (Winter '27)"
    url: "https://developer.salesforce.com/blogs/2026/10/whats-new-in-salesforce-multi-framework-angular-is-now-ga"
---

> The sources available when this article was written confirm the package and method names below but not complete API signatures. The SDK call shapes in this article are illustrative. The data layer, metadata files and tests are written so that only one small file touches the SDK, which you adapt from the official guide.

A Multi-Framework app is a React (or Angular) app that Salesforce hosts. This article covers the three things you need beyond the UI: reading and writing data with the Data SDK, describing the app as metadata, and deploying it so users can open it.

## The business scenario

Juniper Consulting is building an internal "Account Pulse" app for account managers. It lists accounts the user can see, shows the rating, lets the manager change the rating, and must respect the same object, field and sharing rules as the rest of Salesforce. The team wants to be able to change SDK versions without rewriting every screen, and wants tests that run without a Salesforce org.

## Before you start: setup

### In Salesforce

1. Use a **Developer Edition org or scratch org on Hyperforce, on Summer '26 or later**. Sandboxes and production work with the same requirement.
2. In Setup, find the Multi-Framework (React Development) settings and enable the **Salesforce App Domain** toggle. The exact label may change, so follow the current guide.
3. Install the **Salesforce CLI** and sign in: `sf org login web --alias dev`.
4. Create a **permission set** (for example `Account_Pulse_User`) that gives read and edit access to Account and its Rating field, and later gives visibility of the application. Assign it to your user.
5. Add a few Accounts with different ratings so you have data to see.

### In the external system

There is no external system for a hosted app. On your computer you need **Node 20 or newer**, an editor, and a Git repository. Scaffold the project from a template with the CLI as described in the Get Started page (see the getting-started article for the path), then add the files below to its `src` folder.

## How it works

At GA, the SDK package is **`@salesforce/platform-sdk`** (renamed from `@salesforce/sdk-data` in beta). It reaches Salesforce data through **GraphQL**. The documented GA changes:

- Reads use **`.query()`** and writes use **`.mutate()`**; the single beta `graphql()` call was split.
- `result.data` **may be undefined**, so use optional chaining.
- Angular uses the same Data SDK GraphQL operations as React.
- A labels extension retrieves custom labels, and `@salesforce/platform-sdk/i18n` provides helpers for locale-aware formatting.

The platform enforces object, field and sharing rules on every request, so hiding a button is never security.

The app is metadata: a **UIBundle**, a **Custom Application** that references it, and a **Permission Set** that makes the app visible. You deploy with Salesforce DX, **publish a version**, assign the permission set and open the app from the App Launcher.

## Basic example

The simplest read, in the shape the documentation describes (adapt the client acquisition to the guide):

```tsx
import { useEffect, useState } from 'react';

type Row = { Id: string; Name: { value: string } };

export function AccountList({ sdk }: { sdk: { query: (q: string) => Promise<any> } }) {
  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    let alive = true;
    (async () => {
      const result = await sdk.query(`
        query { uiapi { query { Account(first: 10) { edges { node { Id Name { value } } } } } } }
      `);
      const edges = result?.data?.uiapi?.query?.Account?.edges ?? [];
      if (alive) setRows(edges.map((e: any) => e.node));
    })();
    return () => { alive = false; };
  }, [sdk]);

  return <ul>{rows.map(r => <li key={r.Id}>{r.Name.value}</li>)}</ul>;
}
```

It works, but the query text, the response shape and the SDK are all inside the component. That is hard to test and hard to change.

## Advanced end-to-end example

We isolate everything about Salesforce in one data layer, and keep the components simple.

**src/data/client.ts** is the **only** file that imports the SDK. Replace the body with the client the official guide shows you how to obtain.

```typescript
export interface GraphQlClient {
  query(document: string, variables?: Record<string, unknown>): Promise<{ data?: any; errors?: { message: string }[] } | undefined>;
  mutate(document: string, variables?: Record<string, unknown>): Promise<{ data?: any; errors?: { message: string }[] } | undefined>;
}

let current: GraphQlClient | null = null;

export function setClient(client: GraphQlClient): void {
  current = client;
}

export function getClient(): GraphQlClient {
  if (current === null) {
    throw new Error('Data client not configured. Call setClient() at startup.');
  }
  return current;
}
```

**src/data/accounts.ts** holds queries, mapping and error handling.

```typescript
import { getClient } from './client';

export type Rating = 'Hot' | 'Warm' | 'Cold';

export interface AccountRow {
  id: string;
  name: string;
  rating: Rating | null;
}

export class DataError extends Error {}

const LIST = `
  query Accounts($first: Int!) {
    uiapi { query { Account(first: $first, orderBy: { Name: { order: ASC } }) {
      edges { node { Id Name { value } Rating { value } } }
    } } }
  }`;

const UPDATE = `
  mutation SetRating($id: ID!, $rating: PicklistValue) {
    uiapi { AccountUpdate(input: { Id: $id, Account: { Rating: $rating } }) {
      Record { Id Rating { value } }
    } }
  }`;

function failOnErrors(result: { errors?: { message: string }[] } | undefined): void {
  if (result?.errors && result.errors.length > 0) {
    throw new DataError(result.errors.map(e => e.message).join('; '));
  }
}

export async function listAccounts(first = 20): Promise<AccountRow[]> {
  const result = await getClient().query(LIST, { first });
  failOnErrors(result);
  const edges = result?.data?.uiapi?.query?.Account?.edges ?? [];
  return edges.map((e: any) => ({
    id: e.node.Id,
    name: e.node.Name?.value ?? '(no name)',
    rating: e.node.Rating?.value ?? null
  }));
}

export async function setRating(id: string, rating: Rating): Promise<Rating | null> {
  const result = await getClient().mutate(UPDATE, { id, rating });
  failOnErrors(result);
  return result?.data?.uiapi?.AccountUpdate?.Record?.Rating?.value ?? null;
}
```

The GraphQL field names above follow the common Salesforce GraphQL shape (`uiapi`, `edges`, `node`, `value`). Confirm each name against the current schema for your org before relying on it.

**src/AccountPulse.tsx**

```tsx
import { useCallback, useEffect, useState } from 'react';
import { listAccounts, setRating, type AccountRow, type Rating } from './data/accounts';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; rows: AccountRow[] };

export default function AccountPulse() {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    listAccounts()
      .then(rows => alive && setState({ status: 'ready', rows }))
      .catch(e => alive && setState({ status: 'error', message: String(e.message ?? e) }));
    return () => { alive = false; };
  }, []);

  const change = useCallback(async (id: string, rating: Rating) => {
    setSaveError(null);
    try {
      const saved = await setRating(id, rating);
      setState(s => s.status === 'ready'
        ? { status: 'ready', rows: s.rows.map(r => (r.id === id ? { ...r, rating: saved } : r)) }
        : s);
    } catch (e: any) {
      // Permission-denied and validation errors from the platform land here.
      setSaveError(String(e.message ?? e));
    }
  }, []);

  if (state.status === 'loading') return <p>Loading accounts...</p>;
  if (state.status === 'error') return <p role="alert">Could not load accounts: {state.message}</p>;
  if (state.rows.length === 0) return <p>No accounts to show.</p>;

  return (
    <main>
      <h1>Account Pulse</h1>
      {saveError && <p role="alert">Could not save: {saveError}</p>}
      <ul>
        {state.rows.map(r => (
          <li key={r.id}>
            {r.name}{' '}
            <select
              aria-label={`Rating for ${r.name}`}
              value={r.rating ?? ''}
              onChange={e => change(r.id, e.target.value as Rating)}
            >
              <option value="" disabled>Choose</option>
              <option>Hot</option>
              <option>Warm</option>
              <option>Cold</option>
            </select>
          </li>
        ))}
      </ul>
    </main>
  );
}
```

**src/AccountPulse.test.tsx** uses a fake client, so no org is needed.

```tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountPulse from './AccountPulse';
import { setClient, type GraphQlClient } from './data/client';
import { listAccounts } from './data/accounts';

const edges = [
  { node: { Id: '001A', Name: { value: 'Acme' }, Rating: { value: 'Hot' } } },
  { node: { Id: '001B', Name: null, Rating: null } }
];

function fake(overrides: Partial<GraphQlClient> = {}): GraphQlClient {
  return {
    query: vi.fn().mockResolvedValue({ data: { uiapi: { query: { Account: { edges } } } } }),
    mutate: vi.fn().mockResolvedValue({
      data: { uiapi: { AccountUpdate: { Record: { Id: '001A', Rating: { value: 'Cold' } } } } }
    }),
    ...overrides
  };
}

describe('data layer', () => {
  it('maps edges to rows and tolerates missing values', async () => {
    setClient(fake());
    const rows = await listAccounts();
    expect(rows).toEqual([
      { id: '001A', name: 'Acme', rating: 'Hot' },
      { id: '001B', name: '(no name)', rating: null }
    ]);
  });

  it('treats an undefined result as an empty list', async () => {
    setClient(fake({ query: vi.fn().mockResolvedValue(undefined) }));
    expect(await listAccounts()).toEqual([]);
  });

  it('turns GraphQL errors into a DataError', async () => {
    setClient(fake({ query: vi.fn().mockResolvedValue({ errors: [{ message: 'No access' }] }) }));
    await expect(listAccounts()).rejects.toThrow('No access');
  });
});

describe('AccountPulse', () => {
  beforeEach(() => setClient(fake()));

  it('lists accounts', async () => {
    render(<AccountPulse />);
    expect(await screen.findByText(/Acme/)).toBeInTheDocument();
  });

  it('shows an error when loading fails', async () => {
    setClient(fake({ query: vi.fn().mockResolvedValue({ errors: [{ message: 'Denied' }] }) }));
    render(<AccountPulse />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Denied');
  });

  it('saves a new rating and shows it', async () => {
    render(<AccountPulse />);
    await userEvent.selectOptions(await screen.findByLabelText('Rating for Acme'), 'Cold');
    expect(await screen.findByDisplayValue('Cold')).toBeInTheDocument();
  });

  it('shows a save error from the platform', async () => {
    setClient(fake({ mutate: vi.fn().mockResolvedValue({ errors: [{ message: 'Insufficient access' }] }) }));
    render(<AccountPulse />);
    await userEvent.selectOptions(await screen.findByLabelText('Rating for Acme'), 'Warm');
    expect(await screen.findByRole('alert')).toHaveTextContent('Insufficient access');
  });
});
```

**force-app/main/default/uiBundles/accountPulse/accountPulse.uibundle-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<UIBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <target>CustomApplication</target>
    <!-- Add the other required elements listed in the official guide. -->
</UIBundle>
```

**force-app/main/default/applications/Account_Pulse.app-meta.xml** (shape per the guide; confirm the elements)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomApplication xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Account Pulse</label>
    <uiBundle>accountPulse</uiBundle>
</CustomApplication>
```

**force-app/main/default/permissionsets/Account_Pulse_User.permissionset-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Account Pulse User</label>
    <applicationVisibilities>
        <application>Account_Pulse</application>
        <visible>true</visible>
    </applicationVisibilities>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Account</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Account.Rating</field>
        <readable>true</readable>
    </fieldPermissions>
</PermissionSet>
```

Deploy and verify:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf org assign permset --name Account_Pulse_User --target-org dev
sf org open --target-org dev
```

Then **publish a version** of the UIBundle as the Deploy and Publish a UIBundle page describes, and open Account Pulse from the App Launcher.

## What happens behind the scenes

The browser loads your built React app from the Salesforce-hosted `salesforce.app` domain. Each app is on its own origin, so the browser's same-origin policy isolates one app from another. When the app calls the Data SDK, the SDK sends a GraphQL request to Salesforce as the signed-in user. Salesforce checks object permission, field-level security and sharing for that user, then returns only the allowed records and fields. Fields the user cannot see come back missing or as errors, which is why the mapping code tolerates `null` and the layer raises `DataError` for `errors`.

Splitting the single beta `graphql()` call into `.query()` and `.mutate()` makes the intent explicit: a query never changes data, and a mutation does. The result's `data` can be undefined, for example when only errors came back, so the data layer defaults every step with `?.` and `??`.

Deployment turns your project into org metadata. The UIBundle holds the built app, the Custom Application gives it an App Launcher entry that points at the bundle, and the permission set decides who can see that entry. Publishing a version makes the deployed bundle the one users receive.

Putting the SDK behind `client.ts` pays off twice. In production you register the real client at startup. In tests you register a fake, so the tests exercise your mapping, error handling and screens with no network.

## Test it and verify

1. Run `npx vitest run` and confirm that all seven tests pass.
2. Run the app locally as the quick start describes and confirm accounts load.
3. Remove Account read access from your permission set in a sandbox, reload, and confirm you see the error message rather than a blank page.
4. Remove edit access to the Rating field and confirm the save error appears.
5. Deploy, publish, assign the permission set and open the app from the App Launcher as a second, non-admin user.
6. If anything differs from the guide, change only `client.ts`, `accounts.ts` and the metadata.

## Common mistakes and fixes

- **Forgetting optional chaining on `result.data`.** It may be undefined.
- **Using the beta package name or `graphql()`.** Import from `@salesforce/platform-sdk` and use `.query()` and `.mutate()`.
- **Hiding a button and calling it security.** The platform enforces access; your UI should only reflect it.
- **No permission set.** The app deploys but no one sees it in the App Launcher.
- **Keeping the deprecated `AppLauncher` target.** Use `CustomApplication` with Custom Application and Permission Set metadata.
- **Scattering SDK calls through components.** Centralise them in one data layer.
- **Large queries.** Keep GraphQL queries small and field-specific.

## Migrating beta code to GA

1. Import from `@salesforce/platform-sdk`.
2. Split `graphql()` into `.query()` and `.mutate()`.
3. Optional-chain `result?.data`.
4. Replace the `AppLauncher` target with `CustomApplication`, and add Custom Application and Permission Set metadata.
5. Remove the deprecated `UiBundleSettings` scratch configuration.

## Key takeaways

- One package, `@salesforce/platform-sdk`; queries read, mutations write.
- Isolate the SDK in a single file so changes stay small.
- The platform enforces permissions; show clear errors when it says no.
- A UIBundle, Custom Application and Permission Set make a deployable app.
- Fake the client in tests, and test loading, empty, error and denied states.

## Where to go next

- Read [Getting started with Salesforce Multi-Framework](/articles/salesforce-multi-framework-getting-started/) for the project setup.
- Read [Choosing between LWC, Multi-Framework and Microfrontends](/articles/choosing-lwc-multiframework-microfrontends/) for the decision guide.
- Read [React with TypeScript and testing](/articles/react-typescript-and-testing/) for the testing approach.
