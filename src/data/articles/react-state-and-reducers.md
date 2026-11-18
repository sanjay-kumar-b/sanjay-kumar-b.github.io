---
title: "React State: useState vs useReducer vs Context"
description: "Choose the right React state tool: local state, reducers for complex updates, and context for sharing, with a tested order-entry example."
category: react-and-salesforce
tags: [React, Hooks, State]
publishedAt: 2026-11-04
updatedAt: 2026-11-16
cover: /images/covers/react-state-and-reducers.jpg
sources:
  - title: "React: State, a component's memory"
    url: "https://react.dev/learn/state-a-components-memory"
  - title: "React: Extracting state logic into a reducer"
    url: "https://react.dev/learn/extracting-state-logic-into-a-reducer"
---

State is how a React component remembers things. React gives you three main tools for it, and choosing the wrong one is the usual reason a component becomes hard to read. This article shows when to use `useState`, when to move to `useReducer`, and when to share state with Context, using one growing example.

## The business scenario

Juniper Consulting's sales reps enter quotes for customers. A quote has line items (product, quantity, unit price), a discount percentage with a maximum of 20, and a status that moves from draft to submitted. The page also needs the signed-in user's name and a theme in many places. Quantity changes, line removal, discount limits and the "cannot submit an empty quote" rule are all business rules that must not be scattered across event handlers.

## Before you start: setup

### In Salesforce

None is required to learn the patterns. If you later save the quote to Salesforce, you need a Quote or custom Opportunity line object, a server endpoint that writes it with the user's permissions, and a way to read the current user's name (for example from the `User` record through the REST API). Keep the user's name and theme in Context so the quote components do not have to pass them down.

### In the external system

1. Create a Vite React project with Vitest, jsdom and Testing Library as shown in the React fundamentals article.
2. Create the files listed in the advanced example below.
3. Make sure the setup file imports `@testing-library/jest-dom`.

## How it works

**`useState`** stores one value. Call the setter with a new value, or with a function of the previous value when the next value depends on it (`c => c + 1`). Use it for independent values such as a search text or an open/closed flag.

**`useReducer`** stores a value that changes by rules. You describe what happened with an **action** (`{ type: 'quantity', id: 2, value: 5 }`), and a pure **reducer** function takes the current state and the action and returns the next state. Components only dispatch actions. All rules live in one testable function.

**Context** is not a state store. It is a delivery mechanism: a provider puts a value in, and any component below can read it with `useContext` without passing props through every level. The value itself still comes from `useState` or `useReducer`.

**Quick guide:**

1. One value, or a few independent ones: `useState`.
2. Several values that change together, or rules about how they change: `useReducer`.
3. Many distant components need the same value: Context.

Always: never mutate state, keep state as low in the tree as it can live, and derive values during rendering instead of storing duplicates.

## Basic example

```jsx
import { createContext, useContext, useReducer, useState } from 'react';

// 1. useState for a simple, independent value
function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>{count}</button>;
}

// 2. useReducer for related values with rules
function reducer(state, action) {
  switch (action.type) {
    case 'loading': return { ...state, status: 'loading' };
    case 'success': return { status: 'success', data: action.data, error: null };
    case 'error':   return { ...state, status: 'error', error: action.error };
    default: return state;
  }
}

function Loader() {
  const [state, dispatch] = useReducer(reducer, { status: 'idle', data: null, error: null });
  return <button onClick={() => dispatch({ type: 'loading' })}>{state.status}</button>;
}

// 3. Context for values many components need
const ThemeContext = createContext('light');

function ThemedLabel({ text }) {
  const theme = useContext(ThemeContext);
  return <span className={theme}>{text}</span>;
}
```

Use it as `<ThemeContext.Provider value="dark"><ThemedLabel text="Hello" /></ThemeContext.Provider>`.

## Advanced end-to-end example

The quote editor uses a reducer for the quote, and a separate context for the session (user and theme). The reducer is a pure file with no React in it.

**src/quoteReducer.js**

