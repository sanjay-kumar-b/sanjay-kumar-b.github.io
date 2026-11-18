---
title: "Agentforce Basics: Thinking in Topics, Instructions and Actions"
description: "A mental model for designing an Agentforce agent, with a worked order-status design, a design-spec linter you can run, and a read-only Apex action."
category: agentforce
tags: [Agentforce, Agent Actions, Prompt Builder]
publishedAt: 2026-10-31
updatedAt: 2026-11-15
cover: /images/covers/agentforce-agent-actions-basics.jpg
sources:
  - title: "Legacy Guide: Agentforce Reasoning, Subagents, Instructions, and Actions"
    url: "https://www.salesforce.com/agentforce/legacy-guide/"
  - title: "Best Practices for Building Agentforce Apex Actions"
    url: "https://developer.salesforce.com/blogs/2025/07/best-practices-for-building-agentforce-apex-actions"
---

> **Terminology update (2026):** Salesforce renamed "topics" to **subagents** and "Topic Selector" to **Agent Router** (as of April 2026). Where this article says "topic", read "subagent". The concepts are unchanged.

Before building your first agent, it helps to have a clear mental model. Agentforce agents are organised around three ideas: **topics** (now subagents), **instructions** and **actions**. This article explains how to think about each one, and gives you a plain design spec plus a small checker so you can review a design before you open any builder.

> Agentforce is changing quickly. This article describes design concepts and deliberately avoids menu paths, limits and release-specific details that I have not verified. The code here is ordinary Apex and Node that you can run yourself. Check the current Salesforce documentation for exact setup steps.

## The business scenario

Pinecrest Outfitters (a fictional retailer) wants an agent that tells customers where their order is. Before anyone configures anything, the team wants a written design: what the agent will handle, how it should behave, and exactly which actions it may run. They also want a way to catch common design mistakes, such as one huge topic or an action that changes data before the conversation has been tested.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox where Agentforce is available. Never design and test in production.
2. Create a custom object `Order__c` with fields `Status__c` (picklist: Processing, Shipped, Delivered), `Expected_Delivery__c` (date) and `Contact_Email__c` (email). Create two test records.
3. Create a permission set that grants read access to `Order__c` and access to the Apex class `OrderStatusLookup`. The agent's user needs it. Check the current documentation for how the agent user is created in your release.
4. Verify in the current Agentforce documentation which license your org needs for the features you plan to use.

### In the external system

None is required for this article. If order data lives elsewhere, the action later calls it through a Named Credential, as in the callouts articles. Node 20 or newer is needed to run the design checker.

## How it works

The three building blocks:

- **Topic (subagent):** a category of job the agent can handle, such as "Order status" or "Returns". It tells the agent when it is in scope.
- **Instructions:** plain-language guidance inside a topic describing how the agent should behave, what to ask for and what to avoid.
- **Actions:** the things the agent can actually do, for example looking up a record, running a Flow or calling Apex. Actions are what turn a conversation into a result.

Design tips:

1. **Keep topics narrow.** One clear job per topic makes it easier for the agent to choose correctly and easier for you to test.
2. **Write instructions like you would for a new colleague.** Be specific about what to do, and also what not to do.
3. **Give actions clear names and descriptions.** The agent relies on them to decide which action fits the request.
4. **Start with read-only actions.** Add actions that change data only after you have tested the conversation flow.

## Basic example

A conceptual "Order status" topic:

- **Scope:** customers asking where an order is.
- **Instructions:** ask for the order number if it was not provided. Never reveal other customers' data. If the order cannot be found, offer to hand off to a person.
- **Action:** look up an order by number and return its status.

Written as a design spec file, so it can be reviewed and versioned:

```json
{
  "agent": "Pinecrest Helper",
  "topics": [
    {
      "name": "Order status",
      "scope": "Customers asking where an existing order is.",
      "instructions": [
        "Ask for the order number and the email on the order if either is missing.",
        "Use only data returned by the Get Order Status action.",
        "If no order matches, say so and offer to connect the customer to a person.",
        "Do not discuss refunds, pricing or other customers' orders."
      ],
      "actions": [
        {
          "name": "Get Order Status",
          "description": "Returns the status and expected delivery date for one order number and email.",
          "writesData": false
        }
      ]
    }
  ]
}
```

## Advanced end-to-end example

**design/spec-linter.mjs** checks a design for the mistakes in the "common mistakes" list below. It is a helper written for this article, not a Salesforce tool.

