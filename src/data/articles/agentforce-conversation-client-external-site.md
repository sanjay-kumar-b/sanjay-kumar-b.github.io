---
title: "Embedding an Agentforce Agent in an External Website or React App"
description: "Compare the Conversation Client Web SDK, messaging for web and the Agent API, then build a tested React chat panel with consent, limits and error handling."
category: agentforce
tags: [Agentforce, Conversation Client, React, Integration, Intermediate]
publishedAt: 2026-11-11
updatedAt: 2026-11-16
cover: /images/covers/agentforce-conversation-client-external-site.jpg
sources:
  - title: "Agentforce Conversation Client (Developer docs)"
    url: "https://developer.salesforce.com/docs/platform/accsdk/guide/"
  - title: "Integrate the Agentforce Conversation Client Web SDK"
    url: "https://developer.salesforce.com/docs/platform/accsdk/guide/acc-sdk-integrate.html"
  - title: "Get Started with the Agent API"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/agent-api-get-started.html"
---

You have three realistic routes to an agent on a public or custom site. This article explains each, gives a decision guide, and then builds the one route whose code you fully control: a **React chat panel** that talks to your own backend, which in turn uses the Agent API. The panel includes a consent gate, input limits, a busy state and error handling, with tests.

## The business scenario

Lakeside Gym (a fictional fitness chain) has a React web app for members. The product team wants an "Ask Lakeside" chat panel that answers membership and class questions using an Agentforce agent. Legal requires that the chat starts only after the member accepts a privacy notice. Support requires that a failing agent never leaves the member staring at a spinner, and that the member can always reach a person.

## Before you start: setup

### In Salesforce

1. Create and activate the agent, and test it in the builder. It must be a custom agent, not the "Agentforce (Default)" type, if you plan to use the Agent API route.
2. Create a least-privilege agent user and permission set. A public site is the riskiest channel, so the agent should only run read-only actions and should escalate for anything sensitive.
3. For the Agent API route, set up an External Client App with client credentials, as described in the Agent API article.
4. For the Web SDK or messaging routes, follow the current Salesforce documentation for deployments, trusted domains and allowed origins.

### In the external system

1. Deploy the backend proxy from the Agent API article. This article assumes it exposes `POST /chat` taking `{ "shopperId", "text" }` and returning the agent's reply as JSON. Adjust `extractReply` below to the shape your proxy returns.
2. Create a React app (Vite is fine) with Vitest and React Testing Library for tests.
3. Publish a privacy notice and decide how long conversations are retained.
4. Add your site's origin to the proxy's allow-list.

## How it works

**Route 1: Agentforce Conversation Client (ACC) Web SDK.** Per Salesforce's overview, the Web SDK adds the Agentforce conversational experience to custom external web apps and abstracts away real-time connectivity, with streaming text, feedback and theming (style tokens) out of the box. Its overview describes Employee Agent connectivity, and it labels the SDK Beta at the time of research. Use it when the app is a website or custom front end outside Salesforce and you want a ready-made chat experience. Do not use it for headless integrations such as SMS or WhatsApp, or custom native mobile apps. The steps, prerequisites and exact component API are in the "Integrate the Agentforce Conversation Client Web SDK" guide and its React-specific Trailhead module. This article does not reproduce SDK code, because I could not verify the current API.

**Route 2: Messaging for web (Enhanced Chat).** A standard Salesforce deployment for customer service agents on public sites: you configure a messaging channel and an embedded deployment, then add the generated snippet to your site. Check Salesforce Help for current setup, because it is tied to Service Cloud messaging features and licences.

**Route 3: Agent API with your own UI.** Full control, more work: your backend holds the OAuth credentials (never expose them in the browser), creates sessions and streams replies to your UI.

| Need | Route |
|---|---|
| Quick, branded chat on a custom web app (employee scenarios) | ACC Web SDK |
| Customer service chat on a public site with Omni-Channel handoff | Messaging for web |
| Fully custom UX, voice, or non-web | Agent API |

Security checklist for any route:

1. Allow only your site's origin (CORS and trusted domains) as the product requires.
2. Authenticate users when the agent can see account data; do not rely on a first name typed in chat.
3. Keep agent actions least-privilege, and escalate to humans for sensitive cases.
4. Never place consumer secrets in front-end code.
5. Add a privacy notice and message retention policy.

## Basic example

The simplest custom client is a function that sends text to your backend and returns the reply:

