---
title: "React with TypeScript and Testing: Typed Components, Vitest and Testing Library"
description: "Add TypeScript to React components and hooks, validate API data at runtime, and test behaviour with Vitest and Testing Library, including async states."
category: react-and-salesforce
tags: [React, TypeScript, Testing, Intermediate]
publishedAt: 2026-11-11
updatedAt: 2026-11-16
cover: /images/covers/react-typescript-and-testing.jpg
sources:
  - title: "React: Using TypeScript"
    url: "https://react.dev/learn/typescript"
  - title: "Testing Library: React"
    url: "https://testing-library.com/docs/react-testing-library/intro/"
  - title: "Vitest"
    url: "https://vitest.dev/"
---

TypeScript catches mistakes while you type. Tests catch mistakes while the app runs. Used together they let you change a React codebase without fear. This article shows typed components, a typed and validated API layer, and tests that behave like a user.

## The business scenario

Juniper Consulting's support portal lists open cases from an API that is backed by Salesforce. Last month the API started returning `priority: null` for some cases and the page crashed for every agent. The team wants three protections: types so components cannot be misused, a check at the API boundary so bad data becomes a clear error instead of a crash, and automated tests for the loading, success, empty and error states that run on every pull request.

## Before you start: setup

### In Salesforce

If the cases come from Salesforce, confirm which fields can be empty. In Setup, open Object Manager, then Case, then Fields and Relationships, and check whether Priority is required. Fields that are not required can arrive as `null`. Also confirm the integration user can read Case, and that the server endpoint returns only the fields the portal needs. Write the real shape down; you will encode it as a type and a runtime check below.

### In the external system

1. Create a TypeScript React project: `npm create vite@latest portal -- --template react-ts`.
2. Install the test tools and a schema library:

```bash
npm install zod
npm install --save-dev vitest jsdom @testing-library/react @testing-library/user-event @testing-library/jest-dom
```

3. In `vite.config.ts` set `test: { environment: 'jsdom', setupFiles: './src/setupTests.ts', globals: true }`.
4. Create `src/setupTests.ts` with `import '@testing-library/jest-dom/vitest';`.
5. Add `"test": "vitest run"` and `"typecheck": "tsc --noEmit"` to the `scripts` in `package.json`.

## How it works

TypeScript adds **types** to JavaScript. Types describe the shape of props, state and function results. The compiler checks them and then erases them, so nothing is checked at runtime. That has one important consequence: a type like `Case` does not protect you from a server that sends something else. For data that crosses a boundary (network, storage, user input), validate it at runtime with a schema library such as Zod, and **derive** the TypeScript type from the schema so the two cannot drift.

For React you type three things: props (a `type` for each component), state (`useState<Case[]>([])`) and refs (`useRef<HTMLInputElement>(null)`).

For tests, the guiding idea of Testing Library is: test what the user sees and does, not implementation details. You find elements by role, label or text, exactly as a person (or a screen reader) would. This makes tests survive refactors and quietly checks accessibility. Vitest runs the tests; jsdom provides a fake browser; `user-event` simulates real clicks and typing.

## Basic example

```tsx
import { useRef, useState } from 'react';

type Account = { id: string; name: string; industry?: string };

type CardProps = {
  account: Account;
  onSelect: (id: string) => void;
};

export function AccountCard({ account, onSelect }: CardProps) {
  return <button onClick={() => onSelect(account.id)}>{account.name}</button>;
}

export function Picker() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div>
      <input ref={inputRef} />
      <button onClick={() => setAccounts([{ id: '1', name: 'Acme' }])}>Load</button>
      {accounts.map(a => (
        <AccountCard key={a.id} account={a} onSelect={id => console.log(id)} />
      ))}
    </div>
  );
}
```

If you forget `onSelect` or pass a number as the id, the compiler reports it before the code runs. A minimal test:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi, test, expect } from 'vitest';
import { AccountCard } from './Basic';

