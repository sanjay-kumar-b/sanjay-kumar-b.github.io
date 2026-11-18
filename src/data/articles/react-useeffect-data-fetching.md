---
title: "Fetching Data in React with useEffect, Without the Classic Bugs"
description: "Handle loading, errors, race conditions, retries and a Salesforce proxy when fetching data in React with useEffect, with a fully tested hook."
category: react-and-salesforce
tags: [React, Hooks, REST APIs, JavaScript]
publishedAt: 2026-11-02
updatedAt: 2026-11-16
cover: /images/covers/react-useeffect-data-fetching.jpg
sources:
  - title: "React docs: useEffect"
    url: "https://react.dev/reference/react/useEffect"
  - title: "MDN: AbortController"
    url: "https://developer.mozilla.org/en-US/docs/Web/API/AbortController"
---

Fetching inside `useEffect` looks easy, but a naive version has three bugs: no error state, no loading state, and stale responses overwriting newer ones. This article fixes all three, then adds retries and a small proxy so the same pattern works against Salesforce without exposing credentials in the browser.

## The business scenario

Juniper Consulting's account managers open an Accounts page that loads data from a company API, which in turn reads Salesforce. Users complain of three things: a blank list when the network blips, rows from the wrong search appearing after they type quickly, and a spinner that never ends when the server is slow. You will build a `useFetch` hook with loading, error, retry and cancellation, plus a server proxy, and test the failure paths.

## Before you start: setup

### In Salesforce

1. Create or use a **Developer Edition** org with a few Accounts.
2. Create an **External Client App** (or a Connected App in older orgs) for server-to-server access, enable OAuth, and grant the minimum scopes such as `api`. Note the consumer key and secret; they belong only on your server.
3. Create an integration user and give it a permission set that can read Account. Never use an administrator for an integration.
4. The proxy below uses the REST API endpoint `/services/data/v67.0/query`. Confirm that your org's API version supports it (Setup, then API, or the release notes).

### In the external system

1. Create a Vite React project and install Vitest, jsdom and Testing Library as in the React fundamentals article. Install `express` for the proxy.
2. Store the Salesforce instance URL and an access token in environment variables on the server (`SF_INSTANCE_URL`, `SF_ACCESS_TOKEN`). In a real system you would obtain the token through the OAuth flow described in the OAuth article; a static token is acceptable only for local learning.
3. Configure the Vite dev server to proxy `/api` to the Express port so the browser only ever talks to your server.

## How it works

`fetch` returns a promise that rejects only on network failure. An HTTP 404 or 500 still **resolves**, so you must check `response.ok`.

An effect that fetches should do four things: set loading before the request, check `ok`, store data or an error, and return a **cleanup** that cancels the request. Cancelling matters because requests can finish out of order. If the user searches "a" and then "ac", the answer to "a" may arrive last and overwrite the correct result. `AbortController` solves this: aborting the old request makes its promise reject with an `AbortError`, which you ignore.

Retries need care. Retry only failures that might succeed later (network errors, HTTP 502, 503, 504), never client errors such as 400 or 404, and wait longer each time (exponential backoff).

React Strict Mode runs effects twice in development. With a correct cleanup the first request is aborted and the second completes, so it is harmless.

## Basic example

The naive version and the safer version side by side:

```jsx
import { useEffect, useState } from 'react';

// Naive: no loading, no errors, race conditions possible
function NaiveAccounts() {
  const [data, setData] = useState([]);
  useEffect(() => {
    fetch('/api/accounts').then(r => r.json()).then(setData);
  }, []);
  return <ul>{data.map(a => <li key={a.id}>{a.name}</li>)}</ul>;
}

// Safer: explicit state and cleanup
function useFetch(url) {
  const [state, setState] = useState({ data: null, error: null, loading: true });

  useEffect(() => {
    const controller = new AbortController();
    setState({ data: null, error: null, loading: true });

    fetch(url, { signal: controller.signal })
      .then(res => {
        if (!res.ok) throw new Error(`Request failed: ${res.status}`);
        return res.json();
      })
      .then(data => setState({ data, error: null, loading: false }))
      .catch(error => {
        if (error.name === 'AbortError') return;
        setState({ data: null, error, loading: false });
      });

    return () => controller.abort();
  }, [url]);

  return state;
}
```

## Advanced end-to-end example

We build a retrying fetch helper, a hook on top of it with a manual `retry` button, a component, a Salesforce proxy, and tests.

**src/fetchJson.js** is plain JavaScript, so it is easy to test.

