---
title: "Salesforce Multi-Framework: Build React and Angular Apps on the Platform"
description: "What Multi-Framework is, which frameworks and orgs are supported, the UIBundle model, the GA timeline and a hands-on getting-started path with checks and CI."
category: react-and-salesforce
tags: [Multi-Framework, React, Angular, Intermediate]
publishedAt: 2026-11-12
updatedAt: 2026-11-16
cover: /images/covers/salesforce-multi-framework-getting-started.jpg
featured: true
sources:
  - title: "Salesforce Multi-Framework Overview"
    url: "https://developer.salesforce.com/docs/platform/multiframework/guide/multiframework-overview.html"
  - title: "Build with React on Salesforce: Multi-Framework Is Now GA (July 2026)"
    url: "https://developer.salesforce.com/blogs/2026/07/build-with-react-on-salesforce-multi-framework-is-now-ga"
  - title: "What's New in Salesforce Multi-Framework: Angular Is Now GA (October 2026)"
    url: "https://developer.salesforce.com/blogs/2026/10/whats-new-in-salesforce-multi-framework-angular-is-now-ga"
  - title: "Get Started (Multi-Framework guide)"
    url: "https://developer.salesforce.com/docs/platform/multiframework/guide/mfw-get-started.html"
---

**Salesforce Multi-Framework** is a framework-agnostic runtime for building integrated Salesforce apps with modern front-end frameworks. Apps run on the Headless 360 platform and get built-in authentication, security and governance. This article explains the model, then walks through a setup you can verify step by step, including an automated readiness check and a build pipeline.

> The exact React template names and quick-start commands were not available verbatim when this article was written. The commands below that I could not confirm are marked, and the Get Started page is the authority. Everything else (checks, tests and pipeline) is written so you can run it today.

## The business scenario

Juniper Consulting has a team of React developers who currently build separate portals outside Salesforce and spend months on login, session handling and permission checks. The platform team wants to try building a new internal "Account Pulse" app on Multi-Framework so it inherits Salesforce sign-in, MFA and data security. Before anyone writes UI, they want a repeatable setup, proof that the org qualifies, and a pipeline that fails fast when something is missing.

## Before you start: setup

### In Salesforce