```javascript
export const MAX_DISCOUNT = 20;

export const emptyQuote = {
  items: [],
  discount: 0,
  status: 'draft',
  error: null
};

export function quoteReducer(state, action) {
  if (state.status === 'submitted' && action.type !== 'reset') {
    return state; // submitted quotes are read-only
  }
  switch (action.type) {
    case 'add': {
      const existing = state.items.find(i => i.id === action.item.id);
      const items = existing
        ? state.items.map(i => (i.id === existing.id ? { ...i, quantity: i.quantity + 1 } : i))
        : [...state.items, { ...action.item, quantity: 1 }];
      return { ...state, items, error: null };
    }
    case 'quantity': {
      if (action.value < 1) {
        return { ...state, items: state.items.filter(i => i.id !== action.id), error: null };
      }
      const items = state.items.map(i => (i.id === action.id ? { ...i, quantity: action.value } : i));
      return { ...state, items, error: null };
    }
    case 'remove':
      return { ...state, items: state.items.filter(i => i.id !== action.id), error: null };
    case 'discount': {
      if (action.value < 0 || action.value > MAX_DISCOUNT) {
        return { ...state, error: `Discount must be between 0 and ${MAX_DISCOUNT} percent.` };
      }
      return { ...state, discount: action.value, error: null };
    }
    case 'submit':
      if (state.items.length === 0) {
        return { ...state, error: 'Add at least one item before submitting.' };
      }
      return { ...state, status: 'submitted', error: null };
    case 'reset':
      return emptyQuote;
    default:
      throw new Error('Unknown action: ' + action.type);
  }
}

export function quoteTotal(state) {
  const gross = state.items.reduce((sum, i) => sum + i.quantity * i.price, 0);
  const net = gross * (1 - state.discount / 100);
  return Math.round(net * 100) / 100;
}
```

**src/SessionContext.jsx** holds values that rarely change.

```jsx
import { createContext, useContext, useMemo, useState } from 'react';

const SessionContext = createContext(null);

export function SessionProvider({ user, children }) {
  const [theme, setTheme] = useState('light');
  // Memoize so consumers re-render only when something really changed.
  const value = useMemo(() => ({ user, theme, setTheme }), [user, theme]);
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession() {
  const value = useContext(SessionContext);
  if (value === null) {
    throw new Error('useSession must be used inside a SessionProvider');
  }
  return value;
}
```

**src/QuoteEditor.jsx**

```jsx
import { useReducer } from 'react';
import { emptyQuote, quoteReducer, quoteTotal, MAX_DISCOUNT } from './quoteReducer.js';
import { useSession } from './SessionContext.jsx';

const catalog = [
  { id: 1, name: 'Consulting day', price: 1200 },
  { id: 2, name: 'Training seat', price: 300 }
];

export default function QuoteEditor() {
  const [quote, dispatch] = useReducer(quoteReducer, emptyQuote);
  const { user, theme } = useSession();
  const locked = quote.status === 'submitted';

  return (
    <main className={theme}>
      <h1>Quote for {user}</h1>
      <div>
        {catalog.map(p => (
          <button key={p.id} disabled={locked} onClick={() => dispatch({ type: 'add', item: p })}>
            Add {p.name}
          </button>
        ))}
      </div>

      <ul>
        {quote.items.map(i => (
          <li key={i.id}>
            {i.name} x
            <input
              type="number"
              aria-label={`Quantity for ${i.name}`}
              value={i.quantity}
              disabled={locked}
              onChange={e => dispatch({ type: 'quantity', id: i.id, value: Number(e.target.value) })}
            />
            <button disabled={locked} onClick={() => dispatch({ type: 'remove', id: i.id })}>
              Remove {i.name}
            </button>
          </li>
        ))}
      </ul>

      <label htmlFor="discount">Discount % (max {MAX_DISCOUNT})</label>
      <input
        id="discount"
        type="number"
        value={quote.discount}
        disabled={locked}
        onChange={e => dispatch({ type: 'discount', value: Number(e.target.value) })}
      />

      <p>Total: {quoteTotal(quote).toFixed(2)}</p>
      {quote.error && <p role="alert">{quote.error}</p>}
      <p>Status: {quote.status}</p>
      <button disabled={locked} onClick={() => dispatch({ type: 'submit' })}>Submit quote</button>
    </main>
  );
}
```

**src/quote.test.jsx**

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { quoteReducer, emptyQuote, quoteTotal } from './quoteReducer.js';
import { SessionProvider } from './SessionContext.jsx';
import QuoteEditor from './QuoteEditor.jsx';

const consulting = { id: 1, name: 'Consulting day', price: 1200 };

describe('quoteReducer', () => {
  it('adds an item, then increments its quantity when added again', () => {
    let s = quoteReducer(emptyQuote, { type: 'add', item: consulting });
    s = quoteReducer(s, { type: 'add', item: consulting });
    expect(s.items).toHaveLength(1);
    expect(s.items[0].quantity).toBe(2);
  });

  it('removes a line when the quantity drops below one', () => {
    let s = quoteReducer(emptyQuote, { type: 'add', item: consulting });
    s = quoteReducer(s, { type: 'quantity', id: 1, value: 0 });
    expect(s.items).toHaveLength(0);
  });

  it('rejects a discount above the maximum and keeps the old one', () => {
    const s = quoteReducer(emptyQuote, { type: 'discount', value: 35 });
    expect(s.discount).toBe(0);
    expect(s.error).toMatch(/between 0 and 20/);
  });

  it('refuses to submit an empty quote', () => {
    const s = quoteReducer(emptyQuote, { type: 'submit' });
    expect(s.status).toBe('draft');
    expect(s.error).toMatch(/at least one item/);
  });

  it('ignores changes after submit', () => {
    let s = quoteReducer(emptyQuote, { type: 'add', item: consulting });
    s = quoteReducer(s, { type: 'submit' });
    const after = quoteReducer(s, { type: 'add', item: consulting });
    expect(after).toBe(s);
  });

  it('calculates the total with the discount, rounded to cents', () => {
    let s = quoteReducer(emptyQuote, { type: 'add', item: consulting });
    s = quoteReducer(s, { type: 'quantity', id: 1, value: 3 });
    s = quoteReducer(s, { type: 'discount', value: 10 });
    expect(quoteTotal(s)).toBe(3240);
  });

  it('throws on an unknown action so typos are caught early', () => {
    expect(() => quoteReducer(emptyQuote, { type: 'oops' })).toThrow('Unknown action');
  });
});