```javascript
import { readFile } from 'node:fs/promises';

const VAGUE = [/be helpful/i, /be nice/i, /do your best/i, /as needed/i, /use your judg(e)?ment/i];
const MAX_ACTIONS_PER_TOPIC = 15;

export function lint(spec) {
  const findings = [];
  const topics = spec.topics ?? [];
  if (topics.length === 0) {
    findings.push('No topics defined.');
  }

  for (const topic of topics) {
    const where = `Topic "${topic.name}"`;
    if (!topic.scope || topic.scope.length < 20) {
      findings.push(`${where}: scope is missing or too short to be useful.`);
    }
    if (/ and /i.test(topic.name) || /\b(everything|anything|all)\b/i.test(topic.scope ?? '')) {
      findings.push(`${where}: looks too broad. One topic, one job.`);
    }

    const instructions = topic.instructions ?? [];
    if (instructions.length < 3) {
      findings.push(`${where}: fewer than 3 instructions; say what to ask, what to use and what to refuse.`);
    }
    for (const line of instructions) {
      if (VAGUE.some(rx => rx.test(line))) {
        findings.push(`${where}: vague instruction "${line}".`);
      }
    }
    if (!instructions.some(line => /\b(do not|never|don't)\b/i.test(line))) {
      findings.push(`${where}: no "do not" rule. Say what to avoid as well as what to do.`);
    }
    if (!instructions.some(line => /\b(person|human|agent|escalat|transfer)\b/i.test(line))) {
      findings.push(`${where}: no handoff rule for when the agent cannot help.`);
    }

    const actions = topic.actions ?? [];
    if (actions.length === 0) {
      findings.push(`${where}: no actions; the agent can talk but cannot do anything.`);
    }
    if (actions.length > MAX_ACTIONS_PER_TOPIC) {
      findings.push(`${where}: ${actions.length} actions; guidance suggests keeping it to about ${MAX_ACTIONS_PER_TOPIC}.`);
    }
    for (const action of actions) {
      if (!action.description || action.description.length < 20) {
        findings.push(`${where}: action "${action.name}" needs a clear description.`);
      }
      if (/_v\d|svc|ord[A-Z]/.test(action.name)) {
        findings.push(`${where}: action "${action.name}" has a technical name; use plain language.`);
      }
      if (action.writesData && !instructions.some(l => /confirm/i.test(l))) {
        findings.push(`${where}: action "${action.name}" changes data but no instruction asks for confirmation.`);
      }
    }
  }
  return findings;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const spec = JSON.parse(await readFile(process.argv[2] ?? 'design/agent.json', 'utf8'));
  const findings = lint(spec);
  findings.forEach(f => console.log('- ' + f));
  console.log(findings.length === 0 ? 'Design looks sound.' : `${findings.length} finding(s).`);
  process.exit(findings.length === 0 ? 0 : 1);
}
```

**design/spec-linter.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { lint } from './spec-linter.mjs';

const good = {
  topics: [{
    name: 'Order status',
    scope: 'Customers asking where an existing order is.',
    instructions: [
      'Ask for the order number if it was not given.',
      'Use only data returned by the Get Order Status action.',
      'Do not discuss refunds or other customers orders.',
      'If no order matches, offer to transfer to a person.'
    ],
    actions: [{ name: 'Get Order Status', description: 'Returns status and delivery date for one order.', writesData: false }]
  }]
};

test('a well formed topic has no findings', () => {
  assert.deepEqual(lint(good), []);
});

test('vague instructions are flagged', () => {
  const bad = structuredClone(good);
  bad.topics[0].instructions[0] = 'Be helpful.';
  assert.ok(lint(bad).some(f => f.includes('vague')));
});

test('a topic that does everything is flagged as too broad', () => {
  const bad = structuredClone(good);
  bad.topics[0].scope = 'Handle everything customers ask about orders.';
  assert.ok(lint(bad).some(f => f.includes('too broad')));
});

test('write actions need a confirmation instruction', () => {
  const bad = structuredClone(good);
  bad.topics[0].actions.push({ name: 'Cancel Order', description: 'Cancels one order for the customer.', writesData: true });
  assert.ok(lint(bad).some(f => f.includes('confirmation')));
});

test('missing handoff rule is flagged', () => {
  const bad = structuredClone(good);
  bad.topics[0].instructions = bad.topics[0].instructions.slice(0, 3);
  assert.ok(lint(bad).some(f => f.includes('handoff')));
});
```

**force-app/main/default/classes/OrderStatusLookup.cls** is the read-only action the design names.

```apex
public with sharing class OrderStatusLookup {

    public class Request {
        @InvocableVariable(label='Order Number' description='Customer order number, for example ORD-1001' required=true)
        public String orderNumber;
        @InvocableVariable(label='Email' description='Email address on the order' required=true)
        public String email;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Current order status')
        public String status;
        @InvocableVariable(label='Expected Delivery' description='Expected delivery date, ISO format')
        public String expectedDelivery;
        @InvocableVariable(label='Error' description='Set when the order could not be matched')
        public String errorMessage;
    }

    @InvocableMethod(label='Get Order Status' description='Returns status and expected delivery for one order number and email')
    public static List<Response> run(List<Request> requests) {
        Set<String> numbers = new Set<String>();
        for (Request r : requests) {
            numbers.add(r.orderNumber);
        }
        Map<String, Order__c> byNumber = new Map<String, Order__c>();
        for (Order__c o : [
            SELECT Name, Status__c, Expected_Delivery__c, Contact_Email__c
            FROM Order__c WHERE Name IN :numbers WITH USER_MODE
        ]) {
            byNumber.put(o.Name, o);
        }

        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response res = new Response();
            Order__c o = byNumber.get(r.orderNumber);
            // Same message for "no such order" and "wrong email": never confirm an order exists.
            if (o == null || o.Contact_Email__c == null || !o.Contact_Email__c.equalsIgnoreCase(r.email)) {
                res.errorMessage = 'No order found for that order number and email.';
            } else {
                res.status = o.Status__c;
                res.expectedDelivery = o.Expected_Delivery__c == null ? null : String.valueOf(o.Expected_Delivery__c);
            }
            out.add(res);
        }
        return out;
    }
}
```

**force-app/main/default/classes/OrderStatusLookupTest.cls**

```apex
@IsTest
private class OrderStatusLookupTest {

