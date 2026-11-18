---
title: "Salesforce DX: Scratch Orgs, Source Tracking and Unlocked Packages"
description: "Set up Salesforce DX: project structure, scratch org definitions, a one-command setup script, unlocked packages with dependencies and a CI pipeline with checks."
category: web-and-devops
tags: [Salesforce DX, Scratch Orgs, Packaging, CI/CD, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce DX Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/"
  - title: "Salesforce CLI Command Reference"
    url: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_cli_reference.meta/sfdx_cli_reference/"
---

Salesforce DX is the way modern teams build on the platform: source code lives in Git, every developer works in their own disposable org, and releases are versioned packages. This article explains the model, then builds a complete workflow: a project, a scratch org you can create with one command, two unlocked packages with a dependency, and a pipeline that checks it all.

> CLI flags change between releases. The commands below are the ones in common use, but run `sf <command> --help` to confirm options for the version you have installed.

## The business scenario

Juniper Consulting has five developers who all work in one shared sandbox. They overwrite each other's changes, nobody can reproduce a bug without cloning the sandbox, and releases are a manual "change set" ritual that takes a day. The platform lead wants: a Git repository as the source of truth, a fresh scratch org per developer per feature, repeatable setup that loads sample data and permissions, two **unlocked packages** (a shared `core` and a feature `app` that depends on it), and automated validation on every pull request.

## Before you start: setup

### In Salesforce

1. **Enable Dev Hub** in a production org or a Developer Edition org: Setup, Dev Hub, **Enable Dev Hub**. Scratch orgs and package creation are created from the Dev Hub. Enabling it cannot be undone, so do it in the org you intend to use. Also enable **Unlocked Packages and Second-Generation Managed Packages** in the same page.
2. **Give people access.** Developers need a user in the Dev Hub org with the permissions to create scratch orgs and packages (the System Administrator profile has them; for others use a permission set with "Create and Update Second-Generation Packages" and scratch org access).
3. **Know your limits.** Dev Hub editions limit daily and active scratch orgs and package versions. Check Setup, Company Information or the `sf org list limits` output before planning a large team workflow.
4. **Choose a namespace strategy.** Unlocked packages can be created without a namespace (simplest) or with one. This article uses no namespace.
5. **Production deploy permissions.** Decide who may install package versions into production, and require approvals.

### In the external system

1. Install **Node 20 or newer** and the **Salesforce CLI**: `npm install --global @salesforce/cli`. Check with `sf --version`.
2. Install **Visual Studio Code** and the **Salesforce Extension Pack**.
3. Create a **Git repository** (GitHub or similar) and agree on a branching model, such as short feature branches merged by pull request into `main`.
4. For CI, create a **JWT-based connected app / External Client App** in the Dev Hub org, generate a private key, and store the key and client id as repository secrets. See the OAuth article for the steps.
5. Authorise your Dev Hub locally: `sf org login web --set-default-dev-hub --alias devhub`.

## How it works

**Project:** a folder with `sfdx-project.json` (package directories, API version, aliases) and source in "source format" (one folder per metadata type, one file per component).

**Scratch org:** a short-lived, source-driven Salesforce org created from a **definition file**. It starts empty (or with the features and settings you list), lives 1 to 30 days, and is thrown away after the work. It supports **source tracking**: the CLI remembers what changed in the org and in your files, so `deploy` and `retrieve` move only differences.

**Sandboxes versus scratch orgs:** sandboxes copy configuration (and optionally data) from production and are long-lived; scratch orgs are built from your source and are for development and testing.

**Packages:** a **second-generation package** is a versioned, installable unit of metadata. An **unlocked package** is the open kind: you own it, can upgrade it and the installer can change it. A **managed package** (with namespace) protects intellectual property for AppExchange. Versions are created with `sf package version create`, tested in scratch orgs, **promoted** to released status, and installed into target orgs. A package can **depend** on another package, and the dependency must be listed before it in the project file.

**The loop:**

1. Create a scratch org.
2. Push source, assign permissions, load sample data.
3. Develop and test.
4. Pull any changes made in the org.
5. Commit, open a pull request; CI validates.
6. After merge, CI creates a package version and installs it in a sandbox.
7. Promote and install into production.

## Basic example

```bash
# One time: authorise the Dev Hub
sf org login web --set-default-dev-hub --alias devhub

# Create a project and a scratch org, then push the source
sf project generate --name juniper
cd juniper
sf org create scratch --definition-file config/project-scratch-def.json \
  --alias feature-x --duration-days 7 --set-default
sf project deploy start
sf org open

# After changing things in the org, bring them back
sf project retrieve start
```

## Advanced end-to-end example

The files below make everything repeatable. Create them in the project root.

**config/project-scratch-def.json**

```json
{
  "orgName": "Juniper Dev",
  "edition": "Developer",
  "features": ["EnableSetPasswordInApi"],
  "settings": {
    "lightningExperienceSettings": { "enableS1DesktopEnabled": true },
    "securitySettings": { "passwordPolicies": { "enableSetPasswordInApi": true } }
  }
}
```

**sfdx-project.json** has two packages; `app` depends on `core`.

```json
{
  "packageDirectories": [
    {
      "path": "core",
      "package": "Juniper-Core",
      "versionName": "Core",
      "versionNumber": "1.0.0.NEXT",
      "default": false
    },
    {
      "path": "app",
      "package": "Juniper-App",
      "versionName": "App",
      "versionNumber": "1.0.0.NEXT",
      "default": true,
      "dependencies": [
        { "package": "Juniper-Core", "versionNumber": "1.0.0.LATEST" }
      ]
    }
  ],
  "name": "juniper",
  "namespace": "",
  "sfdcLoginUrl": "https://login.salesforce.com",
  "sourceApiVersion": "67.0",
  "packageAliases": {}
}
```

**scripts/create-package.sh** creates the packages once. The CLI records the aliases in `sfdx-project.json`.

```bash
#!/usr/bin/env bash
set -euo pipefail

sf package create --name Juniper-Core --package-type Unlocked \
  --path core --no-namespace --target-dev-hub devhub
sf package create --name Juniper-App --package-type Unlocked \
  --path app --no-namespace --target-dev-hub devhub

echo "Packages created. Commit the updated sfdx-project.json."
```

**scripts/dev-setup.sh** is the one command every developer runs.

```bash
#!/usr/bin/env bash
set -euo pipefail

ALIAS="${1:-dev-$(date +%m%d)}"

echo "Creating scratch org $ALIAS ..."
sf org create scratch --definition-file config/project-scratch-def.json \
  --alias "$ALIAS" --duration-days 7 --set-default --target-dev-hub devhub

echo "Deploying source ..."
sf project deploy start --target-org "$ALIAS"

echo "Assigning permissions ..."
sf org assign permset --name Juniper_User --target-org "$ALIAS" || true

echo "Loading sample data ..."
if [ -f data/sample-plan.json ]; then
  sf data import tree --plan data/sample-plan.json --target-org "$ALIAS"
fi

echo "Running Apex tests ..."
sf apex run test --test-level RunLocalTests --result-format human --wait 20 --target-org "$ALIAS"

echo "Done. Open it with: sf org open --target-org $ALIAS"
```

**Version, test and release a package:**

```bash
# Create a package version (also runs tests and computes code coverage)
sf package version create --package Juniper-Core --installation-key-bypass \
  --code-coverage --wait 30 --target-dev-hub devhub
sf package version create --package Juniper-App --installation-key-bypass \
  --code-coverage --wait 30 --target-dev-hub devhub

# See versions, then install the new one into a sandbox
sf package version list --target-dev-hub devhub
sf package install --package Juniper-App@1.0.0-1 --target-org uat --wait 20 --publish-wait 10

# After testing, promote so it can be installed in production
sf package version promote --package Juniper-App@1.0.0-1 --target-dev-hub devhub
```

**tools/projectCheck.mjs** validates the project file and scratch definition before anything slow runs.

```javascript
// Checks sfdx-project.json and a scratch org definition for common problems.
const API_VERSION = /^\d{2}\.0$/;

export function checkProject(project) {
  const problems = [];
  const dirs = project.packageDirectories;
  if (!Array.isArray(dirs) || dirs.length === 0) {
    return ['packageDirectories is missing or empty.'];
  }

  const defaults = dirs.filter(d => d.default === true);
  if (defaults.length !== 1) {
    problems.push(`Exactly one package directory must be default (found ${defaults.length}).`);
  }
  if (!API_VERSION.test(String(project.sourceApiVersion ?? ''))) {
    problems.push('sourceApiVersion should look like "67.0".');
  }

  const names = new Set();
  const aliases = project.packageAliases ?? {};
  dirs.forEach((dir, index) => {
    if (!dir.path) {
      problems.push(`Directory ${index} has no path.`);
    }
    if (dir.package) {
      if (names.has(dir.package)) {
        problems.push(`Package ${dir.package} is listed twice.`);
      }
      names.add(dir.package);
      if (!dir.versionNumber || !/^\d+\.\d+\.\d+\.(NEXT|\d+)$/.test(dir.versionNumber)) {
        problems.push(`${dir.package}: versionNumber should look like 1.2.0.NEXT.`);
      }
      if (!aliases[dir.package]) {
        problems.push(`${dir.package}: no entry in packageAliases (create the package first).`);
      }
    }
  });

  // A package may only depend on packages that come before it in the file.
  dirs.forEach((dir, index) => {
    for (const dep of dir.dependencies ?? []) {
      const position = dirs.findIndex(d => d.package === dep.package);
      if (dep.package && position === -1 && !aliases[dep.package]) {
        problems.push(`${dir.package}: dependency ${dep.package} is unknown.`);
      } else if (position >= index) {
        problems.push(`${dir.package}: dependency ${dep.package} must be listed before it.`);
      }
    }
  });
  return problems;
}

export function checkScratchDefinition(def) {
  const problems = [];
  if (!def.orgName) {
    problems.push('orgName is missing.');
  }
  if (!['Developer', 'Enterprise', 'Group', 'Professional'].includes(def.edition)) {
    problems.push('edition must be Developer, Enterprise, Group or Professional.');
  }
  if (def.features !== undefined && !Array.isArray(def.features)) {
    problems.push('features must be a list.');
  }
  if (def.settings && typeof def.settings !== 'object') {
    problems.push('settings must be an object.');
  }
  return problems;
}

export function report(problems) {
  return problems.length === 0 ? 'OK' : problems.map(p => '- ' + p).join('\n');
}
```

**tools/projectCheck.test.mjs**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProject, checkScratchDefinition, report } from './projectCheck.mjs';

