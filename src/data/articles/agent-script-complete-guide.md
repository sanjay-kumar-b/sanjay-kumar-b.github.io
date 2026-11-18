---
title: "Agent Script Complete Guide: Hybrid Reasoning for Predictable Agents"
description: "Learn Agent Script, Agentforce's language for mixing LLM reasoning with deterministic logic, with annotated examples and a runnable model of its flow of control."
category: agentforce
tags: [Agentforce, Agent Script, Hybrid Reasoning, Advanced]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/agent-script-complete-guide.jpg
sources:
  - title: "Introducing Hybrid Reasoning with Agent Script"
    url: "https://developer.salesforce.com/blogs/2025/10/introducing-hybrid-reasoning-with-agent-script"
  - title: "Agent Script Reference"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/ascript-reference.html"
  - title: "Agent Script Flow of Control"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/ascript-flow.html"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

**Agent Script** is a human-readable, declarative language for writing agents on the Agentforce platform. It is compiled into an Agent Graph consumed by the Atlas reasoning engine. The idea is **hybrid reasoning**: strict, sequential logic for steps that must be exact (refunds, loan applications) while the language model still interprets natural language.

Status: introduced in a pilot in late 2025. The Summer '26 developer guide says **Agentforce Builder and Agent Script are generally available** and that Agent Script is open source. You can author in Agentforce Builder or in your IDE with Agentforce Vibes.

**A note on accuracy.** Agent Script is new and its syntax is defined by the official reference. Every Agent Script snippet in this article is limited to constructs shown in the official pages listed under Sources. I do not reproduce the `config`, `system` or `variables` blocks, because the exact syntax must come from the reference, and I did not run any of this code in an Agentforce org. The Node program is different: it is a small model of the *flow of control* written for this article, so you can experiment with the ideas. It is not an Agent Script interpreter.

## The business scenario

Cobalt Credit Union (a fictional lender) has an agent that helps customers with order-like requests, in this case a card replacement. The rules are strict: the delivery date must come from the system, a late replacement must always start with an apology, and after five turns without resolution the agent must escalate. Compliance says these rules must hold every time, so they cannot be left to the model's mood.

## Before you start: setup

### In Salesforce

1. Use a sandbox or Developer Edition org where Agentforce Builder is available. Check the current documentation for your release.
2. Create or reuse the actions the script will call. For this article assume two Apex or Flow actions exist: `get_delivery_date` (input `order_ID`, output `delivery_date`) and `check_if_late` (inputs `order_ID` and `delivery_date`, output `is_late`). The actions article shows how to build them.
3. Give the agent's user the permissions those actions need, and nothing broader.
4. Decide where you will author: Agentforce Builder, or your IDE with Agentforce Vibes for version control.

### In the external system

1. Keep the script files in Git so changes are reviewed.
2. Install Node 20 or newer if you want to run the flow-of-control model below.
3. Write test conversations for every branch, including the escalation path.

## How it works

Building blocks, from the reference:

| Block | Purpose |
|---|---|
| `config` | Agent configuration |
| `system` | Agent-wide `instructions` and `messages` (welcome, error) |
| `variables` | Global agent variables (can be `linked` or `mutable`) |
| `language` | Supported languages |
| `connection` | External connections (for example Enhanced Chat messaging) |
| `start_agent` | Entry point: classification and routing |
| `subagent` | One job: description, reasoning instructions, actions (the older `topic` keyword is deprecated) |
| `reasoning` | `instructions` and `actions` given to the LLM |
| `after_reasoning` | Logic that runs after the reasoning loop |

Syntax: `#` comment, `->` starts logic instructions, `|` starts prompt text, `{!expression}` inserts a variable into prompt text, `run`, `set`, `with`, `if`/`else`, `transition to`, `available when` (conditional tools), references like `@actions.`, `@outputs.`, `@variables.`, `@subagent.` and `@utils.` (`escalate`, `setVariables`, `transition to`). Operators include `==`, `!=`, `<`, `>` and `is None`.

**Flow of control.** Every request enters at `start_agent`, which sets initial values and routes to a subagent. Agentforce builds **one LLM prompt** from the subagent's reasoning instructions by processing them top to bottom: resolving variables, `if` conditions, `run` actions and text. Only the resolved text reaches the model.

## Basic example

This is the official example from the flow-of-control page:

