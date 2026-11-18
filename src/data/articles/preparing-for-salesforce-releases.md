---
title: "How to Prepare for Each Salesforce Release (Winter, Spring, Summer)"
description: "A repeatable release routine with scripts: find stale API versions, run tests on a preview sandbox, health-check jobs and smoke test after go-live."
category: salesforce-administration
tags: [Releases, Sandbox, Admin]
publishedAt: 2026-11-07
updatedAt: 2026-11-15
cover: /images/covers/preparing-for-salesforce-releases.jpg
sources:
  - title: "Salesforce Trust (maintenance schedule)"
    url: "https://trust.salesforce.com/"
  - title: "Salesforce Release Notes"
    url: "https://help.salesforce.com/s/products/platform"
---

Salesforce ships three major releases a year, named Winter, Spring and Summer. Each one changes features and sometimes behaviour. A routine makes them painless, and a few small scripts make the routine repeatable instead of heroic.

> Exact dates differ per release and per instance. Look up your instance on Salesforce Trust (under Maintenance) for your org's dates and read the official release notes for each release.

For example, Summer '26 shipped API version 67.0 and brought changes that affect Apex security (user mode by default and `with sharing` as the default for classes compiled at 67.0, per the developer guide). Confirm details like these in the current release notes, because they can change.

## The business scenario

Willow Health (a fictional provider) runs claims processing on Salesforce with Apex, Flows, a customer portal and an integration with a billing system. The admin team has two people. They want a routine that finds risky code early, proves that the preview release does not break key journeys, and confirms health within an hour after go-live, without spending weeks on it.

## Before you start: setup

### In Salesforce

1. Know your **sandbox strategy**: at least one full or partial sandbox that gets the **preview** release before production, and a developer sandbox for fixes.
2. On **Salesforce Trust**, find your production instance and note the sandbox preview date and the production release weekend.
3. Create a named, read-only **monitoring user** (or use your admin) that can query `ApexClass`, `AsyncApexJob` and `CronTrigger`.
4. Make sure your source code lives in version control, so scripts can scan it. If not, retrieve it with the Salesforce CLI.
5. List your **critical journeys** in writing (for example: create a claim, approve a claim, portal login, billing sync).

### In the external system

1. Tell the billing vendor and any other integration owner the preview and release dates, and ask for a test endpoint.
2. Keep a contact list for escalation during the release weekend.

## How it works

The routine has four stages.

**About six to eight weeks before:** find your instance and release dates, learn when sandboxes get the preview upgrade, and read the release notes for your clouds. Note what affects you.

**During preview:**

- Test your key processes in a preview sandbox: Flows, Apex, integrations, Experience Cloud and reports.
- Run all Apex tests and compare them with a baseline.
- Check **release updates** (changes to platform behaviour) and note their enforcement dates.
- Tell users about visible UI changes.

**Release weekend:** avoid deploying during the maintenance window and keep your escalation contacts ready.

**After the release:**

- Smoke test critical journeys.
- Re-run tests and check scheduled jobs.
- Watch error emails and logs for a few days.
- Review new features worth adopting and add them to your roadmap.

Finally, keep your own release notes: a short internal page of what changed and what you did, so the next release is faster. Update API versions in source code deliberately, not accidentally.

## Basic example

The simplest useful habit is a one-line check that finds metadata pinned to old API versions:

```bash
grep -rhoE "<apiVersion>[0-9.]+</apiVersion>" force-app | sort | uniq -c | sort -rn
```

It prints how many files use each version. A long tail of very old versions is a warning sign: those components may behave under legacy rules, and they are the first place to look when a release changes a default.

## Advanced end-to-end example

**scripts/api-versions.mjs** reports stale components with file names, and fails the build above a threshold.

