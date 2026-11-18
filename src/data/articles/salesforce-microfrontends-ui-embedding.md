---
title: "Salesforce Microfrontends: Embed Web Apps in Lightning with UI Embedding"
description: "How Salesforce Microfrontends work: a host LWC, lightning-ui-embedding, a React guest app, events, security checks and tests, with setup steps."
category: react-and-salesforce
tags: [Microfrontends, LWC, React, Advanced]
publishedAt: 2026-11-12
updatedAt: 2026-11-16
cover: /images/covers/salesforce-microfrontends-ui-embedding.jpg
featured: true
sources:
  - title: "Salesforce Microfrontends: Embed Web Apps in Lightning (Developers Blog, Oct 2026)"
    url: "https://developer.salesforce.com/blogs/2026/10/salesforce-microfrontends-embed-web-apps-in-lightning"
  - title: "What's New in Salesforce Multi-Framework (Winter '27)"
    url: "https://developer.salesforce.com/blogs/2026/10/whats-new-in-salesforce-multi-framework-angular-is-now-ga"
---

**Microfrontends** let you embed an independently developed web app inside a Lightning page through **UI Embedding**. They do not replace LWC: the embedded app sits next to LWC components and exchanges context, data, UI state and events with its host.

> The blog describes the shape of the host and guest code but not every detail. The code below follows that shape (a `lightning-ui-embedding` host, `getViewSDK`, `getUiState()`, `subscribe()` and a custom event) and puts the logic you control in plain modules you can test. Confirm attribute and method names against the current documentation before deploying.

## The business scenario

Juniper Consulting already owns a React "Account Scorer" widget used by the sales team. Managers want it on the Account record page, showing the current rating (Hot, Warm, Cold) and letting them choose a new one. The widget team ships weekly and does not want to rewrite it as an LWC. The Salesforce team wants the save to happen in Salesforce, with the user's permissions, not inside the widget.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox with the Salesforce CLI and Visual Studio Code.
2. In **Setup**, add the guest app's origin to the security configuration the blog describes, so the browser may load it. During development that origin is `http://localhost:5173`. In production use an HTTPS origin only.
3. Make sure Account has the **Rating** field on the page layout, and your user can edit it.
4. Create the host LWC (below) in a Salesforce DX project, deploy it, then open **Lightning App Builder**, edit the Account record page, drag the component on, and save and activate the page.
5. Confirm the release your org is on. Externally hosted microfrontends reached GA in September 2026. Salesforce-hosted UI bundles with UI Embedding were Beta in the October blog, with GA targeted for mid-November 2026, so check the status.

### In the external system

1. Host the guest app at an origin you control. For development run a Vite React app: `npm create vite@latest scorer -- --template react-ts`, then `npm install` and `npm run dev` (it serves on port 5173).
2. Install the SDK: `npm install @salesforce/platform-sdk`.
3. Serve the guest page at a stable path, for example `/embedding/score-account`.
4. Add a Content Security Policy that allows Salesforce to frame the page, and use HTTPS in production.
5. Agree the contract with the host in writing: it passes `rating`; the guest sends a `score` event with `{ rating }`. Nothing else.

## How it works

Three parts:

- **Host:** a custom LWC rendering the `lightning-ui-embedding` base component. It owns Salesforce context, loads platform data and decides what to share.
- **Guest:** your web app. It receives props and UI state and sends custom events back.
- **Boundary:** the guest runs in a **sandboxed iframe**; UI Embedding is the managed communication layer between the two.

The host sets attributes such as `sandbox`, `shell-title`, `src`, `props` and `onscore`. The blog's sandbox example is `allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox`. The guest reads state with `getUiState()` and `subscribe()` from the view SDK, and sends events with `dispatchEvent(new CustomEvent("score", ...))`.

The key design rule: the **guest only sees what the host passes**, and the **host must not trust what the guest sends**, because the host's save runs with the user's permissions.

## Basic example