    @TestSetup
    static void setup() {
        insert new Order__c(Name = 'ORD-1001', Status__c = 'Shipped',
            Expected_Delivery__c = Date.today().addDays(2), Contact_Email__c = 'rao@example.com');
    }

    private static OrderStatusLookup.Request req(String number, String email) {
        OrderStatusLookup.Request r = new OrderStatusLookup.Request();
        r.orderNumber = number;
        r.email = email;
        return r;
    }

    @IsTest
    static void returnsStatusWhenEmailMatches() {
        OrderStatusLookup.Response res = OrderStatusLookup.run(new List<OrderStatusLookup.Request>{ req('ORD-1001', 'RAO@example.com') })[0];
        System.assertEquals('Shipped', res.status);
        System.assertEquals(null, res.errorMessage);
    }

    @IsTest
    static void wrongEmailAndUnknownOrderLookTheSame() {
        List<OrderStatusLookup.Response> res = OrderStatusLookup.run(new List<OrderStatusLookup.Request>{
            req('ORD-1001', 'other@example.com'), req('ORD-9999', 'rao@example.com')
        });
        System.assertEquals(res[0].errorMessage, res[1].errorMessage);
        System.assertEquals(null, res[0].status);
    }

    @IsTest
    static void handlesManyRequestsWithOneQuery() {
        List<OrderStatusLookup.Request> many = new List<OrderStatusLookup.Request>();
        for (Integer i = 0; i < 50; i++) {
            many.add(req('ORD-1001', 'rao@example.com'));
        }
        Test.startTest();
        List<OrderStatusLookup.Response> out = OrderStatusLookup.run(many);
        Test.stopTest();
        System.assertEquals(50, out.size());
        System.assertEquals(1, Limits.getQueries());
    }
}
```

Run the linter on your design:

```bash
node --test design
node design/spec-linter.mjs design/agent.json
```

## What happens behind the scenes

When a customer sends a message, the agent's reasoning engine reads the conversation and picks the subagent whose scope fits best. Inside it, the model reads the instructions and the list of available actions, each with its name, description and input descriptions. It decides whether to ask a question, call an action or answer. If it calls an action, the platform runs your Apex or Flow in the agent's user context, returns the output, and the model composes the reply using only what it got back.

That is why descriptions matter so much: for the model they are the documentation. It is also why deterministic checks, such as comparing the email to the order, belong in code and not in instructions. A model can be talked around; an `if` statement cannot. And the lookup returns one identical message for "no such order" and "wrong email", so the agent cannot be used to discover which order numbers exist.

## Test it and verify

1. Run `node --test design` and confirm five passing tests.
2. Run the linter on `design/agent.json` and fix every finding. Then make one deliberate mistake, such as "Be helpful.", and confirm it is caught.
3. Deploy the object, class and permission set to a sandbox and run `OrderStatusLookupTest`.
4. Build the agent in the current builder following the official documentation, with one subagent and one action.
5. In the builder's preview, ask: "where's my order", "ORD-1001 status?" (without email), and a question about refunds. Confirm the agent asks for the email, answers correctly with it, and declines the refund question.
6. Check the preview trace to see which action ran and with what inputs.

## Common mistakes and fixes

- **Putting every responsibility into one broad topic.** Split it; the agent chooses better and tests stay simple.
- **Vague instructions such as "be helpful".** Replace them with specific do and do-not rules.
- **Giving write access too early.** Ship read-only first and add writes after testing.
- **Skipping off-topic tests.** Ask questions the agent should refuse and confirm that it does.
- **Doing validation in instructions.** Put it in Apex or Flow where it is deterministic.
- **Technical action names.** Use plain names and descriptions the model can understand.

## Key takeaways

- Topics (subagents) define scope, instructions define behaviour, actions do the work.
- Narrow and specific beats broad and vague.
- Write the design down and lint it before building.
- Enforce rules in code, and return identical messages for "not found" and "not yours".
- Verify setup details in the official documentation, since the product evolves quickly.

## Where to go next

- Read [Agentforce from zero](/articles/agentforce-zero-to-first-agent/) to build a first agent end to end.
- Read [Writing instructions for AI agents](/articles/writing-agent-instructions/) for patterns that work.
- Read [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) for more action design.
