---
title: "React from Zero: JSX, Components, Props, State and Events"
description: "Beginner React tutorial: set up Vite, write components, pass props, manage state, handle events and lists, and build a tested account list app."
category: react-and-salesforce
tags: [React, JavaScript, Beginner]
publishedAt: 2026-11-11
updatedAt: 2026-11-16
cover: /images/covers/react-fundamentals-zero-to-hero.jpg
sources:
  - title: "React Documentation: Learn React"
    url: "https://react.dev/learn"
  - title: "React: Thinking in React"
    url: "https://react.dev/learn/thinking-in-react"
---

React builds user interfaces from **components**: functions that return markup based on data. This tutorial teaches the ideas one at a time, then combines them into a small app that you can test. You need only basic JavaScript.

## The business scenario

Juniper Consulting (a fictional firm) wants a small internal tool for its sales team: a list of accounts, a search box that filters names as you type, a count of matches, a "no match" message, and a form to add an account. Later the list will come from Salesforce. Your job is to build the screen first with fixed data so the logic is solid and tested before any API is involved.

## Before you start: setup

### In Salesforce

Nothing is needed for this article, because the data is fixed in the app. When you reach the practice step at the end, you will want a Developer Edition org with a few Accounts, and the REST API article for reading them. Keep that for later so you learn React without also debugging authentication.

### In the external system

1. Install **Node 20 or newer** and a code editor such as Visual Studio Code.
2. Create the project:

```bash
npm create vite@latest juniper-accounts -- --template react
cd juniper-accounts
npm install
npm install --save-dev vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
npm run dev
```

3. Open the address that `npm run dev` prints. You should see the starter page. Vite is a popular build tool; React's documentation describes other starting points such as frameworks.
4. In `vite.config.js`, add a test section so Vitest can render components:

```javascript
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/setupTests.js',
    globals: true
  }
});
```

And create `src/setupTests.js` containing one line: `import '@testing-library/jest-dom';`.

## How it works

**JSX** looks like HTML inside JavaScript. Rules: one root element (or a fragment `<>...</>`), `className` instead of `class`, curly braces for JavaScript expressions, and every tag closed.

**Components** are functions whose names start with a capital letter and that return JSX.

**Props** are the inputs to a component. They are read-only, and data flows **down** from parent to child.

**State** is memory that triggers a re-render when it changes. You never change it directly (`count++`); you call the setter with a new value, and for objects and arrays you create copies.

**Events** are handled with props such as `onClick` and `onChange`. A **controlled input** is one whose value lives in state, so state is the single source of truth.

**Lists** use `map`, and each item needs a stable, unique `key` (an id, not the array index when items can reorder).

**Thinking in React:**

1. Break the UI into components.
2. Build a static version with props.
3. Decide what is state and where it lives (the lowest common parent).
4. Add events that update state.

## Basic example

Each idea in the smallest form:

```jsx
import { useState } from 'react';

function Welcome() {
  const name = 'Asha';
  return <h1 className="title">Hello, {name}!</h1>;
}

function AccountCard({ name, industry }) {
  return (
    <div className="card">
      <h3>{name}</h3>
      <p>{industry ?? 'Unknown industry'}</p>
    </div>
  );
}

function Counter() {
  const [count, setCount] = useState(0);
  return <button onClick={() => setCount(c => c + 1)}>Clicked {count} times</button>;
}

function SearchBox() {
  const [text, setText] = useState('');
  return (
    <form onSubmit={e => { e.preventDefault(); console.log(text); }}>
      <input value={text} onChange={e => setText(e.target.value)} />
      <button type="submit">Search</button>
    </form>
  );
}
```

Use `<AccountCard name="Acme Ltd" industry="Energy" />` to pass props. Note `onClick={doIt}` passes a function, while `onClick={doIt()}` would call it during rendering, a common beginner mistake.

## Advanced end-to-end example

The app has four small components and one place that owns the data. **State lives in `App`**, the lowest common parent of the search box, the list and the form.