```javascript
const RETRYABLE = new Set([502, 503, 504]);

export class HttpError extends Error {
  constructor(status) {
    super('Request failed: ' + status);
    this.name = 'HttpError';
    this.status = status;
  }
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    });
  });
}

export async function fetchJson(url, { signal, retries = 2, baseDelay = 300 } = {}) {
  let attempt = 0;
  for (;;) {
    try {
      const response = await fetch(url, { signal });
      if (response.ok) {
        return await response.json();
      }
      if (!RETRYABLE.has(response.status) || attempt >= retries) {
        throw new HttpError(response.status);
      }
    } catch (error) {
      if (error.name === 'AbortError' || error instanceof HttpError) {
        throw error;
      }
      if (attempt >= retries) {
        throw error; // network failure, out of attempts
      }
    }
    attempt += 1;
    await wait(baseDelay * 2 ** (attempt - 1), signal);
  }
}
```

**src/useRemote.js**

```javascript
import { useCallback, useEffect, useState } from 'react';
import { fetchJson } from './fetchJson.js';

export function useRemote(url, options) {
  const [state, setState] = useState({ status: 'loading', data: null, error: null });
  const [attempt, setAttempt] = useState(0);

  const retry = useCallback(() => setAttempt(n => n + 1), []);

  useEffect(() => {
    if (!url) {
      setState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });

    fetchJson(url, { ...options, signal: controller.signal })
      .then(data => setState({ status: 'success', data, error: null }))
      .catch(error => {
        if (error.name !== 'AbortError') {
          setState({ status: 'error', data: null, error });
        }
      });

    return () => controller.abort();
    // attempt is a dependency on purpose: changing it re-runs the request
  }, [url, attempt]);

  return { ...state, retry };
}
```

**src/AccountSearch.jsx**

```jsx
import { useState } from 'react';
import { useRemote } from './useRemote.js';

export default function AccountSearch() {
  const [term, setTerm] = useState('');
  const url = term.trim().length >= 2 ? `/api/accounts?name=${encodeURIComponent(term.trim())}` : null;
  const { status, data, error, retry } = useRemote(url, { baseDelay: 10 });

  return (
    <section>
      <label htmlFor="term">Account name</label>
      <input id="term" value={term} onChange={e => setTerm(e.target.value)} />

      {status === 'idle' && <p>Type at least two letters.</p>}
      {status === 'loading' && <p>Loading...</p>}
      {status === 'error' && (
        <div role="alert">
          <p>Could not load accounts: {error.message}</p>
          <button onClick={retry}>Try again</button>
        </div>
      )}
      {status === 'success' && data.length === 0 && <p>No accounts found.</p>}
      {status === 'success' && data.length > 0 && (
        <ul>{data.map(a => <li key={a.id}>{a.name}</li>)}</ul>
      )}
    </section>
  );
}
```

**server/proxy.mjs** keeps Salesforce credentials on the server and returns only what the page needs.

```javascript
import express from 'express';

const app = express();
const instance = process.env.SF_INSTANCE_URL;
const token = process.env.SF_ACCESS_TOKEN;

// Escape a user value for use inside a SOQL string literal.
export function soqlEscape(value) {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

app.get('/api/accounts', async (req, res) => {
  const name = String(req.query.name ?? '').slice(0, 80);
  if (name.length < 2) {
    return res.status(400).json({ message: 'name must be at least 2 characters' });
  }
  const soql = `SELECT Id, Name FROM Account WHERE Name LIKE '%${soqlEscape(name)}%' ORDER BY Name LIMIT 20`;
  try {
    const sf = await fetch(`${instance}/services/data/v67.0/query?q=${encodeURIComponent(soql)}`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!sf.ok) {
      return res.status(502).json({ message: 'Salesforce request failed' });
    }
    const body = await sf.json();
    res.json(body.records.map(r => ({ id: r.Id, name: r.Name })));
  } catch {
    res.status(502).json({ message: 'Salesforce is unreachable' });
  }
});

if (process.env.NODE_ENV !== 'test') {
  app.listen(3001, () => console.log('Proxy on 3001'));
}

export default app;
```

**src/AccountSearch.test.jsx**

```jsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AccountSearch from './AccountSearch.jsx';
import { fetchJson } from './fetchJson.js';
import { soqlEscape } from '../server/proxy.mjs';

function json(body, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status }));
}

afterEach(() => vi.restoreAllMocks());

describe('fetchJson', () => {
  it('retries a 503 and then succeeds', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({}, 503))
      .mockImplementationOnce(() => json([{ id: 1 }]));
    const result = await fetchJson('/x', { baseDelay: 1 });
    expect(result).toEqual([{ id: 1 }]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 404', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}, 404));
    await expect(fetchJson('/x', { baseDelay: 1 })).rejects.toThrow('Request failed: 404');
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry limit', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}, 503));
    await expect(fetchJson('/x', { baseDelay: 1, retries: 2 })).rejects.toThrow('503');
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('soqlEscape', () => {
  it('escapes quotes and backslashes', () => {
    expect(soqlEscape("O'Brien\\")).toBe("O\\'Brien\\\\");
  });
});

describe('AccountSearch', () => {
  it('asks for two letters first', () => {
    render(<AccountSearch />);
    expect(screen.getByText('Type at least two letters.')).toBeInTheDocument();
  });

  it('shows results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json([{ id: 'a', name: 'Acme Ltd' }]));
    render(<AccountSearch />);
    await userEvent.type(screen.getByLabelText('Account name'), 'ac');
    expect(await screen.findByText('Acme Ltd')).toBeInTheDocument();
  });

  it('shows an error and recovers when the user retries', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => json({}, 500))
      .mockImplementation(() => json([{ id: 'a', name: 'Acme Ltd' }]));
    render(<AccountSearch />);
    await userEvent.type(screen.getByLabelText('Account name'), 'ac');
    expect(await screen.findByRole('alert')).toHaveTextContent('Request failed: 500');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Acme Ltd')).toBeInTheDocument();
  });
});
```

Run `npx vitest run`.

## What happens behind the scenes

Rendering and fetching are separate steps. React renders first, shows the "Loading..." branch, and **then** runs the effect, which starts the request. When the response arrives, `setState` schedules a new render with the data.

If the user types another letter before the response comes back, `url` changes. React finishes the next render, runs the cleanup of the previous effect (`controller.abort()`), and then runs the effect again. The aborted `fetch` rejects with `AbortError`, which the hook deliberately ignores, so the old response can never replace newer state. That sequence is the whole race-condition fix.

The `attempt` counter is a trick: it is state that does nothing except appear in the dependency array. Changing it makes React treat the effect as stale, abort the old run, and start a new one, so the retry button needs no special code.

Inside `fetchJson`, backoff doubles the wait on each attempt (10, 20, 40 milliseconds in the tests, 300, 600, 1200 in production). The wait itself listens for the abort signal, so a user who changes the search during a backoff does not leave a timer running.

On the server side, the proxy receives the browser's request, adds the bearer token the browser never sees, and calls the Salesforce REST API. The user's text is escaped before it goes into the SOQL string, and the page returns only `id` and `name`, which limits what a stolen page session could read.

## Test it and verify

1. Run `npx vitest run` and confirm that all nine tests pass.
2. Start the proxy and the dev server, type two letters and confirm accounts appear.
3. In the browser developer tools, set the network to offline, type another letter and confirm the error and the retry button appear. Go online and press retry.
4. Throttle the network to slow 3G, type quickly, and confirm that only the last search's results ever show.
5. Search for a name containing an apostrophe, such as O'Brien, and confirm the proxy does not return a Salesforce error.

## Common mistakes and fixes

- **Missing dependency.** Put every value the effect reads, such as `url`, in the dependency array.
- **Not checking `response.ok`.** HTTP errors resolve; check the status.
- **Retrying everything.** Retrying a 400 or 404 just repeats the mistake; retry only transient errors.
- **No cleanup.** Without `abort`, responses can arrive out of order and timers can leak.
- **Double requests in development.** Strict Mode does this on purpose; correct cleanup makes it harmless.
- **Calling Salesforce directly from the browser with secrets.** Keep credentials on a server and call your own API.
- **Building SOQL from raw user text.** Escape it, or better, use a fixed query with bound parameters in Apex.

## When to use something else

For caching, deduplication, background refresh and pagination, a data-fetching library is usually a better fit than hand-written effects, and the React documentation itself notes that effects are not always the right tool for fetching. The hook above is a good way to understand what those libraries do for you.

## Key takeaways

- Track `status`, `data` and `error` explicitly.
- Always check `response.ok` and retry only transient failures.
- Abort in the cleanup to avoid race conditions and leaks.
- Keep Salesforce credentials on a server and return only needed fields.
- Test the retry, error and recovery paths, not only success.

## Where to go next

- Read [React hooks in depth](/articles/react-hooks-in-depth/) for the full set of hooks.
- Read [React with TypeScript and testing](/articles/react-typescript-and-testing/) to validate response shapes.
- Read [OAuth and External Client Apps in Salesforce](/articles/oauth-flows-and-external-client-apps/) for obtaining tokens properly.