test('calls onSelect with the account id', async () => {
  const onSelect = vi.fn();
  render(<AccountCard account={{ id: '1', name: 'Acme' }} onSelect={onSelect} />);
  await userEvent.click(screen.getByRole('button', { name: 'Acme' }));
  expect(onSelect).toHaveBeenCalledWith('1');
});
```

## Advanced end-to-end example

The portal has a schema, a typed API function, a hook that exposes a discriminated state, a component, and tests for every state.

**src/caseSchema.ts** is the single source of truth.

```typescript
import { z } from 'zod';

export const caseSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  // Salesforce can send null for optional fields; normalise to a default.
  priority: z.string().nullable().transform(p => p ?? 'Unspecified'),
  status: z.enum(['New', 'Working', 'Escalated', 'Closed'])
});

export const caseListSchema = z.array(caseSchema);

export type Case = z.infer<typeof caseSchema>;
```

**src/api.ts**

```typescript
import { caseListSchema, type Case } from './caseSchema';

export class ApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function fetchOpenCases(signal?: AbortSignal): Promise<Case[]> {
  const response = await fetch('/api/cases?status=open', { signal });
  if (!response.ok) {
    throw new ApiError('The server returned ' + response.status, response.status);
  }
  const body: unknown = await response.json();
  const parsed = caseListSchema.safeParse(body);
  if (!parsed.success) {
    // A clear error here beats a crash deep inside a component.
    throw new ApiError('The server sent data in an unexpected shape.');
  }
  return parsed.data;
}
```

**src/useCases.ts** returns a *discriminated union*, so the component cannot read `data` unless the status is `success`.

```typescript
import { useEffect, useState } from 'react';
import { fetchOpenCases } from './api';
import type { Case } from './caseSchema';

export type CasesState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'success'; cases: Case[] };

export function useCases(): CasesState {
  const [state, setState] = useState<CasesState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    fetchOpenCases(controller.signal)
      .then(cases => setState({ status: 'success', cases }))
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === 'AbortError') {
          return;
        }
        const message = error instanceof Error ? error.message : 'Unknown error';
        setState({ status: 'error', message });
      });
    return () => controller.abort();
  }, []);

  return state;
}
```

**src/CaseList.tsx**

```tsx
import { useCases } from './useCases';

export function CaseList() {
  const state = useCases();

  switch (state.status) {
    case 'loading':
      return <p>Loading cases...</p>;
    case 'error':
      return <p role="alert">Could not load cases: {state.message}</p>;
    case 'success':
      if (state.cases.length === 0) {
        return <p>No open cases. Nice work.</p>;
      }
      return (
        <ul>
          {state.cases.map(c => (
            <li key={c.id}>
              {c.subject} <em>({c.priority})</em>
            </li>
          ))}
        </ul>
      );
  }
}
```

**src/CaseList.test.tsx**

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CaseList } from './CaseList';
import { caseListSchema } from './caseSchema';

function mockFetch(body: unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify(body), { status })
  );
}

afterEach(() => vi.restoreAllMocks());

describe('caseListSchema', () => {
  it('replaces a null priority with a default', () => {
    const result = caseListSchema.parse([
      { id: '1', subject: 'Printer', priority: null, status: 'New' }
    ]);
    expect(result[0].priority).toBe('Unspecified');
  });

  it('rejects an unknown status', () => {
    const result = caseListSchema.safeParse([
      { id: '1', subject: 'x', priority: 'High', status: 'Lost' }
    ]);
    expect(result.success).toBe(false);
  });
});

describe('CaseList', () => {
  it('shows a loading message first', () => {
    mockFetch([]);
    render(<CaseList />);
    expect(screen.getByText('Loading cases...')).toBeInTheDocument();
  });

  it('shows cases, including one with a null priority', async () => {
    mockFetch([
      { id: '1', subject: 'Printer down', priority: 'High', status: 'New' },
      { id: '2', subject: 'Reset password', priority: null, status: 'Working' }
    ]);
    render(<CaseList />);
    expect(await screen.findByText(/Printer down/)).toBeInTheDocument();
    expect(screen.getByText('(Unspecified)')).toBeInTheDocument();
  });

  it('shows the empty message', async () => {
    mockFetch([]);
    render(<CaseList />);
    expect(await screen.findByText(/No open cases/)).toBeInTheDocument();
  });

  it('shows an error for a failed request', async () => {
    mockFetch({ message: 'boom' }, 500);
    render(<CaseList />);
    expect(await screen.findByRole('alert')).toHaveTextContent('The server returned 500');
  });

  it('shows an error for data in the wrong shape', async () => {
    mockFetch([{ id: 7 }]);
    render(<CaseList />);
    expect(await screen.findByRole('alert')).toHaveTextContent('unexpected shape');
  });
});
```

