---
title: "LWC Communication and Data Patterns: Events, LMS, Apex and Lightning Data Service"
description: "Build a three-component LWC screen using @api, custom events, Lightning Message Service, wired Apex, updateRecord and refreshApex, with tests."
category: salesforce-development
tags: [LWC, JavaScript, Intermediate]
publishedAt: 2026-11-12
updatedAt: 2026-11-15
cover: /images/covers/lwc-communication-and-data-patterns.jpg
sources:
  - title: "Lightning Web Components Developer Guide"
    url: "https://developer.salesforce.com/docs/platform/lwc/overview"
  - title: "Lightning Message Service (LWC Developer Guide)"
    url: "https://developer.salesforce.com/docs/platform/lwc/guide/use-message-channel.html"
---

Components rarely work alone. A parent passes data down, a child tells its parent what happened, and unrelated components on the same page need a way to talk. This article shows each communication tool in one small working screen, and explains how to choose between ways of reading and writing data.

## The business scenario

Coastline Realty (a fictional agency) has an **Accounts workspace** page. A **filter panel** lets a manager pick an industry. An **account list**, elsewhere on the page, shows matching accounts and must update when the filter changes. Each account is shown in an **account card** where the manager can mark it as a priority. Saving must update the card and refresh the list without reloading the page.

## Before you start: setup

### In Salesforce

1. Create a custom checkbox field `Priority__c` on Account and give your test users edit access to it.
2. Enable **My Domain** and deploy to a sandbox or scratch org. Lightning Message Service works on Lightning pages and Experience Cloud sites that include the channel.
3. Create a permission set granting access to the Apex class `AccountWorkspaceController` and the `Priority__c` field.
4. Create a **Lightning App Page** in App Builder, drag the filter panel and account list onto it, save and activate.

### In the external system

None is needed. For unit tests install Node 20 or newer and `@salesforce/sfdx-lwc-jest` in your project.

## How it works

Choose the tool by the relationship between components:

- **Parent to child**: pass data with `@api` properties and call `@api` methods.
- **Child to parent**: the child dispatches a `CustomEvent` and the parent listens in its template.
- **Unrelated components**: publish and subscribe on a **Lightning Message Channel**.
- **Server data**: choose by need.

| Need | Use |
|---|---|
| Show or edit one record's fields | `lightning-record-form`, `record-edit-form` or the `getRecord` wire |
| Lists with filters and custom logic | Apex `@AuraEnabled(cacheable=true)` through `@wire` |
| Create, update or delete from a button | Imperative Apex or `lightning/uiRecordApi` (`createRecord`, `updateRecord`) |
| Reduce Apex | The GraphQL wire adapter |

Events bubble only if you set `bubbles: true`, and cross shadow boundaries only with `composed: true`. Use both sparingly, because a bubbling event can be caught by components you did not expect.

## Basic example

Parent to child with `@api`, and child to parent with a custom event.

```javascript
// accountCard.js (child)
import { LightningElement, api } from 'lwc';

export default class AccountCard extends LightningElement {
  @api account;
  @api focus() {
    this.template.querySelector('button').focus();
  }
  handleClick() {
    this.dispatchEvent(new CustomEvent('select', { detail: { id: this.account.Id } }));
  }
}
```

```html
<!-- parent template -->
<c-account-card account={acc} onselect={handleSelect}></c-account-card>
```

Treat `@api` properties as read-only inside the child. To change something, ask the parent with an event.

## Advanced end-to-end example

**force-app/main/default/messageChannels/AccountFilter.messageChannel-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningMessageChannel xmlns="http://soap.sforce.com/2006/04/metadata">
    <masterLabel>AccountFilter</masterLabel>
    <isExposed>true</isExposed>
    <description>Carries the selected industry between workspace components.</description>
    <lightningMessageFields>
        <fieldName>industry</fieldName>
        <description>Selected industry, empty for all</description>
    </lightningMessageFields>
