---
title: "Salesforce Flow Types: Screen, Scheduled and Autolaunched Flows with a Flow Linter"
description: "Choose and build screen, scheduled and autolaunched flows, call a flow from Apex, and check flow metadata for loops, fault paths and hard-coded ids."
category: salesforce-administration
tags: [Flow, Automation, Apex, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce Help: Flow Builder"
    url: "https://help.salesforce.com/s/articleView?id=sf.flow.htm"
  - title: "Metadata API Developer Guide: Flow"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_visual_workflow.htm"
---

Flow is Salesforce's main automation tool, and it comes in several types. The type decides **how the flow starts**, **whether a user sees it** and **where it can run**. Picking the wrong type is the most common early mistake. This article explains the types, shows the metadata of two of them, calls a flow from Apex, and adds a small linter that catches the mistakes reviewers keep finding.

> Flow metadata XML is verbose and changes between releases. The XML below follows the structure of Flow metadata, but build your real flows in Flow Builder and retrieve them, rather than writing XML by hand. The linter and the Apex are the parts you can run as they are.

## The business scenario

Juniper Consulting wants three automations. Sales reps need a guided **screen flow** that collects renewal details and creates a Renewal Opportunity. Every night a **scheduled flow** must flag opportunities that are overdue for review. And an **autolaunched flow** must calculate a renewal discount from customer tenure and spend, because three different places (the screen flow, an Apex batch and an Agentforce action) all need the same rule. Finally the platform team wants to stop flows with data operations inside loops from reaching production.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox. Open **Setup, Process Automation Settings** and note the default flow settings. Open **Flows** in Setup to confirm Flow Builder is available.
2. Create the fields used below: a checkbox `Needs_Review__c` on Opportunity, and optionally `Renewal_Discount__c` (Percent) on Opportunity.
3. Make sure the people who run flows have the **Run Flows** permission, or the flow is set to run in a suitable context. A screen flow also needs the user to see the objects and fields it touches, unless it runs in system context.
4. For scheduled flows, remember that they run as the **Automated Process** user or the configured user, so check sharing and field access for that context. Also confirm the number of scheduled runs your edition allows.
5. For Apex that calls a flow, create a DX project, set `"sourceApiVersion": "67.0"` and deploy to a sandbox: `sf project deploy start --source-dir force-app --target-org dev`.
6. Plan versioning. A flow has versions; only one is active. Test a new version as **Draft** before activating it.

### In the external system

None is needed to learn the types. If a flow must call an external service, create a Named Credential and an External Service (or an Apex invocable action) first, and use that action in the flow. Do not paste endpoints or keys into flow elements.

## How it works

| Type | Starts when | Needs a user? | Typical use |
|---|---|---|---|
| **Screen flow** | A user opens it: button, quick action, utility bar, page or Experience site | Yes | Guided data entry, wizards |
| **Record-triggered flow** | A record is created, updated or deleted | No | Field updates, follow-up tasks |
| **Scheduled flow** | On a schedule, for each record that meets criteria | No | Nightly cleanups, reminders |
| **Autolaunched flow** | Called from Apex, another flow, REST, an Agentforce action or a process | No | Reusable logic with inputs and outputs |
| **Platform-event-triggered flow** | A platform event message arrives | No | Reacting to integrations |

The core elements are **variables**, **decisions**, **assignments**, **loops**, **Get Records**, **Create/Update/Delete Records**, **actions** and **subflows**. Every flow runs in a transaction and is subject to the same governor limits as Apex.

Three habits matter most:

1. **Keep data operations out of loops.** Collect records in a collection variable and save once.
2. **Add a fault path** to every element that touches data, so a failure produces a clear outcome.
3. **Make logic reusable** with autolaunched flows and subflows with clear input and output variables.

## Basic example

An autolaunched flow with two inputs and one output. Retrieve this from an org or deploy it as **force-app/main/default/flows/Renewal_Discount.flow-meta.xml**.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Renewal Discount</label>
    <description>Calculates the renewal discount percent from tenure and annual spend.</description>
    <processType>AutoLaunchedFlow</processType>
    <status>Active</status>
    <decisions>
        <name>Which_Discount</name>
        <label>Which Discount</label>
        <locationX>176</locationX>
        <locationY>158</locationY>
        <defaultConnector>
            <targetReference>Set_Zero</targetReference>
        </defaultConnector>
        <defaultConnectorLabel>No discount</defaultConnectorLabel>
        <rules>
            <name>Loyal</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>yearsAsCustomer</leftValueReference>
                <operator>GreaterThanOrEqualTo</operator>
                <rightValue>
                    <numberValue>5.0</numberValue>
                </rightValue>
            </conditions>
            <connector>
                <targetReference>Set_Ten</targetReference>
            </connector>
            <label>Loyal</label>
        </rules>
        <rules>
            <name>Big_Spender</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>annualSpend</leftValueReference>
                <operator>GreaterThanOrEqualTo</operator>
                <rightValue>
                    <numberValue>50000.0</numberValue>
                </rightValue>
            </conditions>
            <connector>
                <targetReference>Set_Five</targetReference>
            </connector>
            <label>Big Spender</label>
        </rules>
    </decisions>
    <assignments>
        <name>Set_Ten</name>
        <label>Set Ten</label>
        <locationX>50</locationX>
        <locationY>278</locationY>
        <assignmentItems>
            <assignToReference>discountPercent</assignToReference>
            <operator>Assign</operator>
            <value>
                <numberValue>10.0</numberValue>
            </value>
        </assignmentItems>
    </assignments>
    <assignments>
        <name>Set_Five</name>
        <label>Set Five</label>
        <locationX>176</locationX>
        <locationY>278</locationY>
        <assignmentItems>
            <assignToReference>discountPercent</assignToReference>
            <operator>Assign</operator>
            <value>
                <numberValue>5.0</numberValue>
            </value>
        </assignmentItems>
    </assignments>
    <assignments>
        <name>Set_Zero</name>
        <label>Set Zero</label>
        <locationX>302</locationX>
        <locationY>278</locationY>
        <assignmentItems>
            <assignToReference>discountPercent</assignToReference>
            <operator>Assign</operator>
            <value>
                <numberValue>0.0</numberValue>
            </value>
        </assignmentItems>
    </assignments>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Which_Discount</targetReference>
        </connector>
    </start>
    <variables>
        <name>yearsAsCustomer</name>
        <dataType>Number</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
        <scale>0</scale>
    </variables>
    <variables>
        <name>annualSpend</name>
        <dataType>Number</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
        <scale>2</scale>
    </variables>
    <variables>
        <name>discountPercent</name>
        <dataType>Number</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>true</isOutput>
        <scale>0</scale>
    </variables>
</Flow>
```

## Advanced end-to-end example

**Calling the flow from Apex**, so batches and services reuse the same rule. **force-app/main/default/classes/RenewalDiscountService.cls**

```apex
public with sharing class RenewalDiscountService {

    public static Decimal discountFor(Integer yearsAsCustomer, Decimal annualSpend) {
        Map<String, Object> inputs = new Map<String, Object>{
            'yearsAsCustomer' => yearsAsCustomer,
            'annualSpend' => annualSpend
        };
        Flow.Interview.Renewal_Discount interview = new Flow.Interview.Renewal_Discount(inputs);
        interview.start();
        Object result = interview.getVariableValue('discountPercent');
        return result == null ? 0 : (Decimal) result;
    }
}
```

**force-app/main/default/classes/RenewalDiscountServiceTest.cls**

```apex
@IsTest
private class RenewalDiscountServiceTest {

    @IsTest
    static void longStandingCustomersGetTenPercent() {
        System.assertEquals(10, RenewalDiscountService.discountFor(6, 100));
    }

    @IsTest
    static void bigSpendersGetFivePercent() {
        System.assertEquals(5, RenewalDiscountService.discountFor(1, 60000));
    }

    @IsTest
    static void everyoneElseGetsNothing() {
        System.assertEquals(0, RenewalDiscountService.discountFor(1, 100));
    }

    @IsTest
    static void tenureWinsWhenBothRulesApply() {
        // Decision rules are evaluated in order, so the first match is used.
        System.assertEquals(10, RenewalDiscountService.discountFor(8, 90000));
    }
}
```

**A scheduled flow** that flags overdue opportunities every night. **force-app/main/default/flows/Flag_Overdue_Opportunities.flow-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Flag Overdue Opportunities</label>
    <description>Nightly: marks open opportunities whose close date has passed.</description>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <recordUpdates>
        <name>Mark_For_Review</name>
        <label>Mark For Review</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <faultConnector>
            <targetReference>Log_Failure</targetReference>
        </faultConnector>
        <inputAssignments>
            <field>Needs_Review__c</field>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </inputAssignments>
        <inputReference>$Record</inputReference>
    </recordUpdates>
    <actionCalls>
        <name>Log_Failure</name>
        <label>Log Failure</label>
        <locationX>440</locationX>
        <locationY>395</locationY>
        <actionName>emailSimple</actionName>
        <actionType>emailSimple</actionType>
        <inputParameters>
            <name>emailAddresses</name>
            <value>
                <stringValue>salesops@example.com</stringValue>
            </value>
        </inputParameters>
        <inputParameters>
            <name>emailSubject</name>
            <value>
                <stringValue>Overdue opportunity flow failed</stringValue>
            </value>
        </inputParameters>
        <inputParameters>
            <name>emailBody</name>
            <value>
                <elementReference>$Flow.FaultMessage</elementReference>
            </value>
        </inputParameters>
    </actionCalls>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Mark_For_Review</targetReference>
        </connector>
        <filterFormula>AND(NOT(IsClosed), CloseDate &lt; TODAY(), NOT(Needs_Review__c))</filterFormula>
        <object>Opportunity</object>
        <schedule>
            <frequency>Daily</frequency>
            <startDate>2026-12-01</startDate>
            <startTime>02:00:00.000Z</startTime>
        </schedule>
        <triggerType>Scheduled</triggerType>
    </start>
</Flow>
```

**A flow linter** that you run in CI before deployment. **tools/flowLint.mjs**

```javascript
// A small, dependency-free linter for Flow metadata XML.
const DML_TAGS = ['recordCreates', 'recordUpdates', 'recordDeletes'];
const QUERY_TAGS = ['recordLookups'];
const ID_PATTERN = /\b(001|003|005|006|00D|00G|012|500)[A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?\b/;

function blocks(xml, tag) {
  const found = [];
  const pattern = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g');
  let match;
  while ((match = pattern.exec(xml)) !== null) {
    found.push(match[1]);
  }
  return found;
}

function nameOf(block) {
  const m = /<name>(.*?)<\/name>/.exec(block);
  return m ? m[1] : null;
}

function connectorTargets(block) {
  const targets = [];
  const pattern = /<(?:connector|defaultConnector|nextValueConnector|noMoreValuesConnector)>\s*<targetReference>(.*?)<\/targetReference>/g;
  let match;
  while ((match = pattern.exec(block)) !== null) {
    targets.push(match[1]);
  }
  return targets;
}

export function parseFlow(xml) {
  const elements = new Map();
  for (const tag of [...DML_TAGS, ...QUERY_TAGS, 'loops', 'decisions', 'assignments', 'screens', 'actionCalls', 'subflows']) {
    for (const block of blocks(xml, tag)) {
      elements.set(nameOf(block), {
        name: nameOf(block),
        tag,
        targets: connectorTargets(block),
        hasFault: block.includes('<faultConnector>'),
        loopBody: tag === 'loops' ? (/<nextValueConnector>\s*<targetReference>(.*?)<\/targetReference>/.exec(block) || [])[1] : null
      });
    }
  }
  return elements;
}

// Names of every element reachable from `start` without leaving the loop.
function loopMembers(elements, loop) {
  const seen = new Set();
  const stack = loop.loopBody ? [loop.loopBody] : [];
  while (stack.length > 0) {
    const name = stack.pop();
    if (name === loop.name || seen.has(name) || !elements.has(name)) {
      continue;
    }
    seen.add(name);
    stack.push(...elements.get(name).targets);
  }
  return seen;
}

export function lintFlow(xml) {
  const problems = [];
  const elements = parseFlow(xml);

  for (const element of elements.values()) {
    if ([...DML_TAGS, 'recordLookups'].includes(element.tag) && !element.hasFault) {
      problems.push({ rule: 'fault-path', element: element.name, message: 'Add a fault path to this data element.' });
    }
  }

  for (const element of elements.values()) {
    if (element.tag !== 'loops') {
      continue;
    }
    for (const member of loopMembers(elements, element)) {
      const inner = elements.get(member);
      if ([...DML_TAGS, ...QUERY_TAGS].includes(inner.tag)) {
        problems.push({
          rule: 'data-in-loop',
          element: inner.name,
          message: `${inner.tag} runs inside loop ${element.name}. Collect records in a collection and save once after the loop.`
        });
      }
    }
  }

  if (ID_PATTERN.test(xml)) {
    problems.push({ rule: 'hardcoded-id', element: null, message: 'A record Id is hard-coded. Use a custom label, custom metadata or a lookup.' });
  }
  if (!/<description>[\s\S]+?<\/description>/.test(xml)) {
    problems.push({ rule: 'description', element: null, message: 'Add a flow description.' });
  }
  return problems;
}

export function formatProblems(problems) {
  return problems.length === 0
    ? 'No problems found.'
    : problems.map(p => `[${p.rule}] ${p.element ? p.element + ': ' : ''}${p.message}`).join('\n');
}
```

**tools/flowLint.test.mjs**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lintFlow, formatProblems } from './flowLint.mjs';