describe('QuoteEditor', () => {
  function renderEditor() {
    return render(
      <SessionProvider user="Asha">
        <QuoteEditor />
      </SessionProvider>
    );
  }

  it('reads the user from context', () => {
    renderEditor();
    expect(screen.getByText('Quote for Asha')).toBeInTheDocument();
  });

  it('adds items, updates the total and locks after submit', async () => {
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Add Consulting day' }));
    expect(screen.getByText('Total: 1200.00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Submit quote' }));
    expect(screen.getByText('Status: submitted')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add Training seat' })).toBeDisabled();
  });
});
```

Run `npx vitest run`. The reducer tests need no browser at all, which is the main benefit of this pattern.

## What happens behind the scenes

When you call `dispatch(action)`, React does not run your reducer immediately inside the handler. It queues the action, then re-renders the component, and during that render calls `quoteReducer(currentState, action)` to compute the next state. If the reducer returns the same object it received (as it does for a submitted quote), React sees no change and skips the update. That is why the "ignore changes after submit" test can use `toBe(s)`.

Reducers must be **pure**: no fetching, no random numbers, no mutation. In development React may call them twice to detect impurity. If your reducer needed to call a server, you would do that in an event handler or effect and dispatch the result as an action.

Context works through the tree. When the provider's `value` changes (compared by identity), React re-renders **every** component that called `useContext` for it. This is why the session value is wrapped in `useMemo`: without it, a new object is created on every provider render and all consumers re-render even if nothing changed. It is also why you should not put fast-changing values, such as the current quote, in the same context as slow ones like the theme. Split contexts by how often they change, or keep fast data in props.

## Why the quote logic belongs in a reducer

Imagine the same rules written as separate `useState` calls and event handlers. The discount limit would live in one handler, the empty-quote rule in another, and the read-only rule would be a check you must remember to add to every handler. Six months later someone adds a "duplicate line" button and forgets one of the checks, so a submitted quote can be edited. With a reducer there is a single door into the state. Every change passes through `quoteReducer`, so every rule applies to every action automatically. When a business rule changes, for example the maximum discount rises to 25, you change one constant and one test. This is the real reason to choose a reducer: not the syntax, but having one place where the rules live and where they can be tested without rendering anything.

## Test it and verify

1. Run `npx vitest run` and confirm that all nine tests pass.
2. In the browser, add both products, change a quantity to 0 and confirm the line disappears.
3. Enter a discount of 35 and confirm the error appears and the total does not change.
4. Submit an empty quote and confirm the error; add an item and submit, then confirm every control is disabled.
5. Open React Developer Tools, find `QuoteEditor`, and watch the hooks panel as you dispatch actions.

## Common mistakes and fixes

- **Mutating state inside the reducer** (`state.items.push(...)`). Return new arrays and objects.
- **Putting side effects in a reducer.** Keep it pure; call the server elsewhere.
- **Using Context for everything.** It re-renders all consumers. Use it for slow-changing, widely needed values.
- **Passing a new object to a Provider on each render.** Memoize the value.
- **Storing derived data**, like the total, in state. Compute it with a function.
- **Reaching for a reducer too early.** Two independent flags are fine with `useState`.
- **Server data in a reducer by hand.** For fetching and caching, a data-fetching library is usually a better fit than hand-written state.

## Key takeaways

- `useState` for simple values, `useReducer` for rules, Context for delivery.
- A reducer is a pure function, so business rules become easy unit tests.
- Never mutate state; create new values.
- Memoize context values and split contexts by update frequency.
- Derive totals and flags instead of storing them.

## Where to go next

- Read [React from zero](/articles/react-fundamentals-zero-to-hero/) for the basics of state.
- Read [React hooks in depth](/articles/react-hooks-in-depth/) for effects and custom hooks.
- Read [React advanced patterns and performance](/articles/react-advanced-patterns-performance/) for rendering cost.
