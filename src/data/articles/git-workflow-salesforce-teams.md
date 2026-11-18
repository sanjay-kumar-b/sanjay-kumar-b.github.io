---
title: "A Simple Git Workflow for Salesforce Teams"
description: "Source-driven development with Git: branches, pull requests, scratch orgs, a pre-commit guard script, CODEOWNERS and keeping metadata merges easy."
category: web-and-devops
tags: [Git, DevOps, CI/CD, Salesforce CLI]
publishedAt: 2026-11-05
updatedAt: 2026-11-15
cover: /images/covers/git-workflow-salesforce-teams.jpg
sources:
  - title: "Salesforce DX Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/"
  - title: "Pro Git book"
    url: "https://git-scm.com/book/en/v2"
---

The goal of source-driven development is that **Git is the source of truth**, not a sandbox. Whatever is in the `main` branch is what your org should look like, and every change arrives through a reviewed pull request. This article shows a small workflow that a team of two to ten people can adopt in a day, with the files and scripts that make it stick.

## The business scenario

Tidewater Logistics (a fictional company) has four people changing the same Salesforce org: two developers, an admin and a consultant. Last month two people edited the same Flow in different sandboxes, one overwrote the other, and a hard-coded record Id slipped into production Apex. They want one repository, small branches, reviews, and automatic checks that stop the two mistakes that hurt them.

## Before you start: setup

### In Salesforce

1. Give each developer a **developer sandbox** or the ability to create **scratch orgs** (this needs Dev Hub enabled in your production or a dedicated org).
2. Create an integration user for CI, with only the permissions needed to validate deployments. The CI article covers its use.
3. Agree on a rule: **no one changes production configuration directly**, except in a documented emergency, and emergency changes are retrieved into Git afterwards.

### In the external system

1. Create a repository on GitHub (or another Git host) and protect the `main` branch: require pull requests, at least one review, and passing checks.
2. Install Git, Node 20 and the Salesforce CLI on each machine.
3. Decide who reviews what, and write it down in a `CODEOWNERS` file (shown below).

## How it works

Keep the branch model small:

- `main`: always deployable.
- `feature/<short-name>`: one change per branch.
- Optional `release/*` branches for scheduled releases.

The daily flow:

1. Create a branch from `main`.
2. Develop in a scratch org or developer sandbox.
3. Pull changes into the project with the Salesforce CLI.
4. Commit small and often, with clear messages.
5. Open a pull request. A teammate reviews it.
6. CI validates the deployment. Merge when it is green.

To keep merges easy: commit only metadata you changed on purpose, merge or rebase `main` into your branch often, avoid editing the same Flow or profile in several branches at once because those files conflict easily, and prefer permission sets over profiles.

## Basic example

```bash
git checkout -b feature/account-rating
sf project retrieve start
git add -A && git commit -m "Add account rating trigger and tests"
git push -u origin feature/account-rating
```

Then open a pull request on your Git host. That is the whole loop. The advanced setup adds guard rails so that the two costly mistakes from the scenario are caught before they reach a reviewer.

## Advanced end-to-end example

**.gitignore** keeps local files, build output and credentials out of the repository.

```gitignore
# Salesforce local state
.sf/
.sfdx/
.localdevserver/
*.log

# Credentials: never commit these
auth.txt
*.authurl
.env
.env.*
server.key

# Tooling
node_modules/
coverage/
.vscode/*
!.vscode/extensions.json
.idea/
.DS_Store
```

**.forceignore** keeps noisy files out of deployments and retrieves.

```text
**/jsconfig.json
**/.eslintrc.json
**/__tests__/**
**/*.ts
package.xml
```

**.github/CODEOWNERS** makes the right people review the risky files.

```text
# Default reviewers
*                                   @tidewater/salesforce-devs

# Security-sensitive metadata needs the admin lead too
force-app/main/default/permissionsets/   @tidewater/salesforce-admins
force-app/main/default/profiles/         @tidewater/salesforce-admins
force-app/main/default/flows/            @tidewater/salesforce-admins @tidewater/salesforce-devs
```

