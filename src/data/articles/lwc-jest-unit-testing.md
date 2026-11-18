---
title: "LWC Jest Unit Testing: Mock Apex, Wire Adapters, Events and Child Components"
description: "Unit test Lightning web components with Jest: setup, mocking Apex and wire adapters, testing events and async rendering, and running tests in CI."
category: salesforce-development
tags: [LWC, Jest, Testing, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Test Lightning Web Components (Jest)"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/testing.html"
  - title: "sfdx-lwc-jest"
    url: "https://github.com/salesforce/sfdx-lwc-jest"
---

Components that are not tested get afraid of change. Jest tests run in seconds on your computer, with no org, so you can check behaviour on every save and on every pull request. This article shows the setup, the core patterns and a full example that mocks Apex, a wire adapter, events and a child component.

> Jest and `@salesforce/sfdx-lwc-jest` change over time. The patterns below follow the documented approach (`createElement`, `jest.mock` with the `virtual` option, test wire adapters); confirm the helper names against the version installed in your project.

## The business scenario

Juniper Consulting has an `accountPicker` component. It loads accounts from Apex, filters them as the user types, shows an empty message, tells the parent which account was chosen through a custom event, and shows an error when Apex fails. It has been broken twice by small changes. The team wants tests that pin down each behaviour, run in CI, and fail loudly when someone breaks it.

## Before you start: setup

### In Salesforce

Unit tests do not need an org, but the project must be a Salesforce DX project:

1. Create it with `sf project generate --name picker-tests`. The generated `package.json` includes the LWC Jest scripts.
2. Create the Apex class the component imports, so deployments succeed (code below). Deploy it to a sandbox or scratch org: `sf project deploy start --source-dir force-app --target-org dev`.
3. In the org, assign the permission set that gives read access to Account, so the manual check at the end works.

### In the external system

On your computer or CI runner:

1. Install Node 20 or newer.
2. Install dependencies: `npm install`. If tooling is missing, run `npm install --save-dev @salesforce/sfdx-lwc-jest`.
3. Make sure `package.json` has these scripts:

```json
{
  "scripts": {
    "test:unit": "sfdx-lwc-jest",
    "test:unit:watch": "sfdx-lwc-jest --watch",
    "test:unit:coverage": "sfdx-lwc-jest --coverage"
  }
}
```

4. Check `jest.config.js`: it normally extends the Salesforce preset.

```javascript
const { jestConfig } = require('@salesforce/sfdx-lwc-jest/config');

module.exports = {
  ...jestConfig,
  modulePathIgnorePatterns: ['<rootDir>/.localdevserver'],
  coverageThreshold: {
    global: { statements: 80, branches: 70, functions: 80, lines: 80 }
  }
};
```

## How it works

Jest runs JavaScript in a simulated browser (jsdom). `@salesforce/sfdx-lwc-jest` adds a transformer that compiles LWC, and **stubs** for Salesforce modules such as `lightning/uiRecordApi`, `@salesforce/apex/...` and base components like `lightning-button`.

The core steps of every test:

1. **Create** the element: `createElement('c-account-picker', { is: AccountPicker })`.
2. **Set** public properties (`@api`) before appending.
3. **Append** it to `document.body`. This runs `connectedCallback` and renders.
4. **Act**: click, dispatch events, emit data on wire adapters.
5. **Wait** a microtask: `await Promise.resolve()`, because LWC re-renders asynchronously.
6. **Assert** against `element.shadowRoot`, calls on mocks and fired events.
7. **Clean up** in `afterEach`: remove elements and clear mocks.

Mocking:

- **Imperative Apex**: `jest.mock('@salesforce/apex/Class.method', () => ({ default: jest.fn() }), { virtual: true })`, then set `mockResolvedValue` or `mockRejectedValue`.
- **Wired Apex or LDS**: register a **test wire adapter** and call `.emit(data)` or `.error()` on it.
- **Events**: add a listener with `jest.fn()` and assert on `mock.calls[0][0].detail`.

## Basic example

A component and the smallest test.

```javascript
// force-app/main/default/lwc/hello/hello.js
import { LightningElement, api } from 'lwc';

export default class Hello extends LightningElement {
  @api name = 'world';
}
```

```javascript
// force-app/main/default/lwc/hello/__tests__/hello.test.js
import { createElement } from 'lwc';
import Hello from 'c/hello';

describe('c-hello', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
  });

  it('renders the name it receives', async () => {
    const element = createElement('c-hello', { is: Hello });
    element.name = 'Asha';
    document.body.appendChild(element);
    await Promise.resolve();
    expect(element.shadowRoot.textContent).toContain('Asha');
  });
});
```

## Advanced end-to-end example

**force-app/main/default/classes/AccountPickerController.cls**

```apex
public with sharing class AccountPickerController {
    @AuraEnabled(cacheable=true)
    public static List<Account> findAccounts(String term) {
        String pattern = '%' + String.escapeSingleQuotes(String.isBlank(term) ? '' : term.trim()) + '%';
        return [
            SELECT Id, Name, Industry
            FROM Account
            WHERE Name LIKE :pattern
            WITH USER_MODE
            ORDER BY Name
            LIMIT 25
        ];
    }
}
```

**force-app/main/default/lwc/accountPicker/accountPicker.js**

```javascript
import { LightningElement } from 'lwc';
import findAccounts from '@salesforce/apex/AccountPickerController.findAccounts';

export default class AccountPicker extends LightningElement {
  term = '';
  accounts = [];
  error = '';
  loading = false;

  async connectedCallback() {
    await this.load();
  }

  async load() {
    this.loading = true;
    this.error = '';
    try {
      this.accounts = await findAccounts({ term: this.term });
    } catch (e) {
      this.accounts = [];
      this.error = e?.body?.message ?? 'Could not load accounts.';
    } finally {
      this.loading = false;
    }
  }

  handleInput(event) {
    this.term = event.target.value;
    this.load();
  }

  handleSelect(event) {
    const id = event.currentTarget.dataset.id;
    const account = this.accounts.find(a => a.Id === id);
    this.dispatchEvent(new CustomEvent('select', {
      detail: { id, name: account?.Name }
    }));
  }

  get hasAccounts() {
    return this.accounts.length > 0;
  }

  get showEmpty() {
    return !this.loading && !this.error && this.accounts.length === 0;
  }
}
```

**force-app/main/default/lwc/accountPicker/accountPicker.html**

```html
<template>
  <lightning-input type="search" label="Find account" value={term} oninput={handleInput}></lightning-input>

  <template lwc:if={loading}>
    <p class="status">Loading...</p>
  </template>
  <template lwc:if={error}>
    <p class="error" role="alert">{error}</p>
  </template>
  <template lwc:if={showEmpty}>
    <p class="empty">No accounts found.</p>
  </template>

  <ul lwc:if={hasAccounts}>
    <template for:each={accounts} for:item="account">
      <li key={account.Id}>
        <a href="#" data-id={account.Id} onclick={handleSelect}>{account.Name}</a>
      </li>
    </template>
  </ul>
</template>
```

**force-app/main/default/lwc/accountPicker/__tests__/accountPicker.test.js**

```javascript
import { createElement } from 'lwc';
import AccountPicker from 'c/accountPicker';
import findAccounts from '@salesforce/apex/AccountPickerController.findAccounts';

jest.mock(
  '@salesforce/apex/AccountPickerController.findAccounts',
  () => ({ default: jest.fn() }),
  { virtual: true }
);

const ACCOUNTS = [
  { Id: '001000000000001AAA', Name: 'Acme Ltd' },
  { Id: '001000000000002AAA', Name: 'Birch Bank' }
];

// Lets pending promises (the Apex call and the re-render) finish.
async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function mount() {
  const element = createElement('c-account-picker', { is: AccountPicker });
  document.body.appendChild(element);
  return element;
}

describe('c-account-picker', () => {
  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
  });

  it('loads and lists accounts when it is added to the page', async () => {
    findAccounts.mockResolvedValue(ACCOUNTS);
    const element = mount();
    await settle();

    const links = element.shadowRoot.querySelectorAll('li a');
    expect(links).toHaveLength(2);
    expect(links[0].textContent).toBe('Acme Ltd');
    expect(findAccounts).toHaveBeenCalledWith({ term: '' });
  });

  it('searches again with the typed text', async () => {
    findAccounts.mockResolvedValue(ACCOUNTS);
    const element = mount();
    await settle();

    const input = element.shadowRoot.querySelector('lightning-input');
    input.value = 'bir';
    input.dispatchEvent(new CustomEvent('input'));
    await settle();

    expect(findAccounts).toHaveBeenLastCalledWith({ term: 'bir' });
  });

  it('shows an empty message when nothing matches', async () => {
    findAccounts.mockResolvedValue([]);
    const element = mount();
    await settle();

    expect(element.shadowRoot.querySelector('.empty').textContent).toBe('No accounts found.');
    expect(element.shadowRoot.querySelector('ul')).toBeNull();
  });

  it('shows the error message when Apex fails', async () => {
    findAccounts.mockRejectedValue({ body: { message: 'No access to Account' } });
    const element = mount();
    await settle();

    expect(element.shadowRoot.querySelector('[role="alert"]').textContent).toBe('No access to Account');
    expect(element.shadowRoot.querySelector('.empty')).toBeNull();
  });

  it('fires a select event with the account id and name', async () => {
    findAccounts.mockResolvedValue(ACCOUNTS);
    const element = mount();
    const handler = jest.fn();
    element.addEventListener('select', handler);
    await settle();

    element.shadowRoot.querySelectorAll('li a')[1].click();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({
      id: '001000000000002AAA',
      name: 'Birch Bank'
    });
  });
});
```

For wired adapters (for example `getRecord`), use the test adapters. The shape is:

```javascript
import { createElement } from 'lwc';
import RecordBadge from 'c/recordBadge';
import { getRecord } from 'lightning/uiRecordApi';

// Replaces the real adapter with one you can drive from the test.
jest.mock('lightning/uiRecordApi', () => {
  const { createLdsTestWireAdapter } = require('@salesforce/sfdx-lwc-jest');
  return { getRecord: createLdsTestWireAdapter(jest.fn()) };
}, { virtual: true });

it('shows the account name the wire emits', async () => {
  const element = createElement('c-record-badge', { is: RecordBadge });
  document.body.appendChild(element);

  getRecord.emit({ fields: { Name: { value: 'Acme Ltd' } } });
  await Promise.resolve();

  expect(element.shadowRoot.textContent).toContain('Acme Ltd');
});
```

Run the tests and a coverage report, then a CI job:

```bash
npm run test:unit
npm run test:unit:coverage
```

```yaml
name: lwc-tests
on:
  pull_request:
  push:
    branches: [main]
jobs:
  jest:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run test:unit:coverage
```

## What happens behind the scenes

Jest does not run a browser. It runs your tests in Node with a simulated DOM. The Salesforce preset compiles LWC modules and wires up a resolver: when your component imports `@salesforce/apex/AccountPickerController.findAccounts`, there is no Apex in the test, so the preset can only give you a stub. The `jest.mock(..., { virtual: true })` call replaces the module before the component loads, and virtual means "this module does not exist on disk, create it". Your `jest.fn()` then becomes the function the component calls. That is why you set its resolved value inside each test.

Rendering is **asynchronous** in LWC. When `connectedCallback` awaits the Apex call, and then assigns `this.accounts`, the framework schedules a re-render in a microtask. Calling `await Promise.resolve()` yields to the microtask queue so the pending work can finish. The helper `settle()` yields a few times because there are chained promises: the mock resolves, the `await` continues, and the render runs. If an assertion fails only sometimes, you usually need another yield, not a longer timeout.

Base components such as `lightning-input` are replaced with **stubs**: simple custom elements. They do not behave like the real component, so you dispatch their events manually (`new CustomEvent('input')`) and set their `value` property directly. That is a deliberate trade: it keeps tests fast and independent of Salesforce's UI library, at the cost of not testing how the base component works internally.

Wire adapters work through a test double. The component declares `@wire(getRecord, ...)`; in the test, `getRecord` is an adapter object with an `emit` method, which pushes data into the component exactly as the real adapter would after loading a record. You can also call `error()` on it to test failure handling.

Shadow DOM matters for queries. Tests use `element.shadowRoot.querySelector`, because the component's markup is hidden from the outer document. Child components' internals are hidden one level deeper, so assert on child **properties and events** rather than their rendered text.

## Test it and verify

1. Run `npm run test:unit` and confirm all five tests pass.
2. Break the component on purpose, for example remove `this.error = ''`, and confirm a test fails with a clear message. Restore it.
3. Run the coverage command and open the report. Aim for the thresholds in `jest.config.js`.
4. Push to a branch and confirm that the CI job runs the same tests.
5. Deploy the component, add it to a page, and compare the live behaviour with the test descriptions. Jest does not replace a manual smoke test of the real page.

## Common mistakes and fixes

- **Forgetting to await after changes.** Re-rendering is asynchronous; yield before asserting.
- **Not cleaning up the DOM.** Remove elements in `afterEach`, or one test affects the next.
- **Not clearing mocks.** Use `jest.clearAllMocks()` so call counts reset.
- **Forgetting `{ virtual: true }`.** Salesforce modules do not exist as files.
- **Asserting a child component's inner text.** Test its properties and events.
- **Testing implementation details,** like private fields. Test what the user sees and what the component emits.
- **Skipping error paths.** Mock a rejection and assert the message.
- **Relying on Jest for security.** It tests UI logic; Apex tests and permission tests are separate.

## Key takeaways

- Jest tests run locally and in CI without an org.
- Create, append, act, wait, assert, clean up.
- Mock Apex with `jest.mock` and drive wires with test adapters.
- Base components are stubs, so dispatch their events yourself.
- Cover the loading, empty, error and event paths.

## Where to go next

- Read [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/) to understand what you are asserting.
- Read [LWC forms and the UI API](/articles/lwc-forms-and-ui-api/) for the forms tested the same way.
- Read [GitHub Actions for Salesforce CI](/articles/github-actions-salesforce-ci/) for team pipelines.