The smallest working pair, following the blog's ScoreAccount sample.

**scoreAccountEmbedding.js**

```javascript
import { LightningElement, api, wire } from 'lwc';
import { getRecord, updateRecord } from 'lightning/uiRecordApi';
import RATING from '@salesforce/schema/Account.Rating';

export default class ScoreAccountEmbedding extends LightningElement {
  @api baseUrl = 'http://localhost:5173';
  @api recordId;

  @wire(getRecord, { recordId: '$recordId', fields: [RATING] }) account;

  get computedSrc() { return `${this.baseUrl}/embedding/score-account`; }
  get props() { return { rating: this.account?.data?.fields?.Rating?.value }; }

  async handleScore(event) {
    await updateRecord({ fields: { Id: this.recordId, Rating: event.detail.rating } });
  }
}
```

**scoreAccountEmbedding.html**

```html
<template>
  <lightning-ui-embedding
    shell-title="Account scorer"
    src={computedSrc}
    props={props}
    sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
    onscore={handleScore}>
  </lightning-ui-embedding>
</template>
```

This works, but it saves whatever the guest sends, with no checks and no error handling.

## Advanced end-to-end example

We harden the host: validate events, show errors, and keep the rule in a plain module with a Jest test. The guest gets a typed contract, a fake-SDK test, and a clear way to show saving state.

**force-app/main/default/lwc/scoreAccountEmbedding/ratingRules.js** has no framework code, so it is easy to test.

```javascript
export const ALLOWED_RATINGS = ['Hot', 'Warm', 'Cold'];

// Returns { ok: true, rating } or { ok: false, message }.
export function validateScoreEvent(detail) {
  if (detail === null || typeof detail !== 'object') {
    return { ok: false, message: 'The embedded app sent an empty message.' };
  }
  const rating = detail.rating;
  if (typeof rating !== 'string' || !ALLOWED_RATINGS.includes(rating)) {
    return { ok: false, message: 'Unsupported rating: ' + String(rating) };
  }
  return { ok: true, rating };
}
```

**force-app/main/default/lwc/scoreAccountEmbedding/scoreAccountEmbedding.js**

```javascript
import { LightningElement, api, wire } from 'lwc';
import { getRecord, updateRecord } from 'lightning/uiRecordApi';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import RATING from '@salesforce/schema/Account.Rating';
import { validateScoreEvent } from './ratingRules';

export default class ScoreAccountEmbedding extends LightningElement {
  @api baseUrl = 'http://localhost:5173';
  @api recordId;
  saving = false;

  @wire(getRecord, { recordId: '$recordId', fields: [RATING] }) account;

  get computedSrc() {
    return `${this.baseUrl}/embedding/score-account`;
  }

  // Pass the minimum: only the rating, never ids or tokens.
  get props() {
    return { rating: this.account?.data?.fields?.Rating?.value ?? null };
  }

  async handleScore(event) {
    const check = validateScoreEvent(event.detail);
    if (!check.ok) {
      this.toast('Could not save rating', check.message, 'error');
      return;
    }
    this.saving = true;
    try {
      await updateRecord({ fields: { Id: this.recordId, Rating: check.rating } });
      this.toast('Rating saved', 'Rating is now ' + check.rating, 'success');
    } catch (error) {
      const message = error?.body?.message ?? 'Unexpected error';
      this.toast('Could not save rating', message, 'error');
    } finally {
      this.saving = false;
    }
  }

  toast(title, message, variant) {
    this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
  }
}
```

**force-app/main/default/lwc/scoreAccountEmbedding/__tests__/ratingRules.test.js**