**scripts/guard.mjs** is a pre-commit guard that blocks hard-coded record Ids and secrets in staged files.

```javascript
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// 15 or 18 character Salesforce Ids start with a known key prefix, such as 001 (Account) or 006 (Opportunity).
const ID_PATTERN = /['"](00[1-9A-Za-z][A-Za-z0-9]{12}(?:[A-Za-z0-9]{3})?)['"]/g;
const SECRET_PATTERNS = [
  { name: 'SFDX auth URL', regex: /force:\/\/[A-Za-z0-9._-]+:[^@\s]+@[A-Za-z0-9.-]+/ },
  { name: 'private key', regex: /-----BEGIN (RSA |EC )?PRIVATE KEY-----/ },
  { name: 'bearer token', regex: /Bearer\s+00D[A-Za-z0-9!._-]{20,}/ }
];

export function scan(filename, text) {
  const problems = [];
  const isTestFile = /Test\.cls$/.test(filename);
  if (/\.(cls|trigger|js|flow-meta\.xml)$/.test(filename) && !isTestFile) {
    for (const match of text.matchAll(ID_PATTERN)) {
      problems.push(`${filename}: hard-coded record Id ${match[1]}`);
    }
  }
  for (const { name, regex } of SECRET_PATTERNS) {
    if (regex.test(text)) {
      problems.push(`${filename}: looks like a ${name}`);
    }
  }
  return problems;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // Locally we scan staged files; in CI pass a range such as origin/main...HEAD.
  const range = process.argv[2];
  const command = range
    ? `git diff --name-only --diff-filter=ACM ${range}`
    : 'git diff --cached --name-only --diff-filter=ACM';
  const staged = execSync(command, { encoding: 'utf8' })
    .split('\n').filter(Boolean);
  const problems = staged.flatMap(file => scan(file, readFileSync(file, 'utf8')));
  if (problems.length > 0) {
    console.error('Commit blocked:\n' + problems.map(p => '  - ' + p).join('\n'));
    process.exit(1);
  }
}
```

**scripts/guard.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from './guard.mjs';

test('flags a hard-coded Account Id in Apex', () => {
  const out = scan('Svc.cls', "Id owner = '001Hn00001AbCdEQAT';");
  assert.equal(out.length, 1);
  assert.match(out[0], /hard-coded record Id/);
});

test('allows ids in test classes', () => {
  assert.deepEqual(scan('SvcTest.cls', "Id x = '001Hn00001AbCdEQAT';"), []);
});

test('flags a private key anywhere', () => {
  const out = scan('notes.md', '-----BEGIN RSA PRIVATE KEY-----');
  assert.match(out[0], /private key/);
});

test('flags an auth url', () => {
  const out = scan('auth.txt', 'force://PlatformCLI::5Aep861abc@my.my.salesforce.com');
  assert.match(out[0], /SFDX auth URL/);
});

test('clean code passes', () => {
  assert.deepEqual(scan('Clean.cls', "String s = 'hello';"), []);
});
```

**.husky/pre-commit** (install with `npm install --save-dev husky` and `npx husky init`) runs the guard.

```bash
#!/usr/bin/env sh
node scripts/guard.mjs
```

**.github/workflows/guard.yml** runs the same guard in CI, where it cannot be skipped.

```yaml
name: guard
on:
  pull_request:
    branches: [main]

jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Unit tests for scripts
        run: node --test scripts
      - name: Scan changed files for secrets and hard-coded Ids
        run: node scripts/guard.mjs origin/${{ github.base_ref }}...HEAD
