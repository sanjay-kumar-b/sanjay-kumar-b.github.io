---
title: "Lightning Web Components: Lifecycle Hooks and the Wire Service"
description: "Learn when each LWC hook runs, how @wire and imperative Apex differ, and build a tested record-page component with cleanup and error handling."
category: salesforce-development
tags: [LWC, JavaScript, Wire]
publishedAt: 2026-10-25
updatedAt: 2026-11-15
cover: /images/covers/lwc-lifecycle-and-wire.jpg
sources:
  - title: "Lightning Web Components Developer Guide"
    url: "https://developer.salesforce.com/docs/platform/lwc/overview"
  - title: "Jest tests for Lightning Web Components (sfdx-lwc-jest)"
    url: "https://github.com/salesforce/sfdx-lwc-jest"
---

Lightning Web Components (LWC) are built on standard web component APIs. Knowing the lifecycle, and knowing when to read data with `@wire` and when to call Apex yourself, saves hours of debugging. This article explains each hook, then builds a complete record-page component with cleanup, error handling and unit tests.

## The business scenario

Birchwood Credit (a fictional lender) wants an **Account Health Card** on the Account record page. It shows the account's name and rating, refreshes the open-case count every minute while the page is visible, lets an agent press a button to load their latest cases, shows a friendly message on failure, and must not leave timers running after the agent navigates away.

## Before you start: setup

### In Salesforce

1. Install the Salesforce CLI and create a scratch org or use a sandbox with **My Domain** deployed. Components cannot be added to pages without it.
2. Make sure Account has the `Rating` field visible to your test user, and create a few Cases linked to test accounts.
3. Create a permission set that gives your users access to the Apex class `AccountHealthController`.
4. After deploying, open an Account record, click the gear icon, choose **Edit Page**, and drag **Account Health Card** onto the page. Save and activate it.

### In the external system

There is no external system for this example. For local testing install Node 20 or newer and run `npm install` in your project, which brings in `@salesforce/sfdx-lwc-jest` for the unit tests.

## How it works

The hooks run in a fixed order:

1. **`constructor()`**: the component is created. Call `super()` first. Do not read attributes or children here.
2. **`connectedCallback()`**: the component is inserted into the DOM. Good for subscribing and starting work. It can run more than once if the element is moved.
3. **`renderedCallback()`**: after every render. Guard it, because changing state here can cause loops.
4. **`disconnectedCallback()`**: removed from the DOM. Clean up listeners, timers and subscriptions.
5. **`errorCallback(error, stack)`**: catches errors thrown by child components, so it lives in a parent.

For data there are two tools:

- **`@wire`** is declarative and reactive. When a reactive parameter (prefixed with `$`) changes, data is provisioned again. It is the right choice for reading.
- **Imperative Apex** gives you control over timing, such as on a click or when writing data. Apex methods used with `@wire` must be `cacheable=true`, which means they cannot modify data.

## Basic example

```javascript
import { LightningElement, wire, api } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import NAME from '@salesforce/schema/Account.Name';

export default class AccountName extends LightningElement {
  @api recordId;

  @wire(getRecord, { recordId: '$recordId', fields: [NAME] })
  account;

  get name() {
    return getFieldValue(this.account.data, NAME);
  }
}
```

The template just uses `{name}`. When `recordId` changes, the wire runs again by itself. It needs no lifecycle code. The advanced example adds the hooks.

## Advanced end-to-end example

**force-app/main/default/classes/AccountHealthController.cls**

```apex
public with sharing class AccountHealthController {

    @AuraEnabled(cacheable=false)
    public static Integer openCaseCount(Id accountId) {
        return [
            SELECT COUNT() FROM Case
            WHERE AccountId = :accountId AND IsClosed = false
            WITH USER_MODE
        ];
    }

    @AuraEnabled
    public static List<Case> latestCases(Id accountId) {
        return [
            SELECT Id, CaseNumber, Subject, Status
            FROM Case
            WHERE AccountId = :accountId
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 5
        ];
    }
}
```

**force-app/main/default/classes/AccountHealthControllerTest.cls**

```apex
@IsTest
private class AccountHealthControllerTest {

    @TestSetup
    static void setup() {
        Account a = new Account(Name = 'Birch Test');
        insert a;
        insert new List<Case>{
            new Case(AccountId = a.Id, Subject = 'One', Status = 'New'),
            new Case(AccountId = a.Id, Subject = 'Two', Status = 'New')
        };
    }

    @IsTest
    static void countsOpenCases() {
        Account a = [SELECT Id FROM Account LIMIT 1];
        System.assertEquals(2, AccountHealthController.openCaseCount(a.Id));
    }

    @IsTest
    static void returnsLatestCases() {
        Account a = [SELECT Id FROM Account LIMIT 1];
        System.assertEquals(2, AccountHealthController.latestCases(a.Id).size());
    }
}
```

**force-app/main/default/lwc/accountHealthCard/accountHealthCard.js**