</LightningMessageChannel>
```

**force-app/main/default/classes/AccountWorkspaceController.cls**

```apex
public with sharing class AccountWorkspaceController {

    @AuraEnabled(cacheable=true)
    public static List<Account> byIndustry(String industry) {
        if (String.isBlank(industry)) {
            return [
                SELECT Id, Name, Industry, Priority__c
                FROM Account WITH USER_MODE
                ORDER BY Name LIMIT 50
            ];
        }
        return [
            SELECT Id, Name, Industry, Priority__c
            FROM Account
            WHERE Industry = :industry
            WITH USER_MODE
            ORDER BY Name LIMIT 50
        ];
    }
}
```

**force-app/main/default/classes/AccountWorkspaceControllerTest.cls**

```apex
@IsTest
private class AccountWorkspaceControllerTest {

    @TestSetup
    static void setup() {
        insert new List<Account>{
            new Account(Name = 'Wind Co', Industry = 'Energy'),
            new Account(Name = 'Bank Co', Industry = 'Banking')
        };
    }

    @IsTest
    static void filtersByIndustry() {
        List<Account> rows = AccountWorkspaceController.byIndustry('Energy');
        System.assertEquals(1, rows.size());
        System.assertEquals('Wind Co', rows[0].Name);
    }

    @IsTest
    static void blankFilterReturnsAll() {
        System.assertEquals(2, AccountWorkspaceController.byIndustry('').size());
    }
}
```

**force-app/main/default/lwc/filterPanel/filterPanel.js** (publisher)

```javascript
import { LightningElement, wire } from 'lwc';
import { publish, MessageContext } from 'lightning/messageService';
import ACCOUNT_FILTER from '@salesforce/messageChannel/AccountFilter__c';

export default class FilterPanel extends LightningElement {
  @wire(MessageContext) messageContext;
  timer;

  industries = [
    { label: 'All', value: '' },
    { label: 'Energy', value: 'Energy' },
    { label: 'Banking', value: 'Banking' },
    { label: 'Technology', value: 'Technology' }
  ];

  handleChange(event) {
    const industry = event.detail.value;
    // Debounce so quick changes send one message.
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      publish(this.messageContext, ACCOUNT_FILTER, { industry });
    }, 250);
  }

  disconnectedCallback() {
    clearTimeout(this.timer);
  }
}
```

**force-app/main/default/lwc/filterPanel/filterPanel.html**

```html
<template>
  <lightning-combobox
    label="Industry"
    options={industries}
    value=""
    onchange={handleChange}>
  </lightning-combobox>
