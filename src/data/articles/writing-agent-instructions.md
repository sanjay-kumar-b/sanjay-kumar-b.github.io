---
title: "Writing Instructions for AI Agents: Patterns That Work"
description: "Prompt-writing patterns for agent instructions: role, scope, steps, data rules and refusals, with before and after samples and a tested instruction checker."
category: agentforce
tags: [Prompt Builder, Agentforce, Prompt Engineering]
publishedAt: 2026-11-02
updatedAt: 2026-11-15
cover: /images/covers/writing-agent-instructions.jpg
sources:
  - title: "Prompt Builder and Einstein generative AI (Salesforce Developers)"
    url: "https://developer.salesforce.com/docs/einstein/genai/overview"
  - title: "Legacy Guide: Agentforce Reasoning, Subagents, Instructions, and Actions"
    url: "https://www.salesforce.com/agentforce/legacy-guide/"
---

> **Terminology update (2026):** Salesforce renamed "topics" to **subagents** and "Topic Selector" to **Agent Router** (as of April 2026). Where this article says "topic", read "subagent". The concepts are unchanged.

Good instructions are specific, short and testable. Whether you write them for an agent subagent or a prompt template, the same patterns help. This article gives you a template, a before and after, and two small tools you can run: a checker that flags weak instructions, and a test harness that scores recorded agent replies against rules.

## The business scenario

Ridgeway Bank (a fictional bank) has a service agent that answers questions about card delivery. Early testers report that it sometimes quotes delivery dates it invented, discusses fees it should not, and rambles for six paragraphs. The team wants instructions that fix those three problems, and a repeatable way to prove the fixes work after every wording change.

## Before you start: setup

### In Salesforce

1. Use a sandbox with Agentforce and, if you want to reuse text, Prompt Builder available. Never edit live instructions in production first.
2. Have the agent or prompt template open in its builder so you can paste the instructions and preview replies. Menu names change between releases, so follow the current documentation.
3. Make sure the agent has an action that returns the facts it may state, such as a card delivery lookup. Without a data source, even perfect instructions cannot stop invented facts.

### In the external system

1. Create a plain text file for each set of instructions in your Git repository, for example `agent/instructions/card-delivery.md`, so changes are reviewed like code.
2. Install Node 20 or newer to run the checker and harness.
3. Write 20 to 30 realistic test questions, including ones the agent should refuse. Save them in `agent/tests/cases.json`.

## How it works

Use the same six-part pattern every time:

1. **Role and goal:** one sentence.
2. **Scope:** what is in and what is out.
3. **Steps:** the order of work, as a short numbered list.
4. **Data rules:** where facts must come from, and what to do when data is missing.
5. **Tone and format:** length, style, structure.
6. **Refusals and escalation:** exactly when to stop.

Tips that apply everywhere:

- **Use positive and negative instructions together.** Say what to do and what to avoid.
- **Give one example** of a good answer when format matters.
- **Avoid contradictions.** Re-read for rules that conflict.
- **Keep it short.** Long blocks dilute the important rules.
- **Change one thing at a time** and re-run your tests to see the effect.

## Basic example

Before:

> Help customers with their orders and be nice.

This is vague. The agent has to guess what "help" includes.

After:

> You help customers check the status of an existing order.
> 1. Ask for the order number if it was not given.
> 2. Look up the order with the order-status action.
> 3. Reply with the status and expected delivery date in two sentences or fewer.
>
> Use only data returned by the action. If no order is found, say so and offer to connect the customer to a person.
> Do not discuss refunds, pricing or other customers' orders; tell the customer you will transfer them.

Every sentence either tells the agent what to do, where facts come from, or when to stop. You can test each one.

## Advanced end-to-end example

First, the improved instructions for Ridgeway's card delivery agent:

**agent/instructions/card-delivery.md**

```markdown
You help Ridgeway Bank customers find out where their replacement card is.

Scope: delivery status of a card that has already been ordered. Nothing else.

Steps:
1. Ask for the last four digits of the card and the postcode if they were not given.
2. Call the Get Card Delivery action with both values.
3. Reply in two sentences or fewer: the delivery status and the expected date.

Data rules:
- State only the status and date returned by the action.
- If the action returns no match, say you could not find a card with those details and offer to transfer the customer to a person.
- Never guess or estimate a date.

Do not discuss fees, card limits, fraud or account balances. For those, say you will transfer the customer to a person.
Do not repeat the full card number or any personal details back to the customer.
```

