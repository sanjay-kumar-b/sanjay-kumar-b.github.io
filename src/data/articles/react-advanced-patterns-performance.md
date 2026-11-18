---
title: "Advanced React: Performance, Context Design, Suspense and Modern React 19 Features"
description: "Advanced React: avoid wasted renders, split context, code split, add error boundaries, use transitions and React 19 actions, with a tested example."
category: react-and-salesforce
tags: [React, Performance, Advanced, Architecture]
publishedAt: 2026-11-11
updatedAt: 2026-11-16
cover: /images/covers/react-advanced-patterns-performance.jpg
sources:
  - title: "React Documentation"
    url: "https://react.dev/"
  - title: "React v19 release post"
    url: "https://react.dev/blog/2024/12/05/react-19"
---

Most React apps are fast enough until a list grows, a context is shared too widely, or a heavy screen loads on every visit. This article explains what causes renders, how to remove the wasteful ones, and how to use error boundaries, lazy loading, transitions and React 19 actions safely.

## The business scenario

Juniper Consulting's operations console shows 5,000 open work items with a live filter box, a theme switch and a signed-in user panel. Typing in the filter feels laggy, toggling the theme re-renders the whole list, the reports tab adds 400 KB to the first load, and one bad record crashes the entire page into a white screen. You will fix each symptom with the right tool and prove it with tests rather than guesses.

## Before you start: setup

### In Salesforce

If the work items come from Salesforce, make the data cheap before you optimise the screen. Request only the fields you show, page the results on the server (for example 50 at a time using `LIMIT` and `OFFSET`, or query locators for large sets), and consider a Salesforce report or a summary field for totals instead of summing 5,000 rows in the browser. The integration user needs read access to the object and fields only.

### In the external system

1. Use a Vite React project (React 19 for the action example) with Vitest, jsdom and Testing Library as in earlier articles.
2. Install React Developer Tools in your browser and open its **Profiler** tab. Measure before and after every change.
3. Build the production bundle with `npm run build` and look at the size of each emitted file to see what code splitting saves.

## How it works

A component re-renders when its own state changes, when its parent re-renders, or when a context it reads changes. Re-rendering is cheap by default, because React compares the result with the previous one and touches the page only where something differs. Optimise only measured problems.

The tools, from most to least preferred:

1. **Move state down.** Keep fast-changing state, such as a text box, in a small component so its siblings are not re-rendered.
2. **Lift content up with `children`.** Elements passed as `children` are created by the parent, so a stateful wrapper does not re-create them.
3. **`React.memo(Component)`** skips a render when props are shallow-equal. It does nothing if you pass new objects or functions each time, so pair it with `useMemo` and `useCallback`.
4. **Virtualise long lists** so only the visible rows exist in the page.
5. **Split context** by how often values change, and separate state from dispatch.

For loading, `lazy` with `Suspense` downloads a component's code only when it first renders. **Error boundaries** catch errors thrown while rendering their subtree and show a fallback. They do not catch errors in event handlers or async code.

**Transitions** (`useTransition`, `useDeferredValue`) mark an update as non-urgent so typing stays responsive while a slow list updates.

**React 19** added Actions with `useActionState` for form submissions, `useOptimistic`, the `use` API, and `ref` as a regular prop. Libraries must be compatible, so check your framework before adopting.

## Basic example

```jsx
import { createContext, lazy, memo, Suspense, useReducer } from 'react';

// 1. Split state and dispatch so components that only dispatch never re-render on state changes
const StateCtx = createContext(null);
const DispatchCtx = createContext(null);

function reducer(state, action) {
  return action.type === 'toggle' ? { ...state, dark: !state.dark } : state;
}

export function Provider({ children }) {
  const [state, dispatch] = useReducer(reducer, { dark: false });
  return (
    <DispatchCtx.Provider value={dispatch}>
      <StateCtx.Provider value={state}>{children}</StateCtx.Provider>
    </DispatchCtx.Provider>
  );
}

// 2. Skip re-rendering when props are unchanged
export const Row = memo(function Row({ item }) {
  return <li>{item.title}</li>;
});

// 3. Load heavy screens on demand
const Reports = lazy(() => import('./Reports.jsx'));

export function Tab() {
  return (
    <Suspense fallback={<p>Loading reports...</p>}>
      <Reports />
    </Suspense>
  );
}
```

## Advanced end-to-end example

