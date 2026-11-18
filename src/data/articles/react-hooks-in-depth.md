---
title: "React Hooks in Depth: useEffect, useRef, useMemo, useCallback and Custom Hooks"
description: "Learn React hooks with a tested example: effects with cleanup, refs, memoization, a reusable useFetch hook, and how to debug loops and stale values."
category: react-and-salesforce
tags: [React, Hooks, Intermediate]
publishedAt: 2026-11-11
updatedAt: 2026-11-16
cover: /images/covers/react-hooks-in-depth.jpg
sources:
  - title: "React: Synchronizing with Effects"
    url: "https://react.dev/learn/synchronizing-with-effects"
  - title: "React: Reusing Logic with Custom Hooks"
    url: "https://react.dev/learn/reusing-logic-with-custom-hooks"
  - title: "React: You Might Not Need an Effect"
    url: "https://react.dev/learn/you-might-not-need-an-effect"
---

Hooks let function components keep state, talk to the outside world and reuse logic. Most hook bugs come from one misunderstanding: what an effect is for. This article explains `useEffect`, `useRef`, `useMemo`, `useCallback` and custom hooks with a realistic, tested example.

## The business scenario

Juniper Consulting's support team has a dashboard that shows the details of a case when an agent selects it. The details come from an HTTP endpoint (later backed by Salesforce). Requirements: show a loading state, show errors, ignore a slow response if the agent has already selected another case, focus the search box on load, and avoid recomputing a heavy summary on every keystroke. Each requirement maps to one hook.

## Before you start: setup

### In Salesforce

For this article the endpoint can be a stub. If you later point it at Salesforce, you need a Developer Edition org, a server-side proxy that holds the OAuth credentials (see the OAuth and External Client Apps article), and an Apex REST or standard REST API call that returns a Case by id. Never call Salesforce directly from browser code with a secret.

### In the external system

1. Create a Vite React project as in the React fundamentals article, with Vitest and Testing Library installed.
2. Decide the endpoint shape. This article assumes `GET /api/cases/:id` returning JSON like `{ "id": "500A", "subject": "Printer down", "priority": "High" }` and a 404 when the id is unknown.
3. In tests you will replace `fetch` with a mock, so no server is required to follow along.

## How it works

**useEffect** synchronizes your component with something outside React: a network request, a timer, a subscription. It runs **after** rendering. It receives a dependency array: the effect re-runs when any listed value changed. It may return a **cleanup** function, which runs before the next run and when the component unmounts.

**Strict Mode** in development runs effects, cleanup and effects again on mount to expose missing cleanup. That is a feature, not a bug.

**useRef** holds a value that survives renders without causing one, and is the standard way to reach a DOM element (for focus).

**useMemo** caches a computed value between renders; **useCallback** caches a function. Use them only when you measured a problem or need a stable identity, because they add complexity.

**Custom hooks** are functions starting with `use` that call other hooks, so you can share logic such as fetching.

The rules: call hooks only at the top level of a component or custom hook, never inside conditions or loops.

## Basic example

```jsx
import { useEffect, useRef, useState } from 'react';

function CaseDetail({ caseId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    fetch(`/api/cases/${caseId}`, { signal: controller.signal })
      .then(r => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(setData)
      .catch(e => { if (e.name !== 'AbortError') setError(e); });
    return () => controller.abort();
  }, [caseId]);

  if (error) return <p role="alert">Could not load: {error.message}</p>;
  if (!data) return <p>Loading...</p>;
  return (
    <section>
      <input ref={inputRef} aria-label="Search" />
      <h2>{data.subject}</h2>
      <p>Priority: {data.priority}</p>
    </section>
  );
}
```

The cleanup aborts the previous request when `caseId` changes, so an old slow response can never overwrite a newer one.

## Advanced end-to-end example

We move the fetching into a reusable `useFetch` hook, add a debounced search hook, memoize a summary, and test everything.

**src/useFetch.js**