```javascript
import { validateScoreEvent } from '../ratingRules';

describe('validateScoreEvent', () => {
  it('accepts the three supported ratings', () => {
    for (const rating of ['Hot', 'Warm', 'Cold']) {
      expect(validateScoreEvent({ rating })).toEqual({ ok: true, rating });
    }
  });

  it('rejects an unknown rating', () => {
    expect(validateScoreEvent({ rating: 'Lukewarm' }).ok).toBe(false);
  });

  it('rejects a missing or non-object detail', () => {
    expect(validateScoreEvent(null).ok).toBe(false);
    expect(validateScoreEvent('Hot').ok).toBe(false);
    expect(validateScoreEvent({}).ok).toBe(false);
  });

  it('rejects a rating that is not a string', () => {
    expect(validateScoreEvent({ rating: ['Hot'] }).ok).toBe(false);
  });
});
```

**scorer/src/contract.ts** (guest side) defines the contract once.

```typescript
export type Rating = 'Hot' | 'Warm' | 'Cold';
export const RATINGS: Rating[] = ['Hot', 'Warm', 'Cold'];

export interface HostProps {
  rating: Rating | null;
}

export function readProps(raw: unknown): HostProps {
  const value = (raw as { rating?: unknown } | null)?.rating;
  return { rating: RATINGS.includes(value as Rating) ? (value as Rating) : null };
}
```

**scorer/src/ScoreAccount.tsx**

```tsx
import { useEffect, useState } from 'react';
import { RATINGS, readProps, type Rating } from './contract';

// The view SDK shape described in the blog; inject it so tests can fake it.
export interface ViewSdk {
  getUiState(): unknown;
  subscribe(listener: (state: unknown) => void): () => void;
}

interface Props {
  sdk: ViewSdk;
  send: (rating: Rating) => void;
}

export function ScoreAccount({ sdk, send }: Props) {
  const [rating, setRating] = useState<Rating | null>(() => readProps(sdk.getUiState()).rating);

  useEffect(() => {
    const unsubscribe = sdk.subscribe(state => setRating(readProps(state).rating));
    return unsubscribe;
  }, [sdk]);

  return (
    <section>
      <h2>Account rating</h2>
      <p>Current: {rating ?? 'Not rated'}</p>
      {RATINGS.map(r => (
        <button key={r} aria-pressed={rating === r} onClick={() => send(r)}>
          {r}
        </button>
      ))}
    </section>
  );
}

// Used by the real entry point: dispatch the custom event the host listens for.
export function sendScoreEvent(target: EventTarget, rating: Rating): void {
  target.dispatchEvent(new CustomEvent('score', { detail: { rating } }));
}
```

**scorer/src/ScoreAccount.test.tsx**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ScoreAccount, sendScoreEvent, type ViewSdk } from './ScoreAccount';
import { readProps } from './contract';

function fakeSdk(initial: unknown) {
  let listener: ((s: unknown) => void) | null = null;
  const sdk: ViewSdk = {
    getUiState: () => initial,
    subscribe: l => { listener = l; return () => { listener = null; }; }
  };
  return { sdk, push: (s: unknown) => listener?.(s) };
}

describe('readProps', () => {
  it('ignores values outside the contract', () => {
    expect(readProps({ rating: 'Lukewarm' }).rating).toBeNull();
    expect(readProps(null).rating).toBeNull();
  });
});

describe('ScoreAccount', () => {
  it('shows the rating passed by the host', () => {
    const { sdk } = fakeSdk({ rating: 'Warm' });
    render(<ScoreAccount sdk={sdk} send={() => {}} />);
    expect(screen.getByText('Current: Warm')).toBeInTheDocument();
  });

  it('updates when the host pushes new state', () => {
    const { sdk, push } = fakeSdk({ rating: null });
    render(<ScoreAccount sdk={sdk} send={() => {}} />);
    expect(screen.getByText('Current: Not rated')).toBeInTheDocument();
    act(() => push({ rating: 'Hot' }));
    expect(screen.getByText('Current: Hot')).toBeInTheDocument();
  });

  it('sends the chosen rating', async () => {
    const send = vi.fn();
    const { sdk } = fakeSdk({ rating: 'Cold' });
    render(<ScoreAccount sdk={sdk} send={send} />);
    await userEvent.click(screen.getByRole('button', { name: 'Hot' }));
    expect(send).toHaveBeenCalledWith('Hot');
  });
});