const good = {
  packageDirectories: [
    { path: 'core', package: 'Juniper-Core', versionNumber: '1.2.0.NEXT', default: false },
    { path: 'app', package: 'Juniper-App', versionNumber: '1.0.0.NEXT', default: true,
      dependencies: [{ package: 'Juniper-Core', versionNumber: '1.2.0.LATEST' }] }
  ],
  sourceApiVersion: '67.0',
  packageAliases: { 'Juniper-Core': '0Ho000000000001AAA', 'Juniper-App': '0Ho000000000002AAA' }
};

test('a correct project has no problems', () => {
  assert.deepEqual(checkProject(good), []);
  assert.equal(report([]), 'OK');
});

test('missing package directories are reported', () => {
  assert.deepEqual(checkProject({}), ['packageDirectories is missing or empty.']);
});

test('exactly one default directory is required', () => {
  const none = structuredClone(good);
  none.packageDirectories[1].default = false;
  assert.match(report(checkProject(none)), /Exactly one package directory/);
});

test('api version and version numbers are validated', () => {
  const bad = structuredClone(good);
  bad.sourceApiVersion = '67';
  bad.packageDirectories[0].versionNumber = '1.2';
  const text = report(checkProject(bad));
  assert.match(text, /sourceApiVersion/);
  assert.match(text, /versionNumber/);
});