Run `npm run typecheck` and `npm test`.

## What happens behind the scenes

When you build or run the app, the TypeScript compiler (or Vite's fast transpiler) removes every type annotation. What reaches the browser is plain JavaScript. That is why `response.json()` returns `unknown` in the example: the compiler cannot know what the server sent. `safeParse` is real JavaScript that walks the data and checks each rule, so it is the only thing that truly protects you. Because `Case` is derived from the schema with `z.infer`, changing the schema updates the type automatically.

The discriminated union works because TypeScript narrows the type inside each `case` of the `switch`. Inside `case 'success'` the compiler knows `state.cases` exists; in `case 'error'` it knows `state.message` exists. If you add a fourth status later and forget to handle it, the compiler can warn you.

In tests, `render` mounts the component into jsdom. `findBy` queries retry until the element appears or a timeout passes, which is how they wait for the mocked `fetch` promise to resolve and React to re-render. `getBy` queries fail immediately, so use them for things that must already be there. `vi.restoreAllMocks()` in `afterEach` stops one test's mock from leaking into the next.

## A practical order for adopting this on an existing project

You do not have to convert everything at once. Start with the boundary: write the schema and the API function for one endpoint, because that is where the crash in our scenario came from. Next, type the components that receive that data, which usually surfaces two or three hidden assumptions about empty fields. Then add tests for the states of one screen and run them in continuous integration. Each step delivers value on its own, and you can stop at any point without leaving the project half converted. Turn on the compiler's strict option for new files first, and tighten older files gradually as you touch them.

## Test it and verify

1. Run `npm run typecheck`. Then deliberately pass a number as `id` somewhere and confirm the compiler complains. Undo the change.
2. Run `npm test` and confirm all eight tests pass.
3. Change a test expectation to something wrong and confirm the failure message points at the right line.
4. Point the dev server at a stub that returns `priority: null` and confirm the page shows "Unspecified" instead of crashing.
5. Run both commands in your continuous integration so a pull request cannot merge if either fails.

## Common mistakes and fixes

- **Trusting types for server data.** Types are erased at runtime. Validate at the boundary.
- **Using `any` to silence errors.** Use `unknown` and narrow it.
- **Testing implementation details,** such as component state or CSS classes. Query by role, label and text.
- **Forgetting to wait.** Use `findBy` or `waitFor` for async results, not `getBy`.
- **Leaking mocks between tests.** Restore them after each test.
- **Large snapshot tests.** They change often and prove little. Prefer specific assertions.
- **Only testing success.** Test loading, empty and error states too, because those are where bugs appear.

## Key takeaways

- Types describe your code; schemas verify real data. Use both, and derive types from schemas.
- Discriminated unions make impossible states impossible to render.
- Query by role and label so tests resemble users.
- Mock the network, and test loading, success, empty and error states.
- Run typecheck and tests on every pull request.

## Where to go next

- Read [React hooks in depth](/articles/react-hooks-in-depth/) for the effect and cleanup patterns used here.
- Read [React useEffect and data fetching](/articles/react-useeffect-data-fetching/) for more fetching patterns.
- Read [React vs Lightning Web Components](/articles/react-vs-lwc/) to compare testing approaches with LWC Jest tests.