1. **Check the org type.** Production, sandbox, Developer Edition and scratch orgs work, but the org must be on **Hyperforce** and on **Summer '26 or later** (per the React GA post).
2. **Enable the toggle.** In Setup, under React Development with Salesforce Multi-Framework (the label may change), enable the **Salesforce App Domain** setting. Employee apps are served from the `salesforce.app` domain.
3. **Install the Salesforce CLI** and sign in: `sf org login web --alias dev --set-default`.
4. **Create a permission set** for the app's users. It must grant access to the data the app shows and visibility of the Custom Application.
5. **Plan the target.** Employee apps use `CustomApplication`; customer and partner apps use the `Experience` target through Experience Cloud.
6. **Decide on packaging.** Managed packages can include the UIBundle, Custom Application, permission sets, Apex and custom objects, but only for non-site apps (per the Winter '27 post).

### In the external system

There is no external server, because the platform hosts the app. You do need:

1. **Node 20 or newer** and npm.
2. A **Git repository** and a continuous integration service (the example uses GitHub Actions).
3. For CI, a way to authenticate to a sandbox without a browser: a JWT-based login using an External Client App and a stored private key as a secret. See the OAuth article for the setup.
4. Optionally an agentic coding tool; the Get Started page lists generating an app from a template with the CLI or such a tool.

## How it works

**Timeline (from Salesforce's posts):**

- **April 2026:** introduced as an open beta.
- **16 July 2026:** **React** became generally available, described as production-ready and supported for business-critical workloads.
- **15 October 2026 (Winter '27):** **Angular** became the second GA framework, and Microfrontends reached GA too. Salesforce lists **Vue** as the next framework, with no date.

**What you can build:**

- **Employee apps**, launched from the App Launcher or the Salesforce mobile app, on the `salesforce.app` domain, each app on its own origin so the browser's same-origin policy isolates apps from each other.
- **Customer and partner apps** through Experience Cloud (target `Experience`).
- Apps can include Salesforce org data and CMS content, search, authentication and the Agentforce Conversation Client.

**How an app is packaged.** An app is a **UIBundle** metadata type. A typical employee app needs:

1. The UIBundle, with `<target>CustomApplication</target>` in its `.uibundle-meta.xml` (the older `AppLauncher` target is deprecated).
2. A **Custom Application** that references the bundle with `<uiBundle>`.
3. A **Permission Set** granting application visibility.

The React GA post gives the app URL format: `https://<org>--<namespace>.<instance>.my.salesforce.app/app/c__<bundleName>`.

**The documented getting-started path:** set up your org; run the quick start (scaffold from a template, run locally, deploy); learn the UIBundle project structure; preview locally; add data, features and style; test (templates include unit and end-to-end tests); deploy and publish a UIBundle; grant access; optionally embed with UI Embedding or package.

**Security:** the platform still enforces object-level security, field-level security, sharing and validation rules for data accessed through the Data SDK. MFA is supported, and Salesforce manages authentication, so you do not build your own.

## Basic example

Scaffold an Angular app with the templates named in the Winter '27 post (`angularinternalapp`, `angularexternalapp`, `angularbasic`):

```bash
sf template generate project --name account-pulse --template angularinternalapp
cd account-pulse
npm install
```

React has equivalent templates, and a samples repository, `trailheadapps/multiframework-recipes`, with more than 20 recipes per the GA post. The exact React template name is on the Quick Start page, so copy the command from there instead of guessing.

A UIBundle's metadata file for an employee app:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<UIBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <target>CustomApplication</target>
    <!-- Other required elements are listed in the official guide. -->
</UIBundle>
```

## Advanced end-to-end example

Instead of trusting a checklist in your head, encode it. This readiness check takes the facts about your org and project, and reports what is missing. The facts come from you or from a short script that reads your project files, so the check runs without calling Salesforce.

**tools/readiness.mjs**

```javascript
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Compares "Summer '26" style release names by year, then season.
// Within one calendar year: Spring (Feb), Summer (Jun), then Winter (Oct).
const SEASONS = { spring: 1, summer: 2, winter: 3 };

export function releaseAtLeast(actual, minimum) {
  const parse = name => {
    const match = /^(winter|spring|summer)\s*'(\d{2})$/i.exec(name.trim());
    if (!match) {
      throw new Error('Cannot read release name: ' + name);
    }
    const year = Number(match[2]);
    const season = SEASONS[match[1].toLowerCase()];
    // Winter '27 ships in October 2026, so it comes after Summer '26.
    return (match[1].toLowerCase() === 'winter' ? year - 1 : year) * 10 + season;
  };
  return parse(actual) >= parse(minimum);
}

export function checkOrg(facts) {
  const problems = [];
  if (!facts.hyperforce) {
    problems.push('The org must be on Hyperforce.');
  }
  if (!releaseAtLeast(facts.release, "Summer '26")) {
    problems.push(`Release ${facts.release} is older than Summer '26.`);
  }
  if (!facts.appDomainEnabled) {
    problems.push('Enable the Salesforce App Domain setting in Setup.');
  }
  return problems;
}

function listFiles(dir, found = []) {
  if (!existsSync(dir)) {
    return found;
  }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      listFiles(path, found);
    } else {
      found.push(path);
    }
  }
  return found;
}

export function checkProject(root) {
  const problems = [];
  const files = listFiles(join(root, 'force-app'));
  const bundles = files.filter(f => f.endsWith('.uibundle-meta.xml'));
  const apps = files.filter(f => f.endsWith('.app-meta.xml'));
  const permsets = files.filter(f => f.endsWith('.permissionset-meta.xml'));

  if (bundles.length === 0) {
    problems.push('No *.uibundle-meta.xml file found.');
  }
  for (const file of bundles) {
    const xml = readFileSync(file, 'utf8');
    if (xml.includes('<target>AppLauncher</target>')) {
      problems.push(`${file}: AppLauncher target is deprecated; use CustomApplication.`);
    } else if (!xml.includes('<target>')) {
      problems.push(`${file}: no <target> element.`);
    }
  }
  if (apps.length === 0 || !apps.some(f => readFileSync(f, 'utf8').includes('<uiBundle>'))) {
    problems.push('No Custom Application references a bundle with <uiBundle>.');
  }
  if (permsets.length === 0) {
    problems.push('No permission set found, so nobody would see the app.');
  }
  return problems;
}

export function report(problems) {
  return problems.length === 0 ? 'Ready.' : problems.map(p => '- ' + p).join('\n');
}
```

**tools/readiness.test.mjs** (run with `node --test tools/readiness.test.mjs`)

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOrg, checkProject, releaseAtLeast, report } from './readiness.mjs';

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'mfw-'));
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, 'force-app', name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test('release comparison understands the season order', () => {
  assert.equal(releaseAtLeast("Summer '26", "Summer '26"), true);
  assert.equal(releaseAtLeast("Winter '27", "Summer '26"), true);
  assert.equal(releaseAtLeast("Spring '26", "Summer '26"), false);
  assert.throws(() => releaseAtLeast('Autumn 26', "Summer '26"), /Cannot read/);
});

test('an org that meets every requirement has no problems', () => {
  const facts = { hyperforce: true, release: "Summer '26", appDomainEnabled: true };
  assert.deepEqual(checkOrg(facts), []);
});

test('an old, non-Hyperforce org reports each problem', () => {
  const facts = { hyperforce: false, release: "Spring '26", appDomainEnabled: false };
  assert.equal(checkOrg(facts).length, 3);
});

test('a complete project passes', () => {
  const root = project({
    'uiBundles/a/a.uibundle-meta.xml': '<UIBundle><target>CustomApplication</target></UIBundle>',
    'applications/A.app-meta.xml': '<CustomApplication><uiBundle>a</uiBundle></CustomApplication>',
    'permissionsets/P.permissionset-meta.xml': '<PermissionSet/>'
  });
  assert.equal(report(checkProject(root)), 'Ready.');
});

test('the deprecated AppLauncher target is flagged', () => {
  const root = project({
    'uiBundles/a/a.uibundle-meta.xml': '<UIBundle><target>AppLauncher</target></UIBundle>',
    'applications/A.app-meta.xml': '<CustomApplication><uiBundle>a</uiBundle></CustomApplication>',
    'permissionsets/P.permissionset-meta.xml': '<PermissionSet/>'
  });
  assert.match(report(checkProject(root)), /AppLauncher target is deprecated/);
});

test('missing application and permission set are both reported', () => {
  const root = project({
    'uiBundles/a/a.uibundle-meta.xml': '<UIBundle><target>CustomApplication</target></UIBundle>'
  });
  const text = report(checkProject(root));
  assert.match(text, /No Custom Application/);
  assert.match(text, /No permission set/);
});
```

**.github/workflows/mfw.yml** runs the checks on every pull request.

```yaml
name: multi-framework-ci
on:
  pull_request:
  push:
    branches: [main]

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - name: Readiness of project metadata
        run: node --test tools/readiness.test.mjs
      - name: Unit tests
        run: npm test --if-present
      - name: Build
        run: npm run build --if-present
```

Add a small script that prints the project check for humans:

```javascript
// tools/check-project.mjs
import { checkProject, report } from './readiness.mjs';

const problems = checkProject(process.argv[2] ?? '.');
console.log(report(problems));
process.exit(problems.length === 0 ? 0 : 1);
```

Run `node tools/check-project.mjs .` from your project root. A non-zero exit fails the pipeline.

## What happens behind the scenes

When you deploy a UIBundle, the platform stores your built front-end files as metadata in the org. The Custom Application gives the bundle an entry in the App Launcher, and the permission set controls who sees that entry. When a user opens the app, the browser is sent to the app's own `salesforce.app` origin. Because each app has its own origin, the same-origin policy keeps one app's scripts and storage away from another's.

Authentication is handled by Salesforce, so the user signs in with the same login and MFA as elsewhere. When your code calls the Data SDK, requests carry the user's session, and Salesforce checks object permissions, field-level security and sharing before returning data. That is why a hidden button never counts as security, and why the app works for each user only as far as their permission sets allow.

The readiness check mirrors those moving parts. The org facts correspond to platform requirements (Hyperforce, release, app domain). The project checks correspond to the three metadata pieces, and one rule about the deprecated target. Because it is plain code with tests, you can add a rule whenever you learn a new requirement the hard way, and every future project benefits.

The release comparison is worth a note. Salesforce releases are named by season and year, and Winter ships in the **previous** calendar year, so Winter '27 arrived in October 2026, after Summer '26. A naive alphabetical or numeric comparison gets this wrong, which is why the helper shifts Winter back by a year.

## Test it and verify

1. Run `node --test tools/readiness.test.mjs` and confirm that all six tests pass.
2. Scaffold a project with the template command, run `node tools/check-project.mjs .`, and read the output. Fix anything it lists.
3. Run the app locally as the quick start describes and confirm that it renders.
4. Deploy to a sandbox: `sf project deploy start --source-dir force-app --target-org dev`.
5. Publish a version of the UIBundle, assign the permission set, and open the app from the App Launcher as a non-admin user.
6. Confirm that the URL matches the documented format on the `salesforce.app` domain.

## Common mistakes and fixes

- **Org not on Hyperforce or too old.** Check the requirements first; use a Developer Edition or scratch org if you are unsure.
- **App domain toggle off.** The app has nowhere to run; enable it in Setup.
- **Using the `AppLauncher` target.** It is deprecated; use `CustomApplication`.
- **No permission set.** The deploy succeeds but nobody can see the app.
- **Expecting site apps in managed packages.** Only non-site apps are supported.
- **Depending on Beta features.** Multi-Framework Insights, Builder Central and Quick Pages were Beta in the October post; check status first.
- **Copying commands from memory.** Use the Get Started and Quick Start pages for exact commands.

## Key takeaways

- Multi-Framework hosts your React or Angular app on the platform with Salesforce authentication and security.
- React went GA in July 2026 and Angular in October 2026; Vue is next with no date.
- An app is a UIBundle plus a Custom Application plus a Permission Set.
- Encode your checklist as tests so setup problems fail fast in CI.
- Read the Data SDK article next for querying and mutating data.

## Where to go next

- Read [Multi-Framework Data SDK and deployment](/articles/multi-framework-data-sdk-and-deployment/) for data and publishing.
- Read [Choosing between LWC, Multi-Framework and Microfrontends](/articles/choosing-lwc-multiframework-microfrontends/) for the decision guide.
- Read [OAuth flows and External Client Apps](/articles/oauth-flows-and-external-client-apps/) for CI authentication.
