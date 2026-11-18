---
title: "Continuous Integration for Salesforce with GitHub Actions"
description: "Validate every pull request by deploying to a test org and running Apex tests, with a coverage gate script, test selection and gated production deploys."
category: web-and-devops
tags: [CI/CD, GitHub Actions, Salesforce CLI, DevOps]
publishedAt: 2026-11-06
updatedAt: 2026-11-15
cover: /images/covers/github-actions-salesforce-ci.jpg
sources:
  - title: "Salesforce CLI Command Reference"
    url: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/"
  - title: "GitHub Actions documentation"
    url: "https://docs.github.com/en/actions"
---

A continuous integration (CI) pipeline catches broken deployments and failing tests before they reach a shared org. This article builds a pipeline in three layers: a pull request check, a coverage gate you can test yourself, and a production deployment that waits for a human to approve it.

## The business scenario

Tidewater Logistics (a fictional company) merges about ten pull requests a week into one Salesforce org. Twice a month a merge broke the nightly batch because nobody ran all tests. They want every pull request validated against a sandbox that mirrors production, a minimum test coverage rule that fails loudly, and production deployments that start only from `main` after a manager clicks approve.

## Before you start: setup

### In Salesforce

1. Pick a **validation sandbox** that mirrors production. A partial or full copy is best, because validation against an empty scratch org misses data-dependent failures.
2. Create a CI integration user with the permissions to deploy metadata and run tests, and nothing else. Do not use a personal login.
3. Generate an **SFDX auth URL** for that user and sandbox with `sf org display --verbose --target-org <alias>` after logging in, and for production the same way. Treat these as passwords.
4. Check that your production org's test coverage is healthy. Production deployments require 75 percent coverage of Apex overall, and every trigger must have some coverage.

### In the external system

1. In your GitHub repository open **Settings > Secrets and variables > Actions** and add `SFDX_AUTH_URL_SANDBOX` and `SFDX_AUTH_URL_PROD` as encrypted secrets.
2. Under **Settings > Environments** create an environment named `production` and add required reviewers. Jobs that target it wait for approval.
3. Turn on branch protection for `main`: require the `validate` check to pass before merging.

## How it works

The pipeline does the same few things every time:

1. Check out the code.
2. Install the Salesforce CLI.
3. Authenticate to a validation org.
4. Run a deployment check and Apex tests.
5. Report the result on the pull request.

Three habits keep it useful. Validate against a sandbox that mirrors production. Run only the tests you need on pull requests and the full suite before release. And keep the pipeline fast, because slow pipelines get bypassed. Deploy to production only from `main`, with manual approval.

## Basic example

```yaml
name: validate
on:
  pull_request:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npm install --global @salesforce/cli
      - name: Authenticate
        run: |
          echo "${{ secrets.SFDX_AUTH_URL }}" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias ci
          rm auth.txt
      - name: Validate deploy and run tests
        run: sf project deploy validate --source-dir force-app --target-org ci --test-level RunLocalTests
```

Command names and flags evolve with CLI releases, so check `sf project deploy validate --help` and the command reference when you set this up. The advanced version adds a coverage gate, a quicker test selection and a gated production job.

## Advanced end-to-end example

**scripts/coverage-gate.mjs** reads the JSON result of a test run and fails the build when coverage or outcomes are below your rules.

```javascript
import { readFile } from 'node:fs/promises';

export function evaluate(result, { minOverall = 85, minPerClass = 75 } = {}) {
  const problems = [];
  const summary = result?.result?.summary ?? {};

  const failing = Number(summary.failing ?? 0);
  if (failing > 0) {
    problems.push(`${failing} test(s) failed`);
  }

  const overall = parseFloat(String(summary.orgWideCoverage ?? summary.testRunCoverage ?? '0').replace('%', ''));
  if (overall < minOverall) {
    problems.push(`Overall coverage ${overall}% is below ${minOverall}%`);
  }

  for (const cls of result?.result?.coverage?.coverage ?? []) {
    const pct = parseFloat(String(cls.coveredPercent ?? cls.percent ?? '100').replace('%', ''));
    if (cls.totalLines > 0 && pct < minPerClass) {
      problems.push(`${cls.name} covers ${pct}% (minimum ${minPerClass}%)`);
    }
  }
  return { ok: problems.length === 0, overall, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] || 'test-result.json';
  const outcome = evaluate(JSON.parse(await readFile(file, 'utf8')));
  console.log(`Overall coverage: ${outcome.overall}%`);
  for (const p of outcome.problems) {
    console.error('FAIL: ' + p);
  }
  process.exit(outcome.ok ? 0 : 1);
}
```

**scripts/coverage-gate.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate } from './coverage-gate.mjs';

const good = { result: { summary: { failing: 0, orgWideCoverage: '88%' }, coverage: { coverage: [
  { name: 'AccountService', totalLines: 40, coveredPercent: 90 }
]}}};

test('passes when tests pass and coverage is high', () => {
  assert.equal(evaluate(good).ok, true);
});

test('fails on a failing test', () => {
  const bad = { result: { ...good.result, summary: { failing: 2, orgWideCoverage: '90%' } } };
  const out = evaluate(bad);
  assert.equal(out.ok, false);
  assert.match(out.problems[0], /2 test\(s\) failed/);
});

test('fails on low overall coverage', () => {
  const low = { result: { ...good.result, summary: { failing: 0, orgWideCoverage: '70%' } } };
  assert.match(evaluate(low).problems[0], /Overall coverage 70%/);
});