```text
subagent Order_Management:
    description: "Handles order inquiries."
    reasoning:
        instructions:->
            set @variables.num_turns = @variables.num_turns + 1
            run @actions.get_delivery_date
                with order_ID=@variables.order_ID
                set @variables.updated_delivery_date=@outputs.delivery_date

            | Tell the user that the expected delivery date for order number {!@variables.order_ID} is {!@variables.updated_delivery_date}

            run @actions.check_if_late
                with order_ID=@variables.order_ID
                with delivery_date=@variables.updated_delivery_date
                set @variables.is_late = @outputs.is_late

            if @variables.is_late == True:
                | Apologize to the customer for the delay in receiving their order.
    after_reasoning:
       if @variables.num_turns > 5:
           transition to @subagent.escalate_order
```

What happens: the action runs while the prompt is built, its output is stored with `set`, the apology line is included only if `is_late` is true, and `after_reasoning` decides on escalation by turn count, a **deterministic** rule the model cannot skip.

A **transition** is one-way: the prompt built so far is discarded and the new subagent is read top to bottom. After it finishes, the agent waits for the next message and returns to `start_agent`. A transition can be attached to a reasoning action:

```text
reasoning:
    actions:
        go_to_account_help: @utils.transition to @subagent.account_help
            description: "When a user needs help with account access"
```

Transitions can also appear in instructions or in `before_reasoning` and `after_reasoning`.

## Advanced end-to-end example

A good way to understand hybrid reasoning is to model it. The program below mimics the *order of evaluation* from the flow-of-control page: run actions and conditions in order, build the prompt text, then apply after-reasoning rules. The agent definition is plain JavaScript data, so you can change a rule and see the effect.

**model/flow.mjs**

```javascript
// A model of Agent Script's flow of control, for learning. Not an Agent Script interpreter.
export function runTurn(agent, state, actions) {
  const subagent = agent.subagents[state.current];
  const prompt = [];
  const vars = state.variables;

  // 1. Logic steps run top to bottom while the prompt is being built.
  for (const step of subagent.steps) {
    if (step.type === 'set') {
      vars[step.name] = step.compute(vars);
    } else if (step.type === 'run') {
      const outputs = actions[step.action](step.with(vars));
      for (const [target, outputName] of Object.entries(step.set)) {
        vars[target] = outputs[outputName];
      }
    } else if (step.type === 'text') {
      prompt.push(step.text(vars));
    } else if (step.type === 'if') {
      if (step.condition(vars)) {
        prompt.push(step.text(vars));
      }
    }
  }

  // 2. After reasoning: deterministic rules that the model cannot skip.
  let transitionedTo = null;
  for (const rule of subagent.afterReasoning ?? []) {
    if (rule.condition(vars)) {
      transitionedTo = rule.transitionTo;
      break;
    }
  }
  if (transitionedTo) {
    state.current = transitionedTo; // a one-way move
  }
  return { prompt: prompt.join('\n'), transitionedTo };
}

export function newState(startSubagent) {
  return { current: startSubagent, variables: { num_turns: 0, order_ID: null, is_late: false } };
}
```

**model/cobalt.mjs** defines the Cobalt agent in that model.

```javascript
export const cobalt = {
  subagents: {
    Order_Management: {
      steps: [
        { type: 'set', name: 'num_turns', compute: v => v.num_turns + 1 },
        {
          type: 'run', action: 'get_delivery_date',
          with: v => ({ order_ID: v.order_ID }),
          set: { updated_delivery_date: 'delivery_date' }
        },
        { type: 'text', text: v => `Tell the user the expected delivery date for order ${v.order_ID} is ${v.updated_delivery_date}.` },
        {
          type: 'run', action: 'check_if_late',
          with: v => ({ order_ID: v.order_ID, delivery_date: v.updated_delivery_date }),
          set: { is_late: 'is_late' }
        },
        { type: 'if', condition: v => v.is_late === true, text: () => 'Apologize to the customer for the delay.' }
      ],
      afterReasoning: [
        { condition: v => v.num_turns > 5, transitionTo: 'escalate_order' }
      ]
    },
    escalate_order: {
      steps: [{ type: 'text', text: () => 'Explain that you are transferring the customer to a person.' }]
    }
  }
};
```

**model/flow.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { runTurn, newState } from './flow.mjs';
import { cobalt } from './cobalt.mjs';

function actions({ late }) {
  return {
    get_delivery_date: () => ({ delivery_date: '2026-12-01' }),
    check_if_late: () => ({ is_late: late })
  };
}

test('the delivery date comes from the action, not the model', () => {
  const state = newState('Order_Management');
  state.variables.order_ID = 'ORD-7';
  const { prompt } = runTurn(cobalt, state, actions({ late: false }));
  assert.match(prompt, /2026-12-01/);
  assert.doesNotMatch(prompt, /Apologize/);
});