const wrap = body =>
  `<Flow xmlns="http://soap.sforce.com/2006/04/metadata"><description>Test flow</description>${body}</Flow>`;

const cleanFlow = wrap(`
  <recordUpdates><name>Save</name><faultConnector><targetReference>Oops</targetReference></faultConnector></recordUpdates>
  <screens><name>Oops</name></screens>`);

const loopWithUpdate = wrap(`
  <loops><name>Each</name><nextValueConnector><targetReference>Set</targetReference></nextValueConnector></loops>
  <assignments><name>Set</name><connector><targetReference>Save</targetReference></connector></assignments>
  <recordUpdates><name>Save</name><connector><targetReference>Each</targetReference></connector>
    <faultConnector><targetReference>Oops</targetReference></faultConnector></recordUpdates>
  <screens><name>Oops</name></screens>`);

test('a clean flow has no problems', () => {
  assert.deepEqual(lintFlow(cleanFlow), []);
  assert.equal(formatProblems([]), 'No problems found.');
});

test('data elements without a fault path are reported', () => {
  const flow = wrap('<recordCreates><name>Make</name></recordCreates>');
  const problems = lintFlow(flow);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].rule, 'fault-path');
});

test('DML inside a loop is reported', () => {
  const problems = lintFlow(loopWithUpdate);
  assert.ok(problems.some(p => p.rule === 'data-in-loop' && p.element === 'Save'));
});