```javascript
import { LightningElement, api, wire } from 'lwc';
import { getRecord, getFieldValue } from 'lightning/uiRecordApi';
import NAME from '@salesforce/schema/Account.Name';
import RATING from '@salesforce/schema/Account.Rating';
import openCaseCount from '@salesforce/apex/AccountHealthController.openCaseCount';
import latestCases from '@salesforce/apex/AccountHealthController.latestCases';

const REFRESH_MS = 60000;

export default class AccountHealthCard extends LightningElement {
  @api recordId;

  openCases;
  cases = [];
  errorMessage;
  loadingCases = false;
  focused = false;
  timerId;

  @wire(getRecord, { recordId: '$recordId', fields: [NAME, RATING] })
  account;

  get name() {
    return getFieldValue(this.account.data, NAME);
  }

  get rating() {
    return getFieldValue(this.account.data, RATING) || 'Not rated';
  }

  get wireError() {
    return this.account.error ? this.reduceError(this.account.error) : undefined;
  }

  get hasCases() {
    return this.cases.length > 0;
  }

  connectedCallback() {
    // May run more than once, so never start a second timer.
    this.stopTimer();
    this.refreshCount();
    this.timerId = setInterval(() => this.refreshCount(), REFRESH_MS);
  }

  renderedCallback() {
    // Runs after every render: guard one-time DOM work.
    if (this.focused) {
      return;
    }
    const heading = this.template.querySelector('h2');
    if (heading) {
      heading.setAttribute('tabindex', '-1');
      this.focused = true;
    }
  }

  disconnectedCallback() {
    this.stopTimer();
  }

  stopTimer() {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = undefined;
    }
  }

  async refreshCount() {
    if (!this.recordId) {
      return;
    }
    try {
      this.openCases = await openCaseCount({ accountId: this.recordId });
    } catch (error) {
      this.errorMessage = this.reduceError(error);
    }
  }

  async handleLoadCases() {
    this.loadingCases = true;
    this.errorMessage = undefined;
    try {
      this.cases = await latestCases({ accountId: this.recordId });
    } catch (error) {
      this.cases = [];
      this.errorMessage = this.reduceError(error);
    } finally {
      this.loadingCases = false;
    }
  }

  reduceError(error) {
    if (Array.isArray(error?.body)) {
      return error.body.map(e => e.message).join(', ');
    }
    return error?.body?.message || error?.message || 'Unknown error';
  }
}
```

**force-app/main/default/lwc/accountHealthCard/accountHealthCard.html**

```html
<template>
  <lightning-card title="Account health" icon-name="standard:account">
    <div class="slds-p-horizontal_medium">
      <template lwc:if={wireError}>
        <p class="slds-text-color_error" role="alert">{wireError}</p>
      </template>
      <template lwc:elseif={account.data}>
        <h2 class="slds-text-heading_small">{name}</h2>
        <p>Rating: {rating}</p>
        <p>Open cases: {openCases}</p>
        <lightning-button label="Load latest cases" onclick={handleLoadCases} disabled={loadingCases}></lightning-button>
        <template lwc:if={loadingCases}>
          <lightning-spinner alternative-text="Loading cases" size="small"></lightning-spinner>
        </template>
        <template lwc:if={hasCases}>
          <ul class="slds-m-top_small">
            <template for:each={cases} for:item="c">
              <li key={c.Id}>{c.CaseNumber}: {c.Subject} ({c.Status})</li>
            </template>
          </ul>
        </template>
      </template>
      <template lwc:else>
        <lightning-spinner alternative-text="Loading" size="small"></lightning-spinner>
      </template>
      <template lwc:if={errorMessage}>
        <p class="slds-text-color_error" role="alert">{errorMessage}</p>
      </template>
    </div>
  </lightning-card>
</template>
```

**force-app/main/default/lwc/accountHealthCard/accountHealthCard.js-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <isExposed>true</isExposed>
    <masterLabel>Account Health Card</masterLabel>
    <targets>
        <target>lightning__RecordPage</target>
    </targets>
    <targetConfigs>
        <targetConfig targets="lightning__RecordPage">
            <objects>
                <object>Account</object>
            </objects>
        </targetConfig>
    </targetConfigs>
</LightningComponentBundle>
```

**force-app/main/default/lwc/accountHealthCard/__tests__/accountHealthCard.test.js**

```javascript
import { createElement } from 'lwc';
import AccountHealthCard from 'c/accountHealthCard';
import { getRecord } from 'lightning/uiRecordApi';
import openCaseCount from '@salesforce/apex/AccountHealthController.openCaseCount';
import latestCases from '@salesforce/apex/AccountHealthController.latestCases';

jest.mock('@salesforce/apex/AccountHealthController.openCaseCount', () => ({ default: jest.fn() }), { virtual: true });
jest.mock('@salesforce/apex/AccountHealthController.latestCases', () => ({ default: jest.fn() }), { virtual: true });

const flush = () => Promise.resolve().then(() => Promise.resolve());