test('fails when one class is below its minimum', () => {
  const weak = { result: { summary: good.result.summary, coverage: { coverage: [
    { name: 'RiskyClass', totalLines: 30, coveredPercent: 40 }
  ]}}};
  assert.match(evaluate(weak).problems[0], /RiskyClass covers 40%/);
});
```

**scripts/select-tests.mjs** picks the test classes that match changed Apex, so pull requests run fewer tests.

```javascript
import { execSync } from 'node:child_process';

export function selectTests(changedFiles) {
  const tests = new Set();
  for (const file of changedFiles) {
    const match = /\/classes\/([A-Za-z0-9_]+)\.cls$/.exec(file);
    if (!match) {
      continue;
    }
    const name = match[1];
    tests.add(name.endsWith('Test') ? name : `${name}Test`);
  }
  return [...tests].sort();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = process.argv[2] || 'origin/main';
  const files = execSync(`git diff --name-only ${base}...HEAD`, { encoding: 'utf8' }).split('\n').filter(Boolean);
  console.log(selectTests(files).join(' '));
}
```

**.github/workflows/validate.yml**

```yaml
name: validate
on:
  pull_request:
    branches: [main]

concurrency:
  group: validate-${{ github.head_ref }}
  cancel-in-progress: true

jobs:
  validate:
    runs-on: ubuntu-latest
    timeout-minutes: 45
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Salesforce CLI
        run: npm install --global @salesforce/cli
      - name: Unit tests for pipeline scripts
        run: node --test scripts
      - name: Authenticate to the validation sandbox
        run: |
          echo "${{ secrets.SFDX_AUTH_URL_SANDBOX }}" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias ci
          rm auth.txt
      - name: Run the tests for changed classes
        run: |
          TESTS=$(node scripts/select-tests.mjs origin/${{ github.base_ref }})
          echo "Selected: $TESTS"
          if [ -n "$TESTS" ]; then
            sf apex run test --target-org ci --class-names $(echo $TESTS | sed 's/ /,/g') \
              --result-format json --code-coverage --wait 30 > test-result.json || true
            node scripts/coverage-gate.mjs test-result.json
          fi
      - name: Check-only deploy
        run: sf project deploy validate --source-dir force-app --target-org ci --test-level RunLocalTests --wait 60
```

**.github/workflows/deploy.yml** deploys from `main` after a human approves.

```yaml
name: deploy
on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install --global @salesforce/cli
      - name: Authenticate to production
        run: |
          echo "${{ secrets.SFDX_AUTH_URL_PROD }}" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias prod
          rm auth.txt
      - name: Deploy with local tests
        run: sf project deploy start --source-dir force-app --target-org prod --test-level RunLocalTests --wait 90
```

## Speed and cost

A pipeline people trust is a pipeline people wait for, so measure it. Note how long each step takes in the Actions log. Authentication takes seconds, the CLI install takes under a minute, and almost all the time is the org compiling and running tests. Selecting tests for changed classes cuts the pull request run to a few minutes, while the check-only deploy with local tests remains as a safety net. If that step is too slow for every pull request, move it to a nightly schedule against `main` and keep the fast selected-test run on pull requests.

Remember that each validation consumes sandbox capacity, and several people pushing at once can queue. The `concurrency` setting cancels outdated runs on the same branch, which helps a lot with frequent pushes.

Finally, treat the pipeline as code: review changes to workflow files like any other change, pin action versions, and keep the scripts under test. When a developer says "CI is flaky", you want evidence in logs, not guesses.

## What happens behind the scenes

GitHub starts a fresh virtual machine for each run, so nothing is left over from earlier runs. The job installs the CLI, writes the auth URL secret to a temporary file, logs in, and deletes the file. Secrets are masked in logs, but a script that prints one would still leak it, which is why you never echo them.

`sf project deploy validate` asks the org to do everything a deployment would, including compiling and running tests, but not to save the result. If it passes, you can quick-deploy the same validated package within a limited time window. The test result JSON includes a summary and per-class coverage, which the gate script reads. Because the gate is ordinary code with tests, you can change its rules and prove they work.

The `environment: production` line makes GitHub pause the job until a required reviewer approves, and the `concurrency` block cancels an older run when a new commit arrives, saving time and org capacity.

## Test it and verify

1. Run `node --test scripts` and confirm the four coverage-gate tests pass.
2. Add the three secrets and the `production` environment as described.
3. Open a pull request that changes one Apex class. Confirm the workflow runs, selects the matching test class and passes.
4. Break a test on purpose. Confirm the workflow fails with a clear `FAIL:` line.
5. Merge to `main` and confirm the deploy job waits for approval.
6. Approve it and confirm the run finishes and the change is live.

## Common mistakes and fixes

- **Validating against an empty scratch org.** Data-dependent failures appear only later. Use a sandbox that mirrors production.
- **Running the full suite on every pull request.** It gets slow and people bypass it. Select tests on pull requests and run everything before release.
- **A shared personal login.** Use a dedicated integration user with minimal rights.
- **Secrets in the repository.** Use encrypted secrets and delete the temporary file after login.
- **Deploying to production from any branch.** Restrict it to `main` with manual approval.
- **Assuming flags never change.** Check `--help` and the command reference when you upgrade the CLI.

## Key takeaways

- A pull request pipeline checks deployments and tests before anything is merged.
- Put quality rules, such as a coverage gate, in tested scripts instead of in YAML.
- Select tests on pull requests and run the full suite before release.
- Store org credentials as encrypted secrets and use a least-privilege user.
- Deploy to production only from `main`, with manual approval.

## Where to go next

- Read [A simple Git workflow for Salesforce teams](/articles/git-workflow-salesforce-teams/) for branches and reviews.
- Read [Apex test classes best practices](/articles/apex-test-classes-best-practices/) so your tests deserve the gate.
- Read [Preparing for Salesforce releases](/articles/preparing-for-salesforce-releases/) for the preview-sandbox routine.
