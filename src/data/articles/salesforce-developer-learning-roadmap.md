---
title: "Salesforce Developer Roadmap 2026: From Zero to Advanced"
description: "A staged learning path from data model to Agentforce, with a starter project, a progress tracker script and a practice project at every stage."
category: salesforce-development
tags: [Roadmap, Beginner, Career]
publishedAt: 2026-11-12
updatedAt: 2026-11-15
cover: /images/covers/salesforce-developer-learning-roadmap.jpg
featured: true
sources:
  - title: "Trailhead"
    url: "https://trailhead.salesforce.com/"
  - title: "Salesforce Developers"
    url: "https://developer.salesforce.com/"
---

Use this page as the index to this site's learning series. It lists the stages in order, tells you what to build at each stage, and gives you a starter project and a small progress tracker so you can see yourself moving forward. The estimated times assume part-time study.

## The business scenario

You are learning Salesforce development to change careers or to grow inside your current job. The risk is not a lack of material; it is reading in the wrong order, never building anything, and forgetting what you read. The scenario for this article is a learner called Priya, who wants a repeatable plan: one working org, one project repository, one practice project per stage and a record of what she has finished.

## Before you start: setup

### In Salesforce

1. Sign up for a free **Developer Edition** org at the Salesforce developer site. It includes the platform features you need for learning, and it is safe to break.
2. Enable **My Domain** if it is not already on, and note your login URL.
3. Create a second user in the org, with a standard profile, so you can test security as someone who is not an administrator.
4. When you reach Stage 2, also create a **scratch org** from the CLI, which is covered in the project below.

### In the external system

1. Install Node 20 or newer, Git and Visual Studio Code.
2. Install the Salesforce CLI and the Salesforce Extension Pack for VS Code.
3. Create a free GitHub account and an empty repository named `salesforce-learning`.
4. Create a free Trailhead account and join the Salesforce Developer community for questions.

## How it works

Learn in stages, and finish a practice project before you move on. Reading without building does not stick.

**Stage 0: Foundations (2 to 3 weeks).** The data model (objects, fields, relationships, record types), security (profiles, permission sets, sharing), declarative automation (validation rules and Flow), and tools. Project: a small app with two objects, a Flow and a report. Read the [sharing model article](/articles/sharing-model-explained/), [Flow vs Apex](/articles/flow-vs-apex/) and [permission sets vs profiles](/articles/permission-sets-vs-profiles/).

**Stage 1: Apex basics (3 to 4 weeks).** Read in this order: [Apex classes from zero](/articles/apex-classes-zero-to-hero/), [SOQL best practices](/articles/soql-best-practices/), [Apex triggers from scratch](/articles/apex-triggers-from-scratch/), the [trigger handler pattern](/articles/trigger-handler-pattern/), the [governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/) and [writing Apex tests](/articles/apex-test-classes-best-practices/). Project: a trigger-based rule with meaningful tests and a bulk test.

**Stage 2: Async Apex (2 to 3 weeks).** [Future methods](/articles/future-methods-complete-guide/), [Queueable](/articles/queueable-apex-complete-guide/), [Batch](/articles/batch-apex-complete-guide/), [Schedulable](/articles/schedulable-apex-complete-guide/), then [advanced async patterns](/articles/apex-async-advanced-patterns/). Project: a nightly batch that cleans data and emails a summary.

**Stage 3: Front end.** [LWC lifecycle and wire](/articles/lwc-lifecycle-and-wire/), then [communication and data patterns](/articles/lwc-communication-and-data-patterns/). Then [React fundamentals](/articles/react-fundamentals-zero-to-hero/), hooks, state, advanced patterns, TypeScript and testing. Project: an LWC and a React version of the same account list.

**Stage 4: Integrations (4 to 6 weeks).** [REST API first calls](/articles/rest-api-first-calls/), [OAuth and external client apps](/articles/oauth-flows-and-external-client-apps/), [Apex REST](/articles/apex-rest-services-inbound/), [outbound callouts](/articles/outbound-callouts-advanced/), [integration patterns](/articles/cross-system-integration-patterns/), [platform events and CDC](/articles/platform-events-cdc-pubsub/), [middleware](/articles/middleware-integrations-guide/), [reliability](/articles/integration-reliability-idempotency/), [Bulk API 2.0](/articles/bulk-api-2-ingest-guide/), [Composite](/articles/composite-api-guide/) and the [APIs map](/articles/salesforce-apis-map/). Project: sync accounts with an external system using idempotent upserts, events and a reconciliation job.

**Stage 5: Agentforce.** [Agentforce from zero](/articles/agentforce-zero-to-first-agent/), guardrails, instructions, actions, Agent Script, the Agent API, channels and MCP. Project: an order-status agent with an Apex action, tested with a written test set, deployed to Slack.