```

**scripts/new-feature.sh** gives everyone the same starting point.

```bash
#!/usr/bin/env bash
# usage: ./scripts/new-feature.sh account-rating
set -euo pipefail
NAME="${1:?feature name required}"
git fetch origin
git checkout -b "feature/${NAME}" origin/main
sf org create scratch --definition-file config/project-scratch-def.json \
  --alias "${NAME}" --set-default --duration-days 7
sf project deploy start --target-org "${NAME}"
echo "Ready. Build in the org, then run: sf project retrieve start"
```

**.github/pull_request_template.md** turns the review checklist into a habit.

```markdown
## Why is this change needed?

## What changed?

## Checklist
- [ ] Apex tests pass and cover the new logic (including a bulk test)
- [ ] No hard-coded Ids or secrets
- [ ] All referenced metadata is included (fields, permission sets, flows)
- [ ] Permission set updated instead of a profile
- [ ] Tested as a non-admin user
```

## Handling an emergency fix

Sometimes production breaks and someone fixes it directly in the org. That is allowed, but the fix is not finished until it is in Git. Retrieve the changed components into a branch named `hotfix/<name>`, open a pull request, and merge it, so the next deployment from `main` does not silently undo the repair. Write a line in the pull request describing what broke and why, which also builds your team's history of incidents.

For releases, a `release/*` branch lets you freeze a set of changes while new features keep landing on `main`. Keep it short-lived, merge fixes back, and delete it after the release.

## What happens behind the scenes

The Salesforce CLI works by comparing source on your machine with the org. `sf project retrieve start` asks the org's Metadata API for components (limited by source tracking in scratch orgs and tracking sandboxes, or by what you name) and writes them as files in `force-app`. `sf project deploy start` does the reverse: it zips the files, sends them to the org and compiles and saves them. Git itself only knows files, so it sees the retrieve as ordinary changes.

Merge conflicts happen mostly in XML that many people touch: profiles (one big file with many unrelated settings), Flows (the whole flow is one file), and page layouts. Permission sets are smaller and group related access, so they conflict less. That is why the workflow favours them, and why `CODEOWNERS` routes those files to the admin lead.

The pre-commit hook runs on your machine before the commit is created. It reads only the staged files, so it is fast. A hook can be bypassed, so the same script should also run in CI, where it cannot be skipped.

## Test it and verify

1. Run `node --test scripts` and confirm all five tests pass.
2. Install husky, stage a file that contains `'001Hn00001AbCdEQAT'` in an Apex class, and try to commit. Expect a blocked commit with the file name.
3. Remove the Id, commit, push, and open a pull request. Confirm the template appears.
4. Change a permission set in the branch and confirm GitHub asks the admin team to review.
5. Run `./scripts/new-feature.sh demo` and confirm a scratch org is created and source deploys.
6. Protect `main` and confirm that direct pushes are rejected.

## Common mistakes and fixes

- **Committing metadata you did not mean to change.** Review `git diff` before every commit.
- **Long-lived branches.** They conflict. Merge `main` into your branch often and keep branches small.
- **Several branches editing the same Flow.** Coordinate, or split the work.
- **Profiles for access.** Use permission sets.
- **Treating a sandbox as the source of truth.** Retrieve into Git and deploy from Git.
- **Committing auth URLs or tokens.** Ignore them, rotate any that leaked, and scan in CI.

## Key takeaways

- Git is the source of truth; sandboxes and scratch orgs are disposable workspaces.
- Short-lived feature branches, small commits, reviewed pull requests.
- Automate the checks people forget: hard-coded Ids and secrets.
- Route risky metadata to the right reviewers with `CODEOWNERS`.
- Protect `main` and let CI decide when a change may merge.

## Where to go next

- Read [Continuous integration with GitHub Actions](/articles/github-actions-salesforce-ci/) to run validation on every pull request.
- Read [Preparing for Salesforce releases](/articles/preparing-for-salesforce-releases/) for the yearly routine.
- Read [Permission sets vs profiles](/articles/permission-sets-vs-profiles/) for why they merge better.