**agent/tools/instruction-check.mjs** flags weak spots before you even preview the agent. It is a helper written for this article.

```javascript
import { readFile } from 'node:fs/promises';

const VAGUE = [/be (helpful|nice|friendly)/i, /do your best/i, /as appropriate/i, /use common sense/i];

export function check(text) {
  const findings = [];
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean).length;

  if (words > 350) {
    findings.push(`Long (${words} words). Long blocks dilute the key rules; trim or split.`);
  }
  if (!/^you (help|answer|assist|handle)/i.test(lines[0] ?? '')) {
    findings.push('Start with one sentence that says what the agent does ("You help ...").');
  }
  if (!/scope/i.test(text)) {
    findings.push('No scope statement. Say what is in and out.');
  }
  if (!lines.some(l => /^\d+\./.test(l))) {
    findings.push('No numbered steps. Give the order of work.');
  }
  if (!/(only|never guess|never estimate)/i.test(text)) {
    findings.push('No data rule. Say where facts must come from and forbid guessing.');
  }
  if (!/\bdo not\b|\bnever\b/i.test(text)) {
    findings.push('No negative rule. Say what to avoid.');
  }
  if (!/(transfer|escalate|person|human)/i.test(text)) {
    findings.push('No escalation rule. Say when to hand over to a person.');
  }
  if (!/(sentence|word|bullet|paragraph)/i.test(text)) {
    findings.push('No length or format rule.');
  }
  for (const rx of VAGUE) {
    if (rx.test(text)) {
      findings.push(`Vague wording matched ${rx}. Replace it with a concrete behaviour.`);
    }
  }
  // A simple contradiction check: "always X" and "never X" on the same verb phrase.
  const always = [...text.matchAll(/always ([a-z ]{3,30})/gi)].map(m => m[1].trim().toLowerCase());
  for (const phrase of always) {
    if (new RegExp(`never ${phrase}`, 'i').test(text)) {
      findings.push(`Contradiction: both "always ${phrase}" and "never ${phrase}".`);
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const text = await readFile(process.argv[2], 'utf8');
  const findings = check(text);
  findings.forEach(f => console.log('- ' + f));
  console.log(findings.length ? `${findings.length} finding(s).` : 'No findings.');
  process.exit(findings.length ? 1 : 0);
}
```

**agent/tests/cases.json** pairs each test question with rules the reply must meet.

```json
[
  {
    "id": "status-with-details",
    "question": "Card ending 4821, postcode SW1A 1AA, where is it?",
    "mustInclude": ["expected"],
    "mustNotInclude": ["fee", "balance"],
    "maxSentences": 2
  },
  {
    "id": "asks-for-missing-details",
    "question": "Where is my new card?",
    "mustInclude": ["last four", "postcode"],
    "maxSentences": 3
  },
  {
    "id": "refuses-fees",
    "question": "Why was I charged a fee for the replacement?",
    "mustInclude": ["transfer"],
    "mustNotInclude": ["fee is", "you were charged"],
    "maxSentences": 2
  },
  {
    "id": "no-invented-date",
    "question": "Card 9999, postcode ZZ1 1ZZ, when will it come?",
    "mustInclude": ["could not find"],
    "mustNotInclude": ["tomorrow", "next week"],
    "maxSentences": 2
  }
]
```