function mount() {
  const el = createElement('c-account-health-card', { is: AccountHealthCard });
  el.recordId = '001000000000001AAA';
  document.body.appendChild(el);
  return el;
}

describe('c-account-health-card', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    openCaseCount.mockResolvedValue(3);
  });

  afterEach(() => {
    while (document.body.firstChild) {
      document.body.removeChild(document.body.firstChild);
    }
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  it('shows the account name and open case count', async () => {
    const el = mount();
    getRecord.emit({ fields: { Name: { value: 'Acme' }, Rating: { value: 'Hot' } } });
    await flush();
    const text = el.shadowRoot.textContent;
    expect(text).toContain('Acme');
    expect(text).toContain('Hot');
    expect(text).toContain('Open cases: 3');
  });

  it('refreshes every minute and stops after removal', async () => {
    const el = mount();
    await flush();
    expect(openCaseCount).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(60000);
    expect(openCaseCount).toHaveBeenCalledTimes(2);
    document.body.removeChild(el);
    jest.advanceTimersByTime(180000);
    expect(openCaseCount).toHaveBeenCalledTimes(2);
  });

  it('shows a readable error when loading cases fails', async () => {
    latestCases.mockRejectedValue({ body: { message: 'No access to Case' } });
    const el = mount();
    getRecord.emit({ fields: { Name: { value: 'Acme' }, Rating: { value: null } } });
    await flush();
    el.shadowRoot.querySelector('lightning-button').click();
    await flush();
    await flush();
    expect(el.shadowRoot.textContent).toContain('No access to Case');
  });
});
```

## What happens behind the scenes

When the page loads, the framework creates the component (constructor), attaches it to the DOM (`connectedCallback`), builds the template and renders it, then calls `renderedCallback`. The `@wire` request goes through Lightning Data Service, which caches records, shares the result between components showing the same record, and refreshes when the record changes anywhere on the page. Your code does not call the server for the account name at all if the data is already cached.

The imperative Apex call is different: it always goes to the server when you call it. A change to reactive state, such as `this.openCases`, schedules a re-render. `renderedCallback` runs again after that, which is why it has a guard. Without the guard, any state change inside it would trigger another render and loop.

When the agent leaves the page, `disconnectedCallback` fires. A timer that is not cleared keeps running in the browser, calling Apex for a component nobody sees. That is a memory leak and a pointless server cost.

A few notes on the choices in the code. The component uses `cacheable=false` for the count because the number should be fresh on every call, whereas a wired method would return cached data and ignore the timer. The error reducer handles the three shapes you will meet in practice: an array of messages from the UI API, a `body.message` from Apex, and a plain JavaScript `Error`. And the template uses `lwc:if`, `lwc:elseif` and `lwc:else`, the current conditional directives, instead of the older `if:true` form.

One caution about the Jest file: the way wire adapters are mocked has changed across versions of `@salesforce/sfdx-lwc-jest`. The `getRecord.emit(...)` style shown here works with recent versions, but if your project is older you may need the `registerLdsTestWireAdapter` helper from the package instead. Check the package documentation for the version you installed, and keep the assertions the same.

## Test it and verify

1. Run `npm install` and then `npm run test:unit`. All three Jest tests should pass.
2. Deploy the class and component, then run `AccountHealthControllerTest` and confirm it passes.
3. Open an Account in a sandbox and confirm name, rating and open case count appear.
4. Create a new open case, wait about a minute, and confirm the count increases without reloading.
5. Click **Load latest cases** and confirm up to five cases appear.
6. Remove the user's Case access, click again, and confirm a readable error appears.
7. Open the browser's developer tools network tab, navigate to another page and confirm the polling stops.

## Common mistakes and fixes

- **Mutating `@api` properties inside the child.** Treat them as read-only and dispatch an event to ask the parent to change them.
- **Doing DOM queries in `connectedCallback`.** The template has not rendered yet. Use `renderedCallback`.
- **Forgetting the `error` of a wire result.** The user sees a blank card. Always show something.
- **Unguarded state changes in `renderedCallback`.** They cause render loops.
- **Starting timers or subscriptions without cleanup.** Clear them in `disconnectedCallback`.
- **Calling `@wire` Apex that modifies data.** Wired methods must be `cacheable=true`, so use imperative calls for writes.

## Key takeaways

- The order is constructor, connected, rendered, disconnected, with `errorCallback` in a parent.
- Start work in `connectedCallback` and always undo it in `disconnectedCallback`.
- Use `@wire` for reactive reads and imperative Apex for actions and writes.
- Guard `renderedCallback` and handle every error shape.
- Test hooks and timers with Jest fake timers.

## Where to go next

- Read [LWC communication and data patterns](/articles/lwc-communication-and-data-patterns/) for events and message channels.
- Read [Apex security and user mode](/articles/apex-security-and-user-mode/) for the `WITH USER_MODE` queries used here.
- Read [Apex classes zero to hero](/articles/apex-classes-zero-to-hero/) if the controller code is new to you.