**Stage 6: Modern UI architecture.** Multi-Framework, the Data SDK, Microfrontends and the [decision guide](/articles/choosing-lwc-multiframework-microfrontends/). Project: a React UIBundle for employees plus a microfrontend widget on a record page.

**Stage 7: DevOps and quality.** [Git workflow](/articles/git-workflow-salesforce-teams/), [CI with GitHub Actions](/articles/github-actions-salesforce-ci/), [release preparation](/articles/preparing-for-salesforce-releases/) and [security with user mode](/articles/apex-security-and-user-mode/).

## Basic example

Create your learning project and prove the toolchain works with a first class and a first test. In a terminal:

```bash
sf project generate --name salesforce-learning
cd salesforce-learning
sf org login web --set-default-dev-hub --alias devhub
sf org create scratch --definition-file config/project-scratch-def.json --alias learn --set-default --duration-days 14
```

Then add a first class and test, and deploy:

```apex
public with sharing class Greeter {
    public static String hello(String name) {
        return 'Hello, ' + (String.isBlank(name) ? 'learner' : name) + '!';
    }
}
```

```bash
sf project deploy start --target-org learn
sf apex run test --target-org learn --test-level RunLocalTests --result-format human
```

Here is the matching test, which you should write before moving on:

```apex
@IsTest
private class GreeterTest {

    @IsTest
    static void greetsByName() {
        System.assertEquals('Hello, Priya!', Greeter.hello('Priya'));
    }

    @IsTest
    static void usesDefaultWhenNameIsBlank() {
        System.assertEquals('Hello, learner!', Greeter.hello(''));
        System.assertEquals('Hello, learner!', Greeter.hello(null));
        System.assertEquals('Hello, learner!', Greeter.hello('   '));
    }
}
```

The scratch org definition file `config/project-scratch-def.json` describes the org you are creating. A learning-friendly version looks like this:

```json
{
  "orgName": "Learning Scratch Org",
  "edition": "Developer",
  "features": ["EnableSetPasswordInApi"],
  "settings": {
    "lightningExperienceSettings": {
      "enableS1DesktopEnabled": true
    },
    "securitySettings": {
      "passwordPolicies": {
        "enablePasswordHistory": false
      }
    }
  }
}
```

And `sfdx-project.json` tells the CLI where your source lives and which API version to use:

```json
{
  "packageDirectories": [
    { "path": "force-app", "default": true }
  ],
  "name": "salesforce-learning",
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0"
}
```

If both commands succeed you have a working loop: write, deploy, test. Everything later in the roadmap uses the same loop.

## Advanced end-to-end example

Learners drift when nothing shows progress. This small tracker keeps the plan in a JSON file, prints a checklist, and tells you what to do next. It needs only Node.

**roadmap/plan.json**

```json
{
  "stages": [
    { "id": 0, "name": "Foundations", "project": "Two-object app with a Flow and a report", "articles": ["sharing-model-explained", "flow-vs-apex", "permission-sets-vs-profiles"] },
    { "id": 1, "name": "Apex basics", "project": "Trigger rule with bulk test", "articles": ["apex-classes-zero-to-hero", "soql-best-practices", "apex-triggers-from-scratch", "trigger-handler-pattern", "apex-governor-limits-cheat-sheet", "apex-test-classes-best-practices"] },
    { "id": 2, "name": "Async Apex", "project": "Nightly cleanup batch with summary email", "articles": ["future-methods-complete-guide", "queueable-apex-complete-guide", "batch-apex-complete-guide", "schedulable-apex-complete-guide", "apex-async-advanced-patterns"] },
    { "id": 3, "name": "Front end", "project": "LWC and React account list", "articles": ["lwc-lifecycle-and-wire", "lwc-communication-and-data-patterns", "react-fundamentals-zero-to-hero"] },
    { "id": 4, "name": "Integrations", "project": "Idempotent account sync with reconciliation", "articles": ["rest-api-first-calls", "oauth-flows-and-external-client-apps", "apex-rest-services-inbound", "outbound-callouts-advanced", "integration-reliability-idempotency"] }
  ]
}
```

**roadmap/tracker.mjs**