**agent/tools/score.mjs** scores recorded replies (copied from the builder's preview or an exported test run) against those rules.

```javascript
import { readFile } from 'node:fs/promises';

export function countSentences(text) {
  return text.split(/[.!?]+(?:\s|$)/).filter(s => s.trim().length > 0).length;
}

export function scoreReply(testCase, reply) {
  const failures = [];
  const lower = reply.toLowerCase();
  for (const phrase of testCase.mustInclude ?? []) {
    if (!lower.includes(phrase.toLowerCase())) {
      failures.push(`missing "${phrase}"`);
    }
  }
  for (const phrase of testCase.mustNotInclude ?? []) {
    if (lower.includes(phrase.toLowerCase())) {
      failures.push(`contains forbidden "${phrase}"`);
    }
  }
  if (testCase.maxSentences && countSentences(reply) > testCase.maxSentences) {
    failures.push(`too long (${countSentences(reply)} sentences, max ${testCase.maxSentences})`);
  }
  return { id: testCase.id, pass: failures.length === 0, failures };
}

export function scoreAll(cases, replies) {
  return cases.map(c => scoreReply(c, replies[c.id] ?? ''));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cases = JSON.parse(await readFile('agent/tests/cases.json', 'utf8'));
  const replies = JSON.parse(await readFile(process.argv[2], 'utf8'));
  const results = scoreAll(cases, replies);
  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} ${r.id} ${r.failures.join('; ')}`);
  }
  const failed = results.filter(r => !r.pass).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
}
```

**agent/tools/tools.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { check } from './instruction-check.mjs';
import { scoreReply, countSentences } from './score.mjs';

const vague = 'Help customers and be nice.';

test('the vague example gets many findings', () => {
  const findings = check(vague);
  assert.ok(findings.length >= 5);
  assert.ok(findings.some(f => f.includes('Vague wording')));
});

test('a complete instruction block passes', () => {
  const good = [
    'You help customers find a card delivery.',
    'Scope: delivery status only.',
    '1. Ask for the last four digits.',
    '2. Call the action.',
    'Use only data returned by the action. Never guess a date.',
    'Reply in two sentences.',
    'Do not discuss fees. Transfer the customer to a person for those.'
  ].join('\n');
  assert.deepEqual(check(good), []);
});

test('always and never on the same phrase is a contradiction', () => {
  const text = 'You help.\nAlways offer a discount.\nNever offer a discount.';
  assert.ok(check(text).some(f => f.startsWith('Contradiction')));
});

test('sentence counting', () => {
  assert.equal(countSentences('One. Two! Three?'), 3);
});

test('a reply fails when it breaks a rule', () => {
  const tc = { id: 'x', mustInclude: ['transfer'], mustNotInclude: ['fee is'], maxSentences: 2 };
  const res = scoreReply(tc, 'The fee is 5 pounds. It is charged monthly. I hope that helps.');
  assert.equal(res.pass, false);
  assert.equal(res.failures.length, 3);
});

test('a good reply passes', () => {
  const tc = { id: 'x', mustInclude: ['transfer'], maxSentences: 2 };
  assert.equal(scoreReply(tc, 'I will transfer you to a person for that.').pass, true);
});
```

Run everything:

```bash
node --test agent/tools
node agent/tools/instruction-check.mjs agent/instructions/card-delivery.md
node agent/tools/score.mjs agent/tests/replies.json
```

## What happens behind the scenes

At run time, the instructions are text added to the model's context along with the conversation and the descriptions of the available actions. The model predicts a reply that fits all of it. That has two practical consequences. First, rules compete for attention, so a short block of clear rules works better than a long one with the key rule buried in the middle. Second, the model is probabilistic: the same question can produce slightly different answers, so one successful preview proves little. That is why the harness uses many cases and checks properties (must include, must not include, length) instead of exact wording.

The checker catches structural problems cheaply before you spend preview time. The scorer turns "it seems better" into a number you can compare between versions. Neither replaces testing in the real builder, and neither can judge tone; keep a human read of a sample of replies in your routine.

## Test it and verify

1. Run `node --test agent/tools` and confirm all six tests pass.
2. Run the checker on the "Before" text and confirm it reports several findings. Run it on `card-delivery.md` and confirm it reports none.
3. Paste the instructions into your agent in a sandbox and ask each question from `cases.json` in the preview.
4. Save the replies as `agent/tests/replies.json` keyed by case id and run the scorer.
5. Change one sentence in the instructions, repeat, and compare scores. Keep the change only if the score does not drop.
6. Commit the instructions, the cases and the score, and describe the change in the pull request.

## Common mistakes and fixes

- **"Be helpful" style instructions.** They give the agent nothing to act on. Say what to do.
- **Only positive rules.** Add what to avoid and when to stop.
- **Facts in the instructions.** Prices and policies go stale. Let an action return them and say "use only data returned".
- **Contradictions.** Two rules that conflict make behaviour unpredictable. Re-read the whole block after each edit.
- **Testing with one question.** Use a set that includes refusals and missing-data cases.
- **Changing many things at once.** You cannot tell which edit helped. Change one thing and re-run.

## Key takeaways

- Use the six-part pattern: role, scope, steps, data rules, format, refusals.
- Pair positive and negative rules, and keep the block short.
- Facts should come from actions, with an explicit rule against guessing.
- Treat instructions as code: version them, review them and test them.
- Score replies against rules across many cases, not by one good preview.

## Where to go next

- Read [Agentforce basics: topics, instructions and actions](/articles/agentforce-agent-actions-basics/) for the design mental model.
- Read [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/) for safety and test strategy.
- Read [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) to build the actions the instructions rely on.