**src/App.jsx**

```jsx
import { useState } from 'react';
import { SearchBox } from './SearchBox.jsx';
import { AccountList } from './AccountList.jsx';
import { AddAccountForm } from './AddAccountForm.jsx';
import { filterAccounts } from './filterAccounts.js';

const initial = [
  { id: 1, name: 'Acme Ltd', industry: 'Energy' },
  { id: 2, name: 'Birch Bank', industry: 'Banking' },
  { id: 3, name: 'Acorn Foods', industry: null }
];

export default function App() {
  const [accounts, setAccounts] = useState(initial);
  const [query, setQuery] = useState('');
  const [nextId, setNextId] = useState(4);

  const shown = filterAccounts(accounts, query);

  function addAccount(name, industry) {
    // Create a new array: never push into state.
    setAccounts(list => [...list, { id: nextId, name, industry: industry || null }]);
    setNextId(n => n + 1);
  }

  return (
    <main>
      <h1>Accounts</h1>
      <SearchBox value={query} onChange={setQuery} />
      <p aria-live="polite">{shown.length} of {accounts.length} accounts</p>
      <AccountList accounts={shown} />
      <AddAccountForm onAdd={addAccount} />
    </main>
  );
}
```

**src/filterAccounts.js** keeps the filtering rule out of the components, so it is easy to test.

```javascript
export function filterAccounts(accounts, query) {
  const text = query.trim().toLowerCase();
  if (text === '') {
    return accounts;
  }
  return accounts.filter(a => a.name.toLowerCase().includes(text));
}
```

**src/SearchBox.jsx**

```jsx
export function SearchBox({ value, onChange }) {
  return (
    <div>
      <label htmlFor="search">Search by name</label>
      <input id="search" value={value} onChange={e => onChange(e.target.value)} />
    </div>
  );
}
```

**src/AccountList.jsx**

```jsx
function AccountCard({ name, industry }) {
  return (
    <li>
      <strong>{name}</strong> <span>({industry ?? 'Unknown industry'})</span>
    </li>
  );
}

export function AccountList({ accounts }) {
  if (accounts.length === 0) {
    return <p>No accounts match your search.</p>;
  }
  return (
    <ul>
      {accounts.map(a => <AccountCard key={a.id} name={a.name} industry={a.industry} />)}
    </ul>
  );
}
```

**src/AddAccountForm.jsx**

```jsx
import { useState } from 'react';

export function AddAccountForm({ onAdd }) {
  const [name, setName] = useState('');
  const [industry, setIndustry] = useState('');
  const [error, setError] = useState('');

  function submit(event) {
    event.preventDefault();
    if (name.trim().length < 2) {
      setError('Enter a name of at least 2 characters.');
      return;
    }
    onAdd(name.trim(), industry.trim());
    setName('');
    setIndustry('');
    setError('');
  }

  return (
    <form onSubmit={submit}>
      <h2>Add an account</h2>
      <label htmlFor="new-name">Name</label>
      <input id="new-name" value={name} onChange={e => setName(e.target.value)} />
      <label htmlFor="new-industry">Industry</label>
      <input id="new-industry" value={industry} onChange={e => setIndustry(e.target.value)} />
      {error && <p role="alert">{error}</p>}
      <button type="submit">Add account</button>
    </form>
  );
}
```

**src/App.test.jsx**

```jsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import App from './App.jsx';
import { filterAccounts } from './filterAccounts.js';

describe('filterAccounts', () => {
  const list = [{ id: 1, name: 'Acme Ltd' }, { id: 2, name: 'Birch Bank' }];
  it('returns everything for a blank query', () => {
    expect(filterAccounts(list, '   ')).toHaveLength(2);
  });
  it('matches without caring about case', () => {
    expect(filterAccounts(list, 'ACM').map(a => a.id)).toEqual([1]);
  });
});

describe('App', () => {
  it('shows all accounts and a count', () => {
    render(<App />);
    expect(screen.getByText('3 of 3 accounts')).toBeInTheDocument();
  });

  it('filters while typing and shows a message when nothing matches', async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText('Search by name'), 'ac');
    expect(screen.getByText('2 of 3 accounts')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Search by name'), 'zzz');
    expect(screen.getByText(/No accounts match/)).toBeInTheDocument();
  });

  it('adds an account and updates the count', async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText('Name'), 'Delta Co');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(screen.getByText('4 of 4 accounts')).toBeInTheDocument();
    expect(screen.getByText('Delta Co')).toBeInTheDocument();
  });

  it('rejects a name that is too short', async () => {
    render(<App />);
    await userEvent.type(screen.getByLabelText('Name'), 'D');
    await userEvent.click(screen.getByRole('button', { name: 'Add account' }));
    expect(screen.getByRole('alert')).toHaveTextContent('at least 2 characters');
    expect(screen.getByText('3 of 3 accounts')).toBeInTheDocument();
  });
});
```

Run the tests:

```bash
npx vitest run
```

## What happens behind the scenes

When `App` first renders, React calls the function, gets a tree of elements, and builds the page. Each `useState` call asks React for a slot of memory that belongs to that component, in the order the calls appear. When you call a setter, React does not change the variable you hold. It schedules a new render, calls `App` again with the new state, compares the new elements with the old ones, and updates only the parts of the page that differ.

That is why you must not mutate state: React compares by identity, so `list.push(x)` followed by `setList(list)` looks like "nothing changed" to React, and the page stays stale. Creating a new array with `[...list, item]` gives it a new identity and triggers the update.

It is also why `shown` is computed during rendering instead of stored in state. If you stored both `accounts` and `shown`, you would have two copies to keep in sync. Deriving values from state is the simplest way to avoid bugs where the screen disagrees with the data.

The `key` on list items tells React which item is which between renders. With stable ids, adding an item keeps the existing items' DOM and any typed text. With the array index as key, inserting or reordering can attach the wrong state to the wrong item.

## Connecting this app to Salesforce later

Once the screen works with fixed data, only the source of `initial` changes. You would fetch Accounts from a small server that calls the Salesforce REST API, store the result in state, and show a loading message while you wait. Keep the filtering function and the components exactly as they are. Because the logic is already tested, any new bug you see will come from the data connection, not from the interface, which makes problems much faster to find. Never put Salesforce credentials in the browser code; keep them on the server.

## Test it and verify

1. Run `npx vitest run` and confirm all six tests pass.
2. In the browser, type `ac` and confirm the list narrows and the count updates.
3. Type `zzz` and confirm the "No accounts match" message.
4. Add an account with a one-letter name and confirm the error. Add a valid one and confirm it appears.
5. Open the browser's developer console and confirm there are no warnings about keys.
6. Optional: change `key={a.id}` to the array index, add accounts while a filter is active, and observe what goes wrong. Then change it back.

## Common mistakes and fixes

- **Forgetting `key` on lists.** React warns and may mix up items. Use a stable id.
- **Mutating state, for example `push` on an array in state.** Create a new array or object.
- **Calling a function instead of passing it:** `onClick={doIt()}` should be `onClick={doIt}`.
- **Storing derived values in state.** Compute them while rendering.
- **Putting state too low.** If two components need it, move it to their parent.
- **Using `class` instead of `className`.** JSX uses the JavaScript property name.

## Key takeaways

- Components are functions that return JSX from props and state.
- Props flow down and are read-only; state is memory that triggers a re-render.
- Never mutate state; create new values.
- Controlled inputs make state the single source of truth.
- Derive what you can instead of storing it, and test the logic early.

## Where to go next

- Read [React hooks in depth](/articles/react-hooks-in-depth/) for effects, refs and custom hooks.
- Read [React state and reducers](/articles/react-state-and-reducers/) when state grows.
- Read [React vs Lightning Web Components](/articles/react-vs-lwc/) to see where React fits in Salesforce work.