The console combines a memoized list, a deferred filter, an error boundary around each row, a lazy reports tab, and a React 19 form action. A small render counter lets the tests prove that the optimisation works.

**src/renderCounter.js**

```javascript
// Test helper: counts how many times each row actually rendered.
export const renders = {};

export function recordRender(id) {
  renders[id] = (renders[id] ?? 0) + 1;
}

export function resetRenders() {
  for (const key of Object.keys(renders)) {
    delete renders[key];
  }
}
```

**src/ErrorBoundary.jsx** (error boundaries must be classes)

```jsx
import { Component } from 'react';

export class ErrorBoundary extends Component {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error, info) {
    // Send to your logging service here.
    this.props.onError?.(error, info);
  }

  render() {
    if (this.state.failed) {
      return this.props.fallback ?? <p role="alert">This item could not be shown.</p>;
    }
    return this.props.children;
  }
}
```

**src/WorkItemList.jsx**

```jsx
import { memo, useDeferredValue, useMemo } from 'react';
import { ErrorBoundary } from './ErrorBoundary.jsx';
import { recordRender } from './renderCounter.js';

const Row = memo(function Row({ item }) {
  recordRender(item.id);
  if (item.title === null) {
    throw new Error('Work item ' + item.id + ' has no title');
  }
  return <li>{item.title}</li>;
});

export function WorkItemList({ items, filter }) {
  // The input stays responsive; the list catches up when React has time.
  const deferred = useDeferredValue(filter);

  const visible = useMemo(() => {
    const text = deferred.trim().toLowerCase();
    return text === '' ? items : items.filter(i => (i.title ?? '').toLowerCase().includes(text));
  }, [items, deferred]);

  return (
    <ul>
      {visible.map(item => (
        <ErrorBoundary key={item.id}>
          <Row item={item} />
        </ErrorBoundary>
      ))}
    </ul>
  );
}
```

**src/Console.jsx**

```jsx
import { lazy, Suspense, useState } from 'react';
import { WorkItemList } from './WorkItemList.jsx';

const Reports = lazy(() => import('./Reports.jsx'));

export default function Console({ items }) {
  const [filter, setFilter] = useState('');
  const [dark, setDark] = useState(false);
  const [tab, setTab] = useState('list');

  return (
    <main className={dark ? 'dark' : 'light'}>
      <button onClick={() => setDark(d => !d)}>Toggle theme</button>
      <button onClick={() => setTab('list')}>Work items</button>
      <button onClick={() => setTab('reports')}>Reports</button>

      {tab === 'list' && (
        <>
          <label htmlFor="filter">Filter</label>
          <input id="filter" value={filter} onChange={e => setFilter(e.target.value)} />
          <WorkItemList items={items} filter={filter} />
        </>
      )}
      {tab === 'reports' && (
        <Suspense fallback={<p>Loading reports...</p>}>
          <Reports count={items.length} />
        </Suspense>
      )}
    </main>
  );
}
```

**src/Reports.jsx**

```jsx
export default function Reports({ count }) {
  return <section aria-label="Reports"><h2>Reports</h2><p>{count} open items</p></section>;
}
```

**src/RenameForm.jsx** uses a React 19 action.

```jsx
import { useActionState } from 'react';

export function RenameForm({ save }) {
  const [error, submit, pending] = useActionState(async (_previous, formData) => {
    const name = String(formData.get('name') ?? '').trim();
    if (name.length < 3) {
      return 'Enter at least 3 characters.';
    }
    const ok = await save(name);
    return ok ? null : 'Could not rename.';
  }, null);

  return (
    <form action={submit}>
      <label htmlFor="name">New name</label>
      <input id="name" name="name" />
      <button disabled={pending}>{pending ? 'Saving...' : 'Save'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}
```

**src/console.test.jsx**

```jsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import Console from './Console.jsx';
import { RenameForm } from './RenameForm.jsx';
import { renders, resetRenders } from './renderCounter.js';

const items = [
  { id: 'a', title: 'Fix printer' },
  { id: 'b', title: 'Reset password' },
  { id: 'c', title: null }
];

beforeEach(() => {
  resetRenders();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('Console', () => {
  it('isolates a bad record behind an error boundary', () => {
    render(<Console items={items} />);
    expect(screen.getByText('Fix printer')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('could not be shown');
  });

  it('does not re-render rows when only the theme changes', async () => {
    render(<Console items={items.slice(0, 2)} />);
    const before = { ...renders };
    await userEvent.click(screen.getByRole('button', { name: 'Toggle theme' }));
    expect(renders).toEqual(before);
  });

  it('filters the list', async () => {
    render(<Console items={items.slice(0, 2)} />);
    await userEvent.type(screen.getByLabelText('Filter'), 'print');
    expect(await screen.findByText('Fix printer')).toBeInTheDocument();
    expect(screen.queryByText('Reset password')).not.toBeInTheDocument();
  });

  it('loads the reports tab on demand', async () => {
    render(<Console items={items.slice(0, 2)} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reports' }));
    expect(await screen.findByLabelText('Reports')).toHaveTextContent('2 open items');
  });
});

describe('RenameForm', () => {
  it('shows a validation message without calling save', async () => {
    const save = vi.fn();
    render(<RenameForm save={save} />);
    await userEvent.type(screen.getByLabelText('New name'), 'ab');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('at least 3');
    expect(save).not.toHaveBeenCalled();
  });

  it('reports a failed save', async () => {
    const save = vi.fn().mockResolvedValue(false);
    render(<RenameForm save={save} />);
    await userEvent.type(screen.getByLabelText('New name'), 'Acme');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not rename');
    expect(save).toHaveBeenCalledWith('Acme');
  });
});
```

Run `npx vitest run`.

## What happens behind the scenes

When `Console` re-renders because the theme state changed, React calls `Console` again and gets new elements. It then walks down. `WorkItemList` receives the **same** `items` array and the **same** `filter` string, but it is not wrapped in `memo`, so React calls it again. Inside, `useMemo` sees unchanged dependencies and returns the stored `visible` array. Each `Row` is wrapped in `memo`, and its `item` prop is the same object as before, so React skips calling `Row` at all. That is exactly what the render-counter test proves: the counts do not change.

`useDeferredValue` splits one update into two renders. The first is urgent and keeps the old deferred value, so the input shows your keystroke immediately. The second is low priority and can be interrupted by the next keystroke; it uses the new value and re-filters the list. If filtering 5,000 rows takes 80 ms, typing no longer waits for it.

`lazy` turns `import()` into a promise. On first render React finds the component not loaded yet, **suspends**, shows the nearest `Suspense` fallback, and re-renders when the code arrives. The bundler emits the reports code as a separate file, so the first page load does not include it.

An error boundary works through React's render phase. When `Row` throws, React unwinds to the closest boundary, which calls `getDerivedStateFromError` and renders the fallback instead. Because each row has its own boundary, one bad record hides only itself. In the test, `console.error` is silenced because React logs caught errors in development.

For `useActionState`, React runs your async function when the form is submitted, sets `pending` to true, and stores the returned value (here an error message or `null`) as the next state.

## Test it and verify

1. Run `npx vitest run` and confirm all six tests pass.
2. Open the Profiler, record while typing in the filter, and compare the flame graph with and without `useDeferredValue`.
3. Toggle the theme and confirm in the Profiler that rows show as "did not render".
4. Run `npm run build`, note that the reports code is in its own file, then open the Network tab and confirm it loads only when you click the tab.
5. Load data that contains a record with no title and confirm that only that row shows the fallback.

## Common mistakes and fixes

- **Optimising without measuring.** Use the Profiler first.
- **`memo` with unstable props.** A new object or inline function each render defeats it. Stabilise with `useMemo` and `useCallback`, or pass primitives.
- **One giant context.** Split by update frequency, and separate state and dispatch.
- **Expecting error boundaries to catch everything.** They miss event handlers and async code; handle those with `try` and `catch`.
- **Lazy loading tiny components.** Split only heavy screens.
- **Adopting React 19 features blindly.** Check library and framework support.

## Key takeaways

- Move state down and lift content up before reaching for `memo`.
- Memoization needs stable props to work.
- Transitions and deferred values keep typing responsive.
- Lazy loading and boundaries improve load time and resilience.
- Prove optimisations with the Profiler and render-count tests.

## Where to go next

- Read [React state and reducers](/articles/react-state-and-reducers/) for context and reducer design.
- Read [React hooks in depth](/articles/react-hooks-in-depth/) for `useMemo` and `useCallback`.
- Read [React with TypeScript and testing](/articles/react-typescript-and-testing/) for typing the same components.