```javascript
import { readFile, writeFile } from 'node:fs/promises';

export function summarize(plan, progress) {
  const done = new Set(progress.articlesRead || []);
  const projects = new Set(progress.projectsDone || []);
  return plan.stages.map(stage => {
    const read = stage.articles.filter(a => done.has(a)).length;
    const projectDone = projects.has(stage.id);
    return {
      id: stage.id,
      name: stage.name,
      read,
      total: stage.articles.length,
      projectDone,
      complete: read === stage.articles.length && projectDone
    };
  });
}

export function nextStep(plan, progress) {
  const rows = summarize(plan, progress);
  const stage = rows.find(r => !r.complete);
  if (!stage) {
    return 'Every stage is complete. Pick an advanced stage and rebuild a project with tests.';
  }
  const source = plan.stages.find(s => s.id === stage.id);
  const unread = source.articles.find(a => !(progress.articlesRead || []).includes(a));
  if (unread) {
    return `Stage ${stage.id}: read "${unread}" next.`;
  }
  return `Stage ${stage.id}: finish the project: ${source.project}.`;
}

export function render(rows) {
  return rows.map(r => {
    const bar = '#'.repeat(r.read) + '.'.repeat(r.total - r.read);
    return `Stage ${r.id} ${r.name.padEnd(14)} [${bar}] ${r.projectDone ? 'project done' : 'project open'}`;
  }).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const plan = JSON.parse(await readFile('roadmap/plan.json', 'utf8'));
  let progress = { articlesRead: [], projectsDone: [] };
  try {
    progress = JSON.parse(await readFile('roadmap/progress.json', 'utf8'));
  } catch {
    await writeFile('roadmap/progress.json', JSON.stringify(progress, null, 2));
  }
  console.log(render(summarize(plan, progress)));
  console.log('\nNext: ' + nextStep(plan, progress));
}
```

**roadmap/tracker.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize, nextStep, render } from './tracker.mjs';

const plan = { stages: [
  { id: 0, name: 'Foundations', project: 'App', articles: ['a', 'b'] },
  { id: 1, name: 'Apex basics', project: 'Trigger', articles: ['c'] }
]};

test('counts read articles and project status per stage', () => {
  const rows = summarize(plan, { articlesRead: ['a'], projectsDone: [] });
  assert.equal(rows[0].read, 1);
  assert.equal(rows[0].complete, false);
});

test('suggests the next unread article first', () => {
  assert.equal(nextStep(plan, { articlesRead: ['a'] }), 'Stage 0: read "b" next.');
});

test('asks for the project once all articles are read', () => {
  assert.match(nextStep(plan, { articlesRead: ['a', 'b'], projectsDone: [] }), /finish the project: App/);
});

test('moves to the next stage after a stage is complete', () => {
  assert.match(nextStep(plan, { articlesRead: ['a', 'b'], projectsDone: [0] }), /Stage 1/);
});

test('renders a progress bar', () => {
  const text = render(summarize(plan, { articlesRead: ['a'], projectsDone: [0] }));
  assert.ok(text.includes('[#.]'));
  assert.ok(text.includes('project done'));
});
```

Run it each week:

```bash
node --test roadmap
node roadmap/tracker.mjs
```

After each article, edit `roadmap/progress.json`, for example `{"articlesRead": ["apex-classes-zero-to-hero"], "projectsDone": []}`, commit it, and run the tracker. The commit history becomes your learning log.

## What happens behind the scenes

Nothing in the tracker talks to Salesforce. It only turns a plan and a progress file into a summary, and that is the point: the habit of **finish, record, move on** matters more than the tool. The Salesforce side of your learning loop is the deploy-and-test cycle from the basic example. When you run `sf project deploy start`, the CLI packages your source, sends it to the org's Metadata API, and the platform compiles the Apex. When you run tests, the platform executes them in isolated transactions and reports pass, fail and coverage.

Scratch orgs expire, which is a feature. They force you to keep everything in source control and rebuild from scratch, which is exactly the habit professional teams rely on.

## Test it and verify

1. Run `node --test roadmap` and confirm all five tests pass.
2. Run `node roadmap/tracker.mjs` and check that the first stage shows as open and the next step names an article.
3. Deploy `Greeter` and write one test for it. Confirm `RunLocalTests` passes.
4. Read one article, record it in `progress.json`, and confirm the bar moves.
5. At the end of each stage, show your practice project to someone and explain how it works. If you cannot explain it, repeat the stage.

## Common mistakes and fixes

- **Reading without building.** Build every example yourself in a Developer Edition or scratch org.
- **Skipping tests.** Real projects need them. Write tests from Stage 1.
- **Jumping to Agentforce or React first.** They rely on the data model, security and Apex. Follow the stages.
- **Relying on old screenshots.** Menus move. Prefer the official docs linked in each article.
- **Never re-checking limits and API versions.** Review them each release, three times a year.
- **Learning alone.** Join the community and ask questions with the code you tried.

## Key takeaways

- Learn in stages, and finish a practice project at each one.
- Use the deploy, test, commit loop from day one.
- Read the official source linked at the bottom of each article.
- Track progress somewhere visible, even a JSON file.
- Teach what you learn by writing a short note after each topic.

## Where to go next

- Start with [Apex classes from zero](/articles/apex-classes-zero-to-hero/) if you already know the platform basics.
- Jump to [Salesforce APIs map](/articles/salesforce-apis-map/) if you are mostly interested in integrations.
- Read [Agentforce from zero](/articles/agentforce-zero-to-first-agent/) once you have finished Stage 4.