test('DML after the loop is not reported', () => {
  const flow = wrap(`
    <loops><name>Each</name>
      <nextValueConnector><targetReference>Set</targetReference></nextValueConnector>
      <noMoreValuesConnector><targetReference>Save</targetReference></noMoreValuesConnector></loops>
    <assignments><name>Set</name><connector><targetReference>Each</targetReference></connector></assignments>
    <recordUpdates><name>Save</name><faultConnector><targetReference>Oops</targetReference></faultConnector></recordUpdates>
    <screens><name>Oops</name></screens>`);
  assert.deepEqual(lintFlow(flow), []);
});

test('a hard-coded record id is reported', () => {
  const flow = wrap('<assignments><name>A</name><value>00530000000abcdAAA</value></assignments>');
  assert.ok(lintFlow(flow).some(p => p.rule === 'hardcoded-id'));
});

test('a missing description is reported', () => {
  const problems = lintFlow('<Flow xmlns="http://soap.sforce.com/2006/04/metadata"></Flow>');
  assert.ok(problems.some(p => p.rule === 'description'));
});
```

**tools/lint-flows.mjs** applies it to every flow in the project and sets the exit code.

```javascript
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { lintFlow, formatProblems } from './flowLint.mjs';

const dir = process.argv[2] ?? 'force-app/main/default/flows';
if (!existsSync(dir)) {
  console.log('No flows folder at ' + dir);
  process.exit(0);
}