test('a package without an alias must be created first', () => {
  const bad = structuredClone(good);
  delete bad.packageAliases['Juniper-App'];
  assert.match(report(checkProject(bad)), /no entry in packageAliases/);
});

test('dependencies must be listed before the package that needs them', () => {
  const bad = structuredClone(good);
  bad.packageDirectories.reverse();
  assert.match(report(checkProject(bad)), /must be listed before/);
});

test('scratch definitions need a name and a valid edition', () => {
  assert.deepEqual(checkScratchDefinition({ orgName: 'Dev', edition: 'Developer', features: ['EnableSetPasswordInApi'] }), []);
  const problems = checkScratchDefinition({ edition: 'Gold', features: 'x' });
  assert.equal(problems.length, 3);
});
```

**tools/check-project.mjs** runs the checks on your real files.

```javascript
import { readFileSync } from 'node:fs';
import { checkProject, checkScratchDefinition, report } from './projectCheck.mjs';

const project = JSON.parse(readFileSync('sfdx-project.json', 'utf8'));
const scratch = JSON.parse(readFileSync('config/project-scratch-def.json', 'utf8'));

const problems = [...checkProject(project), ...checkScratchDefinition(scratch)];
console.log(report(problems));
process.exit(problems.length === 0 ? 0 : 1);
```

**.github/workflows/validate.yml** runs the checks and a scratch-org validation on every pull request.

```yaml
name: validate
on:
  pull_request:

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm install --global @salesforce/cli
      - name: Project file checks
        run: |
          node --test tools/projectCheck.test.mjs
          node tools/check-project.mjs
      - name: Log in to the Dev Hub
        run: |
          echo "${{ secrets.JWT_KEY }}" > server.key
          sf org login jwt --client-id "${{ secrets.SF_CLIENT_ID }}" \
            --jwt-key-file server.key --username "${{ secrets.SF_DEVHUB_USER }}" \
            --set-default-dev-hub --alias devhub
      - name: Scratch org validation
        run: |
          sf org create scratch --definition-file config/project-scratch-def.json \
            --alias ci --duration-days 1 --set-default
          sf project deploy start --target-org ci
          sf apex run test --test-level RunLocalTests --result-format human --wait 30 --target-org ci
      - name: Delete the scratch org
        if: always()
        run: sf org delete scratch --target-org ci --no-prompt