</template>
```

**force-app/main/default/lwc/accountCard/accountCard.js** (child)

```javascript
import { LightningElement, api } from 'lwc';
import { updateRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import ID_FIELD from '@salesforce/schema/Account.Id';
import PRIORITY_FIELD from '@salesforce/schema/Account.Priority__c';

export default class AccountCard extends LightningElement {
  @api account;
  saving = false;

  get label() {
    return this.account.Priority__c ? 'Remove priority' : 'Mark as priority';
  }

  async handleToggle() {
    this.saving = true;
    try {
      const fields = {
        [ID_FIELD.fieldApiName]: this.account.Id,
        [PRIORITY_FIELD.fieldApiName]: !this.account.Priority__c
      };
      await updateRecord({ fields });
      // Tell the parent; do not edit the @api property here.
      this.dispatchEvent(new CustomEvent('saved', { detail: { id: this.account.Id } }));
    } catch (error) {
      this.dispatchEvent(new ShowToastEvent({
        title: 'Could not save',
        message: error?.body?.message || 'Unknown error',
        variant: 'error'
      }));
    } finally {
      this.saving = false;
    }
  }
}
```

**force-app/main/default/lwc/accountCard/accountCard.html**

```html
<template>
  <div class="slds-box slds-m-bottom_x-small">
    <p class="slds-text-heading_small">{account.Name}</p>
    <p>{account.Industry}</p>
    <lightning-button label={label} onclick={handleToggle} disabled={saving}></lightning-button>
  </div>
</template>
```

**force-app/main/default/lwc/accountList/accountList.js** (subscriber and parent)

```javascript
import { LightningElement, wire } from 'lwc';
import { subscribe, unsubscribe, MessageContext } from 'lightning/messageService';
import { refreshApex } from '@salesforce/apex';
import ACCOUNT_FILTER from '@salesforce/messageChannel/AccountFilter__c';
import byIndustry from '@salesforce/apex/AccountWorkspaceController.byIndustry';

export default class AccountList extends LightningElement {
  industry = '';
  subscription;
  wiredResult;
  accounts = [];
  error;

  @wire(MessageContext) messageContext;

  @wire(byIndustry, { industry: '$industry' })
  wiredAccounts(result) {
    this.wiredResult = result; // keep the whole object for refreshApex
    if (result.data) {
      this.accounts = result.data;
      this.error = undefined;
    } else if (result.error) {
      this.accounts = [];
      this.error = result.error?.body?.message || 'Could not load accounts';
    }
  }

  connectedCallback() {
    this.subscription = subscribe(this.messageContext, ACCOUNT_FILTER, message => {
      this.industry = message.industry || '';
    });
  }

  disconnectedCallback() {
    unsubscribe(this.subscription);
    this.subscription = undefined;
  }

  handleSaved() {
    return refreshApex(this.wiredResult);
  }

  get hasAccounts() {
    return this.accounts.length > 0;
  }
}
```

**force-app/main/default/lwc/accountList/accountList.html**

```html
<template>
  <lightning-card title="Accounts">
    <div class="slds-p-horizontal_medium">
      <template lwc:if={error}>
        <p class="slds-text-color_error" role="alert">{error}</p>
      </template>
      <template lwc:if={hasAccounts}>
        <template for:each={accounts} for:item="acc">
          <c-account-card key={acc.Id} account={acc} onsaved={handleSaved}></c-account-card>
        </template>
      </template>
      <template lwc:else>
        <p>No accounts match this filter.</p>
      </template>
    </div>
  </lightning-card>
</template>
```

**force-app/main/default/lwc/accountCard/__tests__/accountCard.test.js**

```javascript
import { createElement } from 'lwc';
import AccountCard from 'c/accountCard';
import { updateRecord } from 'lightning/uiRecordApi';

jest.mock('lightning/uiRecordApi', () => ({ updateRecord: jest.fn() }), { virtual: true });

const flush = () => Promise.resolve().then(() => Promise.resolve());

function mount(account) {
  const el = createElement('c-account-card', { is: AccountCard });
  el.account = account;
  document.body.appendChild(el);
  return el;
}

afterEach(() => {
  while (document.body.firstChild) {
    document.body.removeChild(document.body.firstChild);
  }
  jest.clearAllMocks();
});

it('offers to mark an account as priority', () => {
  const el = mount({ Id: '001A', Name: 'Wind Co', Industry: 'Energy', Priority__c: false });
  expect(el.shadowRoot.querySelector('lightning-button').label).toBe('Mark as priority');
});

it('saves the flipped value and tells the parent', async () => {
  updateRecord.mockResolvedValue({});
  const el = mount({ Id: '001A', Name: 'Wind Co', Industry: 'Energy', Priority__c: false });
  const handler = jest.fn();
  el.addEventListener('saved', handler);
  el.shadowRoot.querySelector('lightning-button').click();
  await flush();
  const sent = updateRecord.mock.calls[0][0];
  expect(sent.fields.Priority__c).toBe(true);
  expect(handler).toHaveBeenCalledTimes(1);
  expect(handler.mock.calls[0][0].detail.id).toBe('001A');
});

it('does not announce success when saving fails', async () => {
  updateRecord.mockRejectedValue({ body: { message: 'Insufficient access' } });
  const el = mount({ Id: '001A', Name: 'Wind Co', Industry: 'Energy', Priority__c: true });
  const handler = jest.fn();
  el.addEventListener('saved', handler);
  el.shadowRoot.querySelector('lightning-button').click();
  await flush();
  expect(handler).not.toHaveBeenCalled();
});
```

## What happens behind the scenes

The message channel is a platform-level bus. `publish` hands a message to Lightning Message Service, which delivers it to every active subscriber for that channel on the page, even when the components are in different parts of the DOM and have no parent-child relationship. Subscriptions tied to a `MessageContext` are removed automatically when the component is destroyed, but explicit unsubscribing in `disconnectedCallback` is clearer and safe.

When the list receives the message it sets `industry`. Because the wire parameter is `$industry`, the framework sees a reactive change and calls Apex again with the new value. If a result for that value is already cached, it may be served from the cache.

When a card saves, `updateRecord` sends the change through Lightning Data Service and updates its cache. The Apex wire is a separate cache, so it does not know the record changed. That is why the parent calls `refreshApex` on the stored wire result. Storing the whole result object, not just `data`, is what makes that possible.

## Error handling and testing in practice

Every server call can fail, so every component that makes one needs a visible failure path. In this screen the card shows an error toast, and the list shows a message under the card header. A small helper that flattens the different error shapes (an array of UI API errors, an Apex `body.message`, a plain `Error`) is worth writing once as a shared module, such as `c/ldsUtils`, and importing everywhere.

For testing, Jest with `@salesforce/sfdx-lwc-jest` lets you create the component, change its public properties, click its buttons and assert on the DOM it renders. Mock Apex methods and platform modules with `jest.mock`, and test events by adding a listener to the element before you trigger the action, as the card tests do. Wire adapters can be driven with the emit helpers described in the package documentation, which differ slightly between versions.

Finally, a few habits keep screens like this maintainable: give each component one responsibility, use base components such as `lightning-combobox` and `lightning-button` for built-in accessibility, provide loading and empty states, and never trust that a message or an event carries every field, so read them defensively.

## Test it and verify

1. Run `npm run test:unit` and confirm three card tests pass.
2. Deploy everything, run `AccountWorkspaceControllerTest`, and open the app page.
3. Choose **Energy** in the filter and confirm the list shrinks to matching accounts.
4. Click **Mark as priority** on a card and confirm the button text flips after the list refreshes.
5. Open the record in another tab and confirm `Priority__c` is checked.
6. Remove field edit access for a test user and confirm an error toast appears and the list does not claim success.

## Common mistakes and fixes

- **Mutating an `@api` object in the child.** The change can be lost or throw. Clone it or ask the parent with an event.
- **Setting `bubbles` and `composed` on everything.** Unrelated components catch the event. Keep events local.
- **Forgetting to unsubscribe.** Messages keep triggering work for a dead component.
- **Keeping only `result.data` from a wire.** `refreshApex` needs the whole result object.
- **Calling Apex on every keystroke.** Debounce text and combobox inputs.
- **No loading or error state.** Users cannot tell a slow call from a broken one.

## Key takeaways

- `@api` goes down, custom events go up, message channels go sideways.
- Use `@wire` for reads and `updateRecord` or imperative Apex for writes.
- Refresh a wired Apex result with `refreshApex` after a change.
- Debounce inputs and clean up subscriptions.
- Test components with Jest by listening for the events they dispatch.

## Where to go next

- Read [LWC lifecycle hooks and the wire service](/articles/lwc-lifecycle-and-wire/) for hook order and cleanup.
- Read [Apex security and user mode](/articles/apex-security-and-user-mode/) for the secure queries used here.
- Read [Apex test classes best practices](/articles/apex-test-classes-best-practices/) for stronger Apex tests.