let failed = false;
for (const file of readdirSync(dir).filter(f => f.endsWith('.flow-meta.xml'))) {
  const problems = lintFlow(readFileSync(join(dir, file), 'utf8'));
  console.log(`${file}\n${formatProblems(problems)}\n`);
  failed = failed || problems.length > 0;
}
process.exit(failed ? 1 : 0);
```

Run everything:

```bash
node --test tools/flowLint.test.mjs
node tools/lint-flows.mjs
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names RenewalDiscountServiceTest --result-format human --wait 10 --target-org dev
```

## What happens behind the scenes

A **screen flow** runs in the user's browser session. Each screen is rendered by the platform, and when the user clicks Next, the flow engine runs the elements up to the next screen. Data operations happen as the user, so field-level security and sharing apply unless the flow is configured otherwise.

A **scheduled flow** is started by the platform's scheduler. At the scheduled time it queries the records that meet the start criteria (here the `filterFormula`) and runs the flow for each record, in batches. Because it runs without a user, the context decides what it may read and write. Record updates inside it are processed in bulk, which is why updating `$Record` directly is efficient and a loop with an update inside would not be.

An **autolaunched flow** has no trigger of its own. It waits to be called, receives input variables, runs, and exposes output variables. `Flow.Interview.Renewal_Discount` is a generated Apex class named after the flow's API name; the test therefore calls the **active** version of the flow, which is why the test results depend on the flow being deployed and active in the org.

Flows share the transaction with whatever called them. When Apex calls a flow, the flow's queries and DML count toward the same limits as the Apex. A flow with a Get Records inside a loop of 200 records would run 200 queries and fail with a limit error, which is exactly what the linter looks for. The linter reads the XML, finds each loop, follows its `nextValueConnector` chain until it returns to the loop, and reports any data element on that path. It also reports data elements without a `faultConnector`, because an unhandled fault ends the transaction with a generic error and loses the context.

## Test it and verify

1. Run `node --test tools/flowLint.test.mjs` and confirm all six tests pass.
2. Run `node tools/lint-flows.mjs` against your flows folder. The sample flows pass the loop and Id rules; the scheduled one is fine because the update is on `$Record` and has a fault path.
3. Deploy the autolaunched flow, then run the Apex tests; four pass.
4. In Flow Builder, open Renewal Discount and use **Debug** with `yearsAsCustomer` 6 to see the same result as the test.
5. Activate the scheduled flow in a sandbox, create an overdue open opportunity, and run the flow from **Flows, Run** (or wait for the schedule). Confirm `Needs_Review__c` is set.
6. Temporarily add an Update Records element inside a loop in a copy of a flow and confirm the linter reports it.

## Common mistakes and fixes

- **Using a screen flow for background work.** Use a record-triggered, scheduled or autolaunched flow.
- **Data operations in loops.** Collect records and save once after the loop.
- **No fault path.** Add one that logs or notifies, so failures are visible.
- **Hard-coding record ids.** They differ between orgs; use labels, metadata or lookups.
- **Duplicating logic across flows.** Make one autolaunched flow or subflow and reuse it.
- **Activating untested versions.** Debug first and keep new versions as drafts.
- **Forgetting the running user.** Scheduled and autolaunched flows may run in a different context from the user you test with.
- **Writing metadata by hand.** Build in Flow Builder; retrieve with the CLI.

## Key takeaways

- The flow type decides how it starts, who runs it and where it lives.
- Autolaunched flows are the way to share logic across flows, Apex and agents.
- Keep data operations out of loops and add fault paths.
- Flows share governor limits with the transaction.
- Automate the review with a linter and Apex tests.

## Where to go next

- Read [Record-triggered flow best practices](/articles/record-triggered-flow-best-practices/) for the trigger type.
- Read [Flow vs Apex](/articles/flow-vs-apex/) to decide when code is better.
- Read [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) to expose an autolaunched flow to an agent.