```javascript
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

export function parseVersion(xml) {
  const match = /<apiVersion>(\d+)\.0<\/apiVersion>/.exec(xml);
  return match ? Number(match[1]) : null;
}

export function classify(files, currentMajor, maxAge) {
  const stale = files.filter(f => f.version !== null && currentMajor - f.version > maxAge);
  stale.sort((a, b) => a.version - b.version);
  return stale;
}

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.name.endsWith('-meta.xml')) {
      yield full;
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [root = 'force-app', current = '67', maxAge = '8'] = process.argv.slice(2);
  const files = [];
  for await (const path of walk(root)) {
    files.push({ path, version: parseVersion(await readFile(path, 'utf8')) });
  }
  const stale = classify(files, Number(current), Number(maxAge));
  for (const f of stale) {
    console.log(`v${f.version}.0  ${f.path}`);
  }
  console.log(`${stale.length} component(s) more than ${maxAge} versions old`);
  process.exit(stale.length > 0 ? 1 : 0);
}
```

**scripts/api-versions.test.mjs**

```javascript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVersion, classify } from './api-versions.mjs';

test('reads the version from metadata xml', () => {
  assert.equal(parseVersion('<apiVersion>58.0</apiVersion>'), 58);
  assert.equal(parseVersion('<label>none</label>'), null);
});

test('flags only components older than the allowed age, oldest first', () => {
  const files = [
    { path: 'a', version: 67 },
    { path: 'b', version: 50 },
    { path: 'c', version: 58 },
    { path: 'd', version: null }
  ];
  const stale = classify(files, 67, 8);
  assert.deepEqual(stale.map(f => f.path), ['b', 'c']);
});
```

**force-app/main/default/classes/ReleaseHealthCheck.cls** gives you a post-release answer in seconds.

```apex
public with sharing class ReleaseHealthCheck {

    public class Report {
        public Integer failedJobs;
        public Integer abortedSchedules;
        public Integer scheduledJobs;
        public List<String> problems = new List<String>();
        public Boolean healthy() { return problems.isEmpty(); }
    }

    public static Report run(Datetime since) {
        Report r = new Report();
        r.failedJobs = [
            SELECT COUNT() FROM AsyncApexJob
            WHERE Status = 'Failed' AND CompletedDate >= :since
        ];
        r.scheduledJobs = [SELECT COUNT() FROM CronTrigger WHERE State IN ('WAITING', 'ACQUIRED', 'EXECUTING')];
        r.abortedSchedules = [SELECT COUNT() FROM CronTrigger WHERE State IN ('ERROR', 'DELETED') AND LastModifiedDate >= :since];

        if (r.failedJobs > 0) {
            r.problems.add(r.failedJobs + ' async job(s) failed since ' + since);
        }
        if (r.abortedSchedules > 0) {
            r.problems.add(r.abortedSchedules + ' scheduled job(s) stopped since ' + since);
        }
        return r;
    }
}
```

**force-app/main/default/classes/ReleaseHealthCheckTest.cls**

```apex
@IsTest
private class ReleaseHealthCheckTest {

    @IsTest
    static void cleanOrgIsHealthy() {
        ReleaseHealthCheck.Report r = ReleaseHealthCheck.run(System.now().addHours(-1));
        System.assertEquals(0, r.failedJobs);
        System.assert(r.healthy());
    }

    @IsTest
    static void reportCountsActiveSchedules() {
        System.schedule('Release check test', '0 0 3 * * ?', new HealthTestJob());
        ReleaseHealthCheck.Report r = ReleaseHealthCheck.run(System.now().addHours(-1));
        System.assert(r.scheduledJobs >= 1);
    }

    public class HealthTestJob implements Schedulable {
        public void execute(SchedulableContext ctx) {}
    }
}
```

**.github/workflows/preview-check.yml** runs the checks against a preview sandbox on demand.

```yaml
name: Preview release check
on:
  workflow_dispatch:
  schedule:
    - cron: '0 6 * * 1'
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Install Salesforce CLI
        run: npm install --global @salesforce/cli
      - name: Scan for stale API versions
        run: node scripts/api-versions.mjs force-app 67 8
        continue-on-error: true
      - name: Unit tests for scripts
        run: node --test scripts
      - name: Log in to the preview sandbox
        run: |
          echo "${{ secrets.SF_PREVIEW_AUTH_URL }}" > auth.txt
          sf org login sfdx-url --sfdx-url-file auth.txt --alias preview
          rm auth.txt
      - name: Run all local Apex tests
        run: sf apex run test --target-org preview --test-level RunLocalTests --wait 60 --result-format human --code-coverage
```