test('a late order adds the apology to the prompt', () => {
  const state = newState('Order_Management');
  state.variables.order_ID = 'ORD-7';
  assert.match(runTurn(cobalt, state, actions({ late: true })).prompt, /Apologize/);
});

test('escalation happens after the fifth turn, deterministically', () => {
  const state = newState('Order_Management');
  state.variables.order_ID = 'ORD-7';
  for (let turn = 1; turn <= 5; turn++) {
    assert.equal(runTurn(cobalt, state, actions({ late: false })).transitionedTo, null);
  }
  const sixth = runTurn(cobalt, state, actions({ late: false }));
  assert.equal(sixth.transitionedTo, 'escalate_order');
  assert.equal(state.current, 'escalate_order');
});

test('after a transition the new subagent builds its own prompt', () => {
  const state = newState('escalate_order');
  const { prompt } = runTurn(cobalt, state, actions({ late: false }));
  assert.match(prompt, /transferring/);
});
```

The reference also describes `available when`, which hides a tool from the model until a condition is met. In the model it can be shown as a simple filter. Add this to `model/flow.mjs`:

```javascript
// Tools the model may see on this turn. A tool with no availableWhen is always visible.
export function visibleTools(subagent, vars) {
  return (subagent.tools ?? [])
    .filter(tool => !tool.availableWhen || tool.availableWhen(vars))
    .map(tool => tool.name);
}
```

And a test that shows why it matters: the refund tool exists only after the identity check passes.

```javascript
import { visibleTools } from './flow.mjs';

test('the refund tool is hidden until identity is verified', () => {
  const subagent = { tools: [
    { name: 'verify_identity' },
    { name: 'issue_refund', availableWhen: v => v.identity_verified === true }
  ]};
  assert.deepEqual(visibleTools(subagent, { identity_verified: false }), ['verify_identity']);
  assert.deepEqual(visibleTools(subagent, { identity_verified: true }), ['verify_identity', 'issue_refund']);
});
```

Run it:

```bash
node --test model
```

## What happens behind the scenes

On every message, Agentforce enters at `start_agent`, which routes to a subagent. For that subagent it walks the reasoning instructions in order. A `run` line calls the action *right then*, before any model call, and stores its outputs; a `|` line adds text to the prompt; an `if` decides whether its lines are included at all. Only the final resolved text is sent to the language model, which writes the reply. That is why the delivery date is trustworthy: the model is told the date, it does not look it up.

After the model finishes, `after_reasoning` runs. Its rules are ordinary code paths: if the turn counter passes five, the transition fires whatever the model said. A transition discards the prompt built so far and reads the next subagent from the top. When that is done, the agent waits for the next message and starts again at `start_agent`.

This is the reason to choose Agent Script. In natural-language-only subagents, you ask the model to follow rules. In Agent Script, you *build* the prompt and the control flow, so rules about order, thresholds and visibility hold every time. The model still does the part it is good at: reading the customer's words and writing a natural reply.

## Test it and verify

1. Run `node --test model` and confirm four passing tests. Change `> 5` to `> 2` in `cobalt.mjs` and see which test fails, to feel how the rule works.
2. In a sandbox, build the two actions and confirm they run alone with test inputs.
3. In Agentforce Builder or your IDE, write the subagent from the basic example using the official reference for the blocks not shown here.
4. Preview a conversation where the order is late and confirm the reply starts with an apology.
5. Preview a long conversation and confirm the escalation happens after the turn limit.
6. Run a test conversation for every branch, including the transition path, and keep them in Git with the script.

## Common mistakes and fixes

- **Putting every rule in script.** Use natural-language subagents first and add script where you need a guarantee.
- **Business rules in prompt text.** Put rules in script or action code, and tone and phrasing in prompt text.
- **Unclear variable names.** Name variables for what they mean and document them.
- **Forgetting that transitions are one-way.** The prompt built so far is discarded, so set anything you need before you transition.
- **Untested branches.** Test every branch, including escalation.
- **Copying syntax from memory.** Check the reference for exact syntax, especially for blocks not shown here.

## Key takeaways

- Agent Script combines deterministic logic with model reasoning, so critical rules always hold.
- The prompt is built top to bottom: actions run, conditions decide what text is included, and only the result reaches the model.
- `after_reasoning` and transitions give you rules the model cannot skip.
- Start with natural-language subagents and add script where needed.
- Keep scripts in version control and test every branch.

## Where to go next

- Read [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) to build the actions a script calls.
- Read [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/) to test the escalation paths.
- Read [Agentforce from zero](/articles/agentforce-zero-to-first-agent/) for the end-to-end build.