```javascript
export async function ask(shopperId, text) {
  const res = await fetch('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopperId, text })
  });
  if (!res.ok) {
    throw new Error('Chat is unavailable right now');
  }
  return res.json();
}
```

That is the whole network layer. The advanced version wraps it in a hook that tracks messages, busy state and errors, and in a panel that gates the conversation on consent.

## Advanced end-to-end example

**src/chat/api.js** holds the network call and the reply parsing in one place.

```javascript
export const MAX_LENGTH = 500;

// Adjust to the shape your proxy returns. Here the reply is {messages: [{message: "..."}]}.
export function extractReply(payload) {
  const items = payload?.messages ?? [];
  const text = items.map(m => m.message ?? m.text ?? '').filter(Boolean).join('\n');
  return text || 'Sorry, I could not find an answer. Would you like to speak to a person?';
}

export async function sendMessage(shopperId, text, fetchImpl = fetch) {
  const res = await fetchImpl('/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopperId, text })
  });
  if (res.status === 429) {
    throw new Error('You are sending messages too quickly. Please wait a moment.');
  }
  if (!res.ok) {
    throw new Error('Chat is unavailable right now. You can call us instead.');
  }
  return extractReply(await res.json());
}
```

**src/chat/useAgentChat.js** is the hook that owns the conversation state.

```javascript
import { useCallback, useRef, useState } from 'react';
import { MAX_LENGTH, sendMessage } from './api.js';

export function useAgentChat(shopperId, send = sendMessage) {
  const [messages, setMessages] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const counter = useRef(0);

  const say = useCallback(async rawText => {
    const text = rawText.trim();
    if (!text || busy) {
      return;
    }
    if (text.length > MAX_LENGTH) {
      setError(`Please keep messages under ${MAX_LENGTH} characters.`);
      return;
    }
    setError(null);
    const id = ++counter.current;
    setMessages(list => [...list, { id: `u${id}`, role: 'member', text }]);
    setBusy(true);
    try {
      const reply = await send(shopperId, text);
      setMessages(list => [...list, { id: `a${id}`, role: 'agent', text: reply }]);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }, [busy, send, shopperId]);

  return { messages, busy, error, say };
}
```

**src/chat/ChatPanel.jsx** gates the chat on consent and renders the conversation accessibly.

```jsx
import { useState } from 'react';
import { useAgentChat } from './useAgentChat.js';

export function ChatPanel({ shopperId, send }) {
  const [consented, setConsented] = useState(false);
  const [draft, setDraft] = useState('');
  const { messages, busy, error, say } = useAgentChat(shopperId, send);

  if (!consented) {
    return (
      <section aria-label="Ask Lakeside">
        <p>
          Chats are handled by an automated assistant and may be stored for 30 days to improve our service.
          Please do not share card numbers or passwords.
        </p>
        <button type="button" onClick={() => setConsented(true)}>I understand, start chat</button>
        <a href="/contact">Prefer to speak to a person?</a>
      </section>
    );
  }

  const submit = event => {
    event.preventDefault();
    say(draft);
    setDraft('');
  };

  return (
    <section aria-label="Ask Lakeside">
      <ul aria-live="polite">
        {messages.map(m => (
          <li key={m.id} data-role={m.role}>
            <strong>{m.role === 'member' ? 'You' : 'Assistant'}:</strong> {m.text}
          </li>
        ))}
      </ul>
      {error && <p role="alert">{error}</p>}
      <form onSubmit={submit}>
        <label htmlFor="chat-input">Your question</label>
        <input id="chat-input" value={draft} onChange={e => setDraft(e.target.value)} disabled={busy} maxLength={600} />
        <button type="submit" disabled={busy || draft.trim() === ''}>{busy ? 'Sending' : 'Send'}</button>
      </form>
      <a href="/contact">Speak to a person</a>
    </section>
  );
}
```

**src/chat/ChatPanel.test.jsx** (Vitest and React Testing Library)

```jsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatPanel } from './ChatPanel.jsx';
import { extractReply } from './api.js';

describe('ChatPanel', () => {
  it('shows the privacy notice and no input until the member agrees', async () => {
    render(<ChatPanel shopperId="m1" send={vi.fn()} />);
    expect(screen.getByText(/may be stored for 30 days/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Your question')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /start chat/i }));
    expect(screen.getByLabelText('Your question')).toBeInTheDocument();
  });

  it('sends the question and shows the agent reply', async () => {
    const send = vi.fn().mockResolvedValue('Yoga is at 6 pm on Tuesdays.');
    render(<ChatPanel shopperId="m1" send={send} />);
    await userEvent.click(screen.getByRole('button', { name: /start chat/i }));
    await userEvent.type(screen.getByLabelText('Your question'), 'When is yoga?');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText(/Yoga is at 6 pm/)).toBeInTheDocument();
    expect(send).toHaveBeenCalledWith('m1', 'When is yoga?');
  });

  it('shows a readable error and keeps the page usable when the agent fails', async () => {
    const send = vi.fn().mockRejectedValue(new Error('Chat is unavailable right now. You can call us instead.'));
    render(<ChatPanel shopperId="m1" send={send} />);
    await userEvent.click(screen.getByRole('button', { name: /start chat/i }));
    await userEvent.type(screen.getByLabelText('Your question'), 'Hello');
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled());
    expect(screen.getByRole('link', { name: /speak to a person/i })).toBeInTheDocument();
  });

  it('blocks messages that are too long without calling the agent', async () => {
    const send = vi.fn();
    render(<ChatPanel shopperId="m1" send={send} />);
    await userEvent.click(screen.getByRole('button', { name: /start chat/i }));
    await userEvent.type(screen.getByLabelText('Your question'), 'x'.repeat(550));
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('under 500');
    expect(send).not.toHaveBeenCalled();
  });
});

describe('extractReply', () => {
  it('joins message parts and falls back politely when empty', () => {
    expect(extractReply({ messages: [{ message: 'One' }, { text: 'Two' }] })).toBe('One\nTwo');
    expect(extractReply({})).toMatch(/speak to a person/);
  });
});
```

Add the panel to your page:

```jsx
import { ChatPanel } from './chat/ChatPanel.jsx';

export default function MemberHome({ memberId }) {
  return (
    <main>
      <h1>Welcome back</h1>
      <ChatPanel shopperId={memberId} />
    </main>
  );
}
```

## What happens behind the scenes

When the member types a question, the hook adds it to the list, sets `busy`, and calls your backend. The backend finds or creates an Agent API session for that member, forwards the text, and returns the reply. The agent chooses a subagent, runs its actions as the agent user, and answers. Your panel only ever talks to your own origin, so no Salesforce credentials exist in the browser.

The consent gate matters because the conversation is personal data. Nothing is sent until the member agrees, and the notice tells them what is stored and what not to type. The `maxLength` and the length check protect your agent and your costs, and the rate-limit message maps the backend's 429 to plain language.

`aria-live="polite"` on the list tells screen readers to announce new replies without interrupting, and the visible "Speak to a person" link is the escape hatch for every failure. It is rendered in both the gated and active states on purpose.

## Test it and verify

1. Run `npm test` and confirm all five tests pass.
2. Start your backend proxy and the React dev server. Confirm the notice appears first and no request is sent before consent.
3. Ask a question the agent can answer, then one it should refuse, and confirm both replies display.
4. Stop the backend and send a message. Confirm the alert appears and the page stays usable.
5. Send twelve messages quickly and confirm the rate-limit message appears.
6. Check the browser network tab and confirm there is no Salesforce token or secret anywhere.
7. Use a keyboard only and a screen reader to confirm you can consent, type, send and reach the contact link.

## Common mistakes and fixes

- **Putting consumer secrets in front-end code.** Use a backend proxy.
- **Starting the chat before consent.** Gate it, and say what is stored.
- **Trusting a typed name or id for account data.** Authenticate the member and derive the id on the server.
- **No escape to a person.** Always show a human contact route.
- **Choosing the Web SDK for SMS or native apps.** It is not intended for those; use the Agent API.
- **Assuming Beta stays the same.** Check the SDK's status and API before committing a date.

## Key takeaways

- Three routes: the Conversation Client Web SDK, messaging for web and the Agent API with your own UI.
- Choose by need: quick branded chat, customer service with handoff, or fully custom.
- A custom React panel needs a backend proxy, consent, limits, error states and a human escape hatch.
- Keep agent actions least-privilege and escalate sensitive cases.
- Never put secrets in the browser.

## Where to go next

- Read [Agent API: talk to agents from your own app](/articles/agent-api-custom-client/) for the backend this panel uses.
- Read [Agentforce channels overview](/articles/agentforce-channels-overview/) to compare every channel.
- Read [React fundamentals from zero to hero](/articles/react-fundamentals-zero-to-hero/) for the React basics used here.