```javascript
import { useEffect, useState } from 'react';

export function useFetch(url) {
  const [state, setState] = useState({ status: 'idle', data: null, error: null });

  useEffect(() => {
    if (!url) {
      setState({ status: 'idle', data: null, error: null });
      return undefined;
    }
    const controller = new AbortController();
    setState({ status: 'loading', data: null, error: null });

    fetch(url, { signal: controller.signal })
      .then(response => {
        if (!response.ok) {
          throw new Error('HTTP ' + response.status);
        }
        return response.json();
      })
      .then(data => setState({ status: 'success', data, error: null }))
      .catch(error => {
        if (error.name !== 'AbortError') {
          setState({ status: 'error', data: null, error });
        }
      });

    return () => controller.abort();
  }, [url]);

  return state;
}
```

**src/useDebounced.js** delays a fast-changing value.

```javascript
import { useEffect, useState } from 'react';

export function useDebounced(value, delay = 300) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}
```

**src/summary.js** is the "heavy" calculation, kept pure.

```javascript
export function buildSummary(cases) {
  const byPriority = {};
  for (const c of cases) {
    byPriority[c.priority] = (byPriority[c.priority] ?? 0) + 1;
  }
  return Object.entries(byPriority)
    .sort((a, b) => b[1] - a[1])
    .map(([priority, count]) => `${priority}: ${count}`)
    .join(', ');
}
```

**src/CaseDashboard.jsx**

```jsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFetch } from './useFetch.js';
import { useDebounced } from './useDebounced.js';
import { buildSummary } from './summary.js';

function CaseRow({ item, onSelect }) {
  return (
    <li>
      <button onClick={() => onSelect(item.id)}>{item.subject}</button> ({item.priority})
    </li>
  );
}

export default function CaseDashboard() {
  const [search, setSearch] = useState('');
  const [selectedId, setSelectedId] = useState(null);
  const searchRef = useRef(null);
  const debounced = useDebounced(search, 300);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const list = useFetch(`/api/cases?q=${encodeURIComponent(debounced)}`);
  const detail = useFetch(selectedId ? `/api/cases/${selectedId}` : null);

  const summary = useMemo(
    () => (list.data ? buildSummary(list.data) : ''),
    [list.data]
  );

  const select = useCallback(id => setSelectedId(id), []);

  return (
    <main>
      <label htmlFor="q">Search cases</label>
      <input id="q" ref={searchRef} value={search} onChange={e => setSearch(e.target.value)} />

      {list.status === 'loading' && <p>Loading cases...</p>}
      {list.status === 'error' && <p role="alert">Could not load cases: {list.error.message}</p>}
      {list.status === 'success' && (
        <>
          <p>Summary: {summary || 'no cases'}</p>
          <ul>
            {list.data.map(c => <CaseRow key={c.id} item={c} onSelect={select} />)}
          </ul>
        </>
      )}

      {detail.status === 'success' && (
        <aside aria-label="Case detail">
          <h2>{detail.data.subject}</h2>
          <p>Priority: {detail.data.priority}</p>
        </aside>
      )}
      {detail.status === 'error' && <p role="alert">Could not load the case.</p>}
    </main>
  );
}
```

**src/CaseDashboard.test.jsx**

```jsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import CaseDashboard from './CaseDashboard.jsx';
import { buildSummary } from './summary.js';

const cases = [
  { id: 'A', subject: 'Printer down', priority: 'High' },
  { id: 'B', subject: 'Reset password', priority: 'Low' },
  { id: 'C', subject: 'VPN error', priority: 'High' }
];

function respond(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
}

describe('buildSummary', () => {
  it('counts by priority, largest first', () => {
    expect(buildSummary(cases)).toBe('High: 2, Low: 1');
  });
});

describe('CaseDashboard', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn(url => {
      if (url.startsWith('/api/cases/A')) return respond(cases[0]);
      if (url.startsWith('/api/cases/missing')) return respond({}, false, 404);
      return respond(cases);
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('loads the list and shows a summary', async () => {
    render(<CaseDashboard />);
    expect(screen.getByText('Loading cases...')).toBeInTheDocument();
    expect(await screen.findByText('Summary: High: 2, Low: 1')).toBeInTheDocument();
  });

  it('focuses the search box on load', async () => {
    render(<CaseDashboard />);
    await screen.findByText(/Summary/);
    expect(screen.getByLabelText('Search cases')).toHaveFocus();
  });

  it('shows details after selecting a case', async () => {
    render(<CaseDashboard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Printer down' }));
    const detail = await screen.findByLabelText('Case detail');
    expect(detail).toHaveTextContent('Priority: High');
  });

  it('shows an error when the list request fails', async () => {
    globalThis.fetch = vi.fn(() => respond({}, false, 500));
    render(<CaseDashboard />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('HTTP 500')
    );
  });
});
```