```

## What happens behind the scenes

`sf org create scratch` sends the definition file to the Dev Hub. The Dev Hub builds a new org from a template of the chosen edition, applies the listed features and settings, and returns login details, which the CLI stores under your alias. Nothing is copied from production, which is why a scratch org is clean and the same every time.

**Source tracking** works by keeping a local record of what changed in each side. When you edit a file, the CLI marks it as a local change; when you edit in the org's Setup, the org tracks a remote change. `deploy` and `retrieve` use these to send only what is needed, and warn of conflicts when both sides changed the same component. That is what lets a developer click through Setup and then pull the result into source.

**Package versions** are built from a snapshot of source. `sf package version create` uploads the package directory, creates a **temporary scratch org**, installs dependencies, deploys the package, runs the Apex tests and measures code coverage, and only then records the version. Because the dependency is declared with `LATEST`, the version of `Juniper-Core` that exists at build time is pinned into the `Juniper-App` version. A version has a state: **beta** until promoted, then **released**. Production accepts only released versions, which is why promotion is a deliberate release step.

An unlocked package **upgrade** compares the installed components with the new version: it adds new components, updates changed ones and (depending on options) deletes components that the new version removed. This is the real advantage over change sets, which only copy and never track what belongs together.

The project check mirrors that logic. Dependencies must come before dependents because the CLI resolves packages in order; a missing package alias means the package was never created in the Dev Hub; a version number without `.NEXT` would try to reuse a fixed version. Finding these in seconds in CI avoids waiting several minutes for a package build to fail.

## Test it and verify

1. Run `node --test tools/projectCheck.test.mjs` and confirm all seven tests pass.
2. Run `bash scripts/create-package.sh` once, then `node tools/check-project.mjs` and confirm that it prints OK.
3. Run `bash scripts/dev-setup.sh my-first` and confirm the scratch org opens with your data and permissions.
4. Make a change in the org's Setup, run `sf project retrieve start`, and see the change appear in your files.
5. Create package versions, install `Juniper-App` into a sandbox, and confirm `Juniper-Core` was installed first.
6. Open a pull request and confirm that the workflow passes, and that the scratch org is deleted afterwards.

## Common mistakes and fixes

- **Enabling Dev Hub in the wrong org.** It cannot be disabled; choose carefully.
- **Long-lived scratch orgs.** They expire; keep setup in a script and recreate them.
- **Dependencies in the wrong order.** List the dependency first.
- **Hard-coded org ids and usernames in source.** Use aliases and environment secrets.
- **Package versions without tests.** Create them with code coverage and promote only tested versions.
- **Editing production directly.** Make changes in source, validate in a scratch org, release a package version.
- **Secrets in the repository.** Use secret storage for private keys and client ids.
- **Ignoring Dev Hub limits.** Delete finished scratch orgs and check limits regularly.
- **Skipping the check script.** Cheap checks first, expensive builds later.

## Key takeaways

- Git is the source of truth; scratch orgs are disposable workspaces.
- A definition file and a setup script make environments repeatable.
- Unlocked packages version your metadata and track upgrades.
- Dependencies are declared in order and pinned at build time.
- Validate cheaply in CI before building scratch orgs and packages.

## Where to go next

- Read [Git workflow for Salesforce teams](/articles/git-workflow-salesforce-teams/) for branching and reviews.
- Read [GitHub Actions for Salesforce CI](/articles/github-actions-salesforce-ci/) for deeper pipelines.
- Read [OAuth flows and External Client Apps](/articles/oauth-flows-and-external-client-apps/) for the JWT login used in CI.