A post-release smoke script ties it together. It runs the health check and a couple of queries that mirror your critical journeys, and exits with an error if anything looks wrong:

```bash
#!/usr/bin/env bash
# scripts/post-release-smoke.sh  usage: ./post-release-smoke.sh my-prod-alias
set -euo pipefail
ORG="${1:?org alias required}"

echo "== Health check (last 24 hours)"
sf apex run --target-org "$ORG" --file scripts/health.apex

echo "== Open claims created today"
sf data query --target-org "$ORG" --query "SELECT COUNT() FROM Case WHERE CreatedDate = TODAY"

echo "== Active users who logged in since release"
sf data query --target-org "$ORG" --query "SELECT COUNT() FROM User WHERE LastLoginDate = TODAY AND IsActive = true"

echo "== Failed async jobs"
sf data query --target-org "$ORG" --query "SELECT Id, ApexClass.Name, ExtendedStatus FROM AsyncApexJob WHERE Status = 'Failed' AND CompletedDate = TODAY"
echo "Smoke checks finished. Review any rows above before announcing success."
```

The file `scripts/health.apex` contains one line: `System.debug(ReleaseHealthCheck.run(System.now().addHours(-24)).problems);`. Adjust the queries to your own critical journeys.

## Keeping your own release notes

After each release, write five lines: what the release changed that touched you, what you tested, what broke, what you fixed, and what you want to adopt next. Over a year that page becomes the best onboarding document for a new admin, and it turns the next preview from a scramble into a checklist.

## What happens behind the scenes

Salesforce upgrades **sandboxes first**. A sandbox on a preview instance runs the new release weeks before production, which is your chance to find problems while they are cheap. Apex code compiled at an older API version keeps most old behaviour, because behaviour changes are usually tied to the API version of the component. When a release changes a default, the notes call it out and often add a **release update** with an enforcement date, so you can test it early.

The scripts help because they replace opinion with evidence. The stale-version scan tells you which components are on legacy rules. The Apex test run tells you whether logic still holds on the new platform. The health check reads the platform's own job tables (`AsyncApexJob` for async work and `CronTrigger` for schedules), so after go-live you can see in seconds if jobs are failing or schedules have stopped.

## Test it and verify

1. Run `node --test scripts` and confirm both tests pass.
2. Run `node scripts/api-versions.mjs force-app 67 8` on your repository and read the list.
3. Deploy `ReleaseHealthCheck` and its test to a sandbox and run the test.
4. In **Anonymous Apex** run `System.debug(ReleaseHealthCheck.run(System.now().addHours(-24)));` and read the result.
5. Trigger the GitHub workflow manually and confirm the tests run in the preview sandbox.
6. After the next release, walk through your written critical journeys and tick them off.

## Common mistakes and fixes

- **Starting after the release.** Use the preview window; test before production changes.
- **Testing only as an admin.** Test with a typical user profile.
- **Deploying during the maintenance window.** Avoid it.
- **Updating API versions casually.** Change them deliberately and test each change.
- **Ignoring release updates.** Their enforcement dates arrive whether you are ready or not.
- **No record of what you did.** Keep release notes of your own.

## Key takeaways

- Three releases a year: plan around your instance's dates on Trust.
- Use the preview sandbox to test Flows, Apex, integrations and portals.
- Scan for stale API versions and run all tests on the preview.
- After go-live, smoke test journeys and health-check jobs.
- Write down what changed so the next release is faster.

## Where to go next

- Read [GitHub Actions for Salesforce CI](/articles/github-actions-salesforce-ci/) to automate the checks.
- Read [Git workflow for Salesforce teams](/articles/git-workflow-salesforce-teams/) for source control habits.
- Read [Apex security and user mode](/articles/apex-security-and-user-mode/) for a security change worth testing early.