Run `npx vitest run`.

## What happens behind the scenes

On the first render React runs your component and paints. Only then does it run effects. In `useFetch`, the effect starts a request and returns a cleanup. When `url` changes, React first runs the **previous** cleanup (aborting the old request), then runs the effect with the new url. That order is what prevents stale responses from winning a race.

The dependency array is a list of values the effect reads. React compares each with `Object.is` after every render. If you leave a value out, the effect closes over an old copy and shows stale data. If you put an object or function created during render in the list, it is new every time, so the effect re-runs endlessly. The fix is to depend on primitives (like the url string) or to stabilize the value with `useMemo` or `useCallback`.

`useMemo` stores the last result and its dependencies; if they are unchanged it returns the stored result without calling your function. It is a performance hint, not a guarantee, so the code must be correct without it. `useCallback(fn, deps)` is the same idea for functions and is useful mainly when passing callbacks to memoized children or into dependency arrays.

Debouncing works through cleanup too: every keystroke starts a timer, and the next keystroke runs cleanup, cancelling the previous timer. Only a pause of 300 ms lets a timer finish.

## Choosing the right hook

When you are unsure which hook to reach for, ask what you are trying to do. If the value can be calculated from props and state, calculate it during rendering with no hook at all. If you need to remember something that should redraw the screen when it changes, use state. If you need to remember something that should not redraw the screen, such as a timer id or a DOM element, use a ref. If you need to talk to something outside React, use an effect. If a calculation is expensive and you have measured it, use `useMemo`. If the same logic appears in two components, extract a custom hook. Working through that list in order keeps most components simple.

## Test it and verify

1. Run `npx vitest run` and confirm all five tests pass.
2. In the browser, open the network tab, type quickly in the search box and confirm that only one list request is sent after you pause.
3. Select a case and quickly select another; confirm the detail always matches the last selection.
4. Stop the API and confirm the error message appears instead of a blank page.
5. In development, confirm the double effect run in Strict Mode causes no visible bug. If it does, a cleanup is missing.

## Common mistakes and fixes

- **Infinite loop:** an effect sets state that is in its own dependency list, or lists an object created each render. Depend on primitives or memoize.
- **Stale values:** a dependency was omitted. Keep the exhaustive-deps lint rule on and fix the cause rather than silencing it.
- **Memory leaks and race conditions:** no cleanup. Abort requests and clear timers.
- **Using an effect for derived data.** If you can calculate it while rendering, do that, as the "You Might Not Need an Effect" guide explains.
- **Hooks inside conditions.** Move the condition inside the hook.
- **Memoizing everything.** Measure first; unnecessary `useMemo` adds noise.

## Key takeaways

- Effects synchronize with the outside world; cleanup keeps them safe.
- The dependency array lists everything the effect reads.
- Refs store values without re-rendering and reach DOM elements.
- Memoize only for measured cost or stable identity.
- Custom hooks share logic, and tests with a mocked `fetch` make them reliable.

## Where to go next

- Read [React from zero](/articles/react-fundamentals-zero-to-hero/) if components and state are still new.
- Read [React useEffect and data fetching](/articles/react-useeffect-data-fetching/) for deeper fetching patterns.
- Read [React state and reducers](/articles/react-state-and-reducers/) for complex state.