describe('sendScoreEvent', () => {
  it('dispatches a score event with the rating in detail', () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    target.addEventListener('score', e => seen.push((e as CustomEvent).detail));
    sendScoreEvent(target, 'Warm');
    expect(seen).toEqual([{ rating: 'Warm' }]);
  });
});
```

Run `npx vitest run` in the guest project and `npx jest` (or `sfdx-lwc-jest`) in the Salesforce project.

## What happens behind the scenes

When the Account page loads, the host LWC renders `lightning-ui-embedding`. That component creates a **sandboxed iframe** whose address is `computedSrc`, and the browser loads your guest page from your origin (allowed in Salesforce's security configuration). The sandbox attribute lists the few capabilities the guest may use, such as forms and modals; anything not listed, such as running scripts against the parent page, is blocked by the browser itself.

The host never lets the guest touch Salesforce. Instead, the host reads the rating through `getRecord`, packages it into `props`, and UI Embedding delivers it to the guest, where `getUiState()` returns it and `subscribe()` notifies the guest of later changes. When the manager clicks a button, the guest dispatches a `score` custom event. UI Embedding carries that event out of the iframe to the host's `onscore` handler.

At that moment the host is the only code that can call `updateRecord`, and it runs with the **current user's permissions**: object access, field-level security and sharing all apply. That is why the host validates `event.detail` first. A compromised or buggy guest could send `{ rating: "Hot; DROP" }` or something unexpected; the allow-list check turns that into a friendly error toast and no save.

Because the guest is deployed on its own schedule, a new guest version can go live without a Salesforce release. The cost is that the two sides now share a contract, so the contract is kept small and written down.

## Test it and verify

1. Run the guest tests (`npx vitest run`) and the LWC Jest tests and confirm they pass.
2. Start the guest (`npm run dev`), deploy the host, add it to the Account record page, and open an Account.
3. Confirm the current rating appears in the embedded widget. Click a different rating and confirm the toast and that the record's Rating field changed.
4. Use a profile without edit access to Rating and confirm an error toast appears instead of a silent failure.
5. In browser developer tools, send a bad event from the console (for example `rating: 'Lukewarm'`) and confirm the host rejects it.
6. Switch `baseUrl` to your HTTPS production origin in a sandbox and confirm the page still loads.

## Common mistakes and fixes

- **Origin not allowed.** The iframe stays blank or shows a browser error; add the origin in Salesforce security configuration, and check the guest's framing policy.
- **Passing too much.** Pass the minimum as props; never secrets or tokens.
- **Trusting guest events.** Validate in the host before calling `updateRecord`.
- **Using localhost in production.** Use HTTPS on a real origin.
- **Assuming status.** Beta and GA status changed in 2026; check the documentation before depending on it.
- **A wide contract.** Every extra prop or event becomes something two teams must keep in sync.

## When to choose microfrontends

- A team already owns a web app and wants it inside Lightning pages without rewriting.
- Different teams need independent release cycles.
- You need a framework or library LWC does not offer.

When the whole app can live on the platform, compare Multi-Framework (UIBundle) in the decision article.

## Key takeaways

- The host LWC owns Salesforce context and saves; the guest owns its UI.
- The guest runs in a sandboxed iframe and sees only what the host passes.
- Validate every guest event in the host, because saves use the user's permissions.
- Keep the contract small and test both sides in isolation.
- Allow only the needed origin, use HTTPS in production, and confirm release status.

## Where to go next

- Read [Choosing between LWC, Multi-Framework and Microfrontends](/articles/choosing-lwc-multiframework-microfrontends/) to decide when to embed.
- Read [LWC communication and data patterns](/articles/lwc-communication-and-data-patterns/) for events and data in the host.
- Read [Multi-Framework Data SDK and deployment](/articles/multi-framework-data-sdk-and-deployment/) for the hosted alternative.
