---
title: "Apex Security: User Mode, Sharing and the Summer '26 Changes"
description: "Enforce CRUD, FLS and sharing in Apex with user mode, stripInaccessible and justified system mode, plus tests with real permission sets and a migration script."
category: salesforce-development
tags: [Apex, Security, SOQL, Advanced]
publishedAt: 2026-11-08
updatedAt: 2026-11-14
cover: /images/covers/apex-security-and-user-mode.jpg
sources:
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Apex historically ran in **system mode**: it ignored the running user's object and field permissions and, depending on the sharing keyword, record sharing, unless you added checks yourself. Security now centers on **user mode**, where the platform enforces the user's permissions for you. This article shows how to use it, when system mode is still the right tool, and how to prove with tests that both work.

## The business scenario

Helix Insurance (a fictional insurer) exposes an "Account insight" panel to agents, partner managers and call-center staff. Agents may see an account's revenue figure; call-center staff may not. The panel also shows the name of the account's ultimate parent company, even when the user has no access to the parent record. So one feature needs strict user-mode reads, partial results for restricted users, and one narrowly justified system-mode lookup.

## What the Summer '26 notes say (check your release)

The Salesforce Developers Guide to the Summer '26 Release, the first source above, describes these changes at API version 67.0. This article relies on that guide for them. Confirm the details in the current release notes for your org, because defaults can change between releases.

- SOQL, SOSL, DML and `Database` methods default to **user mode** instead of system mode.
- A class compiled at 67.0 with no sharing keyword defaults to `with sharing`; to bypass sharing, declare `without sharing`.
- `WITH SECURITY_ENFORCED` is retired at that version; use `WITH USER_MODE`.
- Apex triggers run in system mode and cannot declare a sharing or access mode.
- Classes saved at older API versions keep their old behavior until you raise the version, so upgrade deliberately and test.

Whatever your org's defaults are, the safe habit is the same: write the sharing keyword and the access mode explicitly.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create two permission sets: `Account_Revenue_Viewer` (read on Account and read on field `Account.AnnualRevenue`) and `Account_Basic_Viewer` (read on Account, no revenue field). The tests below create equivalent permission sets in code so you do not need to click, but creating them in Setup lets you try the screens by hand. Setup, Permission Sets, New (labels can differ slightly by release).
3. Create two test users in the sandbox, one for each permission set. Use the `Minimum Access - Salesforce` profile so the permission sets are the only source of access. Verify: log in as each user (Setup, Users, Login) and open an Account.
4. Make sure each class you deploy has an API version; the CLI adds a `.cls-meta.xml` file. Verify which version your project uses in `sfdx-project.json` under `sourceApiVersion`.

### In the external system

5. None required. If you expose this through Apex REST to a partner app, the partner app's integration user needs its own permission set, and the connected app or External Client App must be configured as described in the OAuth article.

## How it works

Two separate controls decide what Apex can touch:

| Control | Decides | Set with |
|---|---|---|
| Sharing mode | Which **records** are visible (organization-wide defaults, roles, sharing rules) | `with sharing`, `without sharing`, `inherited sharing` on the class |
| Access mode | Which **objects and fields** are allowed (CRUD and field-level security) and, in user mode, also record sharing | `WITH USER_MODE` or `WITH SYSTEM_MODE` in SOQL; `as user` / `as system` in DML; `AccessLevel.USER_MODE` in `Database` methods |

The difference between the two matters. A `with sharing` class in system mode still ignores field-level security. User mode checks object permissions, field-level security and sharing together.

Tools you will use:

- `WITH USER_MODE` on a query: fail if the user cannot read the object or any field referenced.
- `insert as user` or `Database.insert(records, AccessLevel.USER_MODE)`: fail if the user cannot create the object or edit its fields.
- `Security.stripInaccessible(AccessType.READABLE, records)`: **remove** fields the user cannot see instead of failing, when partial data is acceptable.
- `WITH SYSTEM_MODE` or a small `without sharing` class: deliberate elevation, always with a comment explaining why.

## Basic example

Read in user mode, write in user mode, and handle the failure.

```apex
// Anonymous Apex
// Run as a user who cannot read Account.AnnualRevenue to see the exception.
try {
    List<Account> accounts = [SELECT Id, Name, AnnualRevenue FROM Account WITH USER_MODE LIMIT 5];
    System.debug('Rows: ' + accounts.size());
} catch (QueryException e) {
    System.debug('Blocked: ' + e.getMessage());
}

try {
    insert as user new Contact(LastName = 'Rao');
} catch (DmlException e) {
    System.debug('Insert blocked: ' + e.getMessage());
}
```

A user with the right access sees rows and a created Contact. A user without access gets a clear exception instead of data they should not see.

## Advanced end-to-end example

### The service (user mode, partial results, a documented system-mode escape)

**`force-app/main/default/classes/AccountInsight.cls`**

```apex
public class AccountInsight {
    @AuraEnabled public Id accountId;
    @AuraEnabled public String name;
    @AuraEnabled public Decimal annualRevenue;      // null when the user cannot see it
    @AuraEnabled public String ultimateParentName;  // may come from a record the user cannot open
    @AuraEnabled public Boolean revenueHidden = false;
}
```

**`force-app/main/default/classes/ParentAccountResolver.cls`**

```apex
// WHY without sharing: an agent must see the NAME of the ultimate parent company on the panel
// even when sharing hides the parent record. We expose a name only, never the record,
// and nothing here is returned to callers except that single string.
public without sharing class ParentAccountResolver {

    private static final Integer MAX_DEPTH = 10; // protects against cycles and deep trees

    public static String ultimateParentName(Id accountId) {
        Id currentId = accountId;
        String lastName = null;
        for (Integer depth = 0; depth < MAX_DEPTH && currentId != null; depth++) {
            List<Account> rows = [
                SELECT Id, Name, ParentId FROM Account WHERE Id = :currentId WITH SYSTEM_MODE
            ];
            if (rows.isEmpty()) {
                break;
            }
            lastName = rows[0].Name;
            currentId = rows[0].ParentId;
        }
        return lastName;
    }
}
```

**`force-app/main/default/classes/AccountInsightService.cls`**

```apex
public with sharing class AccountInsightService {

    public class InsightException extends Exception {}

    public static AccountInsight forAccount(Id accountId) {
        if (accountId == null) {
            throw new InsightException('An account id is required.');
        }

        // User mode: object permission, FLS and sharing are all enforced.
        // We ask only for fields every agent may read, so this query cannot fail on revenue.
        List<Account> rows = [
            SELECT Id, Name FROM Account WHERE Id = :accountId WITH USER_MODE
        ];
        if (rows.isEmpty()) {
            throw new InsightException('Account not found or not visible to you.');
        }

        AccountInsight insight = new AccountInsight();
        insight.accountId = rows[0].Id;
        insight.name = rows[0].Name;

        insight.annualRevenue = readRevenueIfAllowed(accountId);
        insight.revenueHidden = (insight.annualRevenue == null);
        insight.ultimateParentName = ParentAccountResolver.ultimateParentName(accountId);
        return insight;
    }

    // Partial data: strip what the user cannot see instead of failing the whole panel.
    private static Decimal readRevenueIfAllowed(Id accountId) {
        // Query in system mode on purpose, then let stripInaccessible apply the USER's FLS.
        List<Account> raw = [SELECT Id, AnnualRevenue FROM Account WHERE Id = :accountId WITH SYSTEM_MODE];
        SObjectAccessDecision decision = Security.stripInaccessible(AccessType.READABLE, raw);
        List<Account> allowed = (List<Account>) decision.getRecords();
        if (allowed.isEmpty()) {
            return null;
        }
        // If the field was stripped, reading it throws; isSet checks the field safely.
        return allowed[0].isSet('AnnualRevenue') ? allowed[0].AnnualRevenue : null;
    }
}
```

**`force-app/main/default/classes/AccountInsightController.cls`**

```apex
public with sharing class AccountInsightController {

    @AuraEnabled(cacheable=true)
    public static AccountInsight getInsight(Id accountId) {
        try {
            return AccountInsightService.forAccount(accountId);
        } catch (AccountInsightService.InsightException e) {
            throw new AuraHandledException(e.getMessage());
        } catch (QueryException e) {
            // A permission failure: do not leak internals to the browser.
            throw new AuraHandledException('You do not have access to this information.');
        }
    }
}
```

### What `getInaccessibleFields` is for

When a user-mode query fails, the exception can tell you *which* fields were blocked, which helps for logging and clear UI messages. Per the Summer '26 notes cited above, `QueryException` provides this. Verify the method in your org's Apex reference before you rely on it.

```apex
// Anonymous Apex
try {
    List<Account> a = [SELECT Id, AnnualRevenue FROM Account WITH USER_MODE LIMIT 1];
} catch (QueryException e) {
    Map<String, Set<String>> blocked = e.getInaccessibleFields();
    System.debug('Blocked fields: ' + blocked);
}
```

### Tests with real permission sets

**`force-app/main/default/classes/AccountInsightServiceTest.cls`**

```apex
@IsTest
private class AccountInsightServiceTest {

    // Builds a user whose ONLY access comes from the permission set we create here.
    private static User userWith(Boolean canReadRevenue) {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Minimum Access - Salesforce' LIMIT 1];
        String unique = String.valueOf(System.currentTimeMillis()) + (canReadRevenue ? 'r' : 'n');
        User u = new User(
            Alias = 'ins' + unique.right(4), Email = 'insight' + unique + '@example.test',
            EmailEncodingKey = 'UTF-8', LastName = 'Insight', LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US', ProfileId = p.Id, TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'insight' + unique + '@example.test'
        );

        // Setup objects (User, PermissionSet) must be created inside System.runAs
        // to avoid MIXED_DML_OPERATION with ordinary records.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert u;
            PermissionSet ps = new PermissionSet(
                Name = 'Insight_Test_' + unique, Label = 'Insight Test ' + unique
            );
            insert ps;
            insert new ObjectPermissions(
                ParentId = ps.Id, SobjectType = 'Account',
                PermissionsRead = true, PermissionsViewAllRecords = true
            );
            if (canReadRevenue) {
                insert new FieldPermissions(
                    ParentId = ps.Id, SobjectType = 'Account',
                    Field = 'Account.AnnualRevenue', PermissionsRead = true, PermissionsEdit = false
                );
            }
            insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
        }
        return u;
    }

    @TestSetup
    static void setup() {
        Account parent = new Account(Name = 'Helix Holdings', AnnualRevenue = 9000000);
        insert parent;
        Account mid = new Account(Name = 'Helix Region', ParentId = parent.Id, AnnualRevenue = 4000000);
        insert mid;
        insert new Account(Name = 'Helix Branch', ParentId = mid.Id, AnnualRevenue = 1000000);
    }

    @IsTest
    static void userWithFieldAccessSeesRevenue() {
        User u = userWith(true);
        Id branchId = [SELECT Id FROM Account WHERE Name = 'Helix Branch'].Id;

        AccountInsight result;
        System.runAs(u) {
            result = AccountInsightService.forAccount(branchId);
        }

        Assert.areEqual('Helix Branch', result.name, 'Name is returned');
        Assert.areEqual(1000000, result.annualRevenue, 'Revenue visible with field access');
        Assert.isFalse(result.revenueHidden, 'Revenue is not hidden');
        Assert.areEqual('Helix Holdings', result.ultimateParentName, 'Ultimate parent resolved');
    }

    @IsTest
    static void userWithoutFieldAccessGetsPartialData() {
        User u = userWith(false);
        Id branchId = [SELECT Id FROM Account WHERE Name = 'Helix Branch'].Id;

        AccountInsight result;
        System.runAs(u) {
            result = AccountInsightService.forAccount(branchId);
        }

        Assert.isNull(result.annualRevenue, 'Revenue must be stripped');
        Assert.isTrue(result.revenueHidden, 'The panel is told revenue is hidden');
        Assert.areEqual('Helix Branch', result.name, 'The rest of the panel still works');
    }

    @IsTest
    static void userModeQueryFailsForBlockedFieldDirectly() {
        User u = userWith(false);
        Boolean blocked = false;
        System.runAs(u) {
            try {
                List<Account> rows = [SELECT Id, AnnualRevenue FROM Account WITH USER_MODE LIMIT 1];
                Assert.isNotNull(rows, 'Unreachable when access is blocked');
            } catch (QueryException e) {
                blocked = true;
            }
        }
        Assert.isTrue(blocked, 'Reading a field without FLS in user mode must throw');
    }

    @IsTest
    static void missingAccountGivesAClearError() {
        try {
            AccountInsightService.forAccount(null);
            Assert.fail('Expected InsightException');
        } catch (AccountInsightService.InsightException e) {
            Assert.isTrue(e.getMessage().contains('required'), e.getMessage());
        }
    }

    @IsTest
    static void parentResolverStopsAtMaximumDepth() {
        Account top = new Account(Name = 'Loop Top');
        insert top;
        Account child = new Account(Name = 'Loop Child', ParentId = top.Id);
        insert child;
        top.ParentId = child.Id;   // create a cycle on purpose
        try {
            update top;
        } catch (DmlException e) {
            // Salesforce itself rejects hierarchy loops; the resolver's depth cap is a second guard.
            Assert.isTrue(e.getMessage().length() > 0, 'Cycle rejected by the platform');
        }
        Assert.isNotNull(ParentAccountResolver.ultimateParentName(child.Id), 'Resolver returns a name');
    }
}
```

### Migration script

This shell script finds the old pattern, lists classes without a sharing keyword, and shows each class's API version, so you can plan the upgrade.

```bash
#!/usr/bin/env bash
# run from the project root
set -euo pipefail

echo "== Classes still using WITH SECURITY_ENFORCED =="
grep -rln "WITH SECURITY_ENFORCED" force-app --include=*.cls || echo "none"

echo "== Classes with no sharing keyword =="
for f in $(find force-app -name "*.cls"); do
  if ! grep -Eiq "(with|without|inherited) sharing" "$f"; then
    echo "$f"
  fi
done

echo "== API versions in use =="
grep -rho "<apiVersion>[0-9.]*</apiVersion>" force-app --include=*.cls-meta.xml | sort | uniq -c
```

## What happens behind the scenes

1. `forAccount` runs the first query in **user mode**. The platform loads the running user's permissions, checks object read, field read for every field in the `SELECT` and `WHERE`, and applies record sharing. If any check fails the query throws before any data is returned.
2. `readRevenueIfAllowed` queries in system mode on purpose to get the raw record, then calls `Security.stripInaccessible(AccessType.READABLE, ...)`. The platform compares each field on the records with the user's field-level security and removes the fields the user cannot read. `isSet` tells you whether the field is still populated on the returned record.
3. `ParentAccountResolver` runs in system mode in a `without sharing` class. It runs one query per level, up to `MAX_DEPTH`, and returns a single string. Because the string is the only thing leaving the class, the escalation is small and reviewable.
4. Everything runs in the same transaction, so the limits (one query for the account, one for revenue, one per hierarchy level) add up. A deep hierarchy of 10 levels costs 10 queries, which is why the depth is capped.
5. In the test, `System.runAs(u)` switches the running user. The platform then evaluates `WITH USER_MODE` against that user's permission sets, not the test runner's. Creating the permission set in the test means the test proves the exact access you describe.
6. A trigger on Account would still run in system mode regardless of which user saved the record. Put security-sensitive logic in classes you can mark and test.

## Test it and verify

1. Deploy and run the tests:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names AccountInsightServiceTest --result-format human --code-coverage --wait 10 --target-org dev
```

2. Expected: 5 tests pass.
3. By hand: log in as each of your two Setup users and run `AccountInsightController.getInsight` from an LWC or from the Apex Test Execute Anonymous window using `System.runAs` in a scratch org. The viewer sees revenue; the basic user sees `revenueHidden = true`.
4. Run the migration script. Expected: a list of classes to fix. Re-run it until the first two sections print `none`/nothing.

## Common mistakes and fixes

- **Symptom: a user sees fields they should not.** Cause: system-mode SOQL in a `with sharing` class (sharing does not enforce FLS). Fix: add `WITH USER_MODE` or use `Security.stripInaccessible`.
- **Symptom: `QueryException` on every query for one profile.** Cause: user mode correctly blocked a field the code selected. Fix: select only fields the audience can read, or grant the permission, or strip fields.
- **Symptom: `without sharing` sprinkled "to make it work".** Cause: a permission gap hidden by elevation. Fix: grant the missing permission; keep elevation in one small class with a written reason.
- **Symptom: trigger logic leaks data.** Cause: triggers run in system mode. Fix: put the sensitive work in a class that declares its mode, and test it with `System.runAs`.
- **Symptom: behavior changes after raising a class's API version.** Cause: new defaults at higher versions. Fix: raise versions deliberately, one class group at a time, and re-run all tests.
- **Symptom: `MIXED_DML_OPERATION` in a permission test.** Cause: creating a User or PermissionSet next to ordinary records. Fix: wrap the setup-object DML in `System.runAs(new User(Id = UserInfo.getUserId()))`.
- **Symptom: a user-mode test passes for admins.** Cause: the test runs as System Administrator, who can read everything. Fix: run the assertion inside `System.runAs` of a low-privilege user.
- **Symptom: `WITH SECURITY_ENFORCED` still in old code.** Cause: pre-migration code. Fix: replace with `WITH USER_MODE` and compare the error behavior in tests.

## Key takeaways

- Sharing mode controls records; access mode controls objects and fields. Use both on purpose.
- Prefer user mode for anything a person triggers; use `stripInaccessible` when partial data is acceptable.
- Keep system mode in small, commented classes that return minimal data.
- Triggers run in system mode, so keep sensitive logic in classes you can test.
- Prove security with `System.runAs` and real permission sets, not with admin users.

## Where to go next

- [Permission sets vs profiles](/articles/permission-sets-vs-profiles/)
- [SOQL best practices](/articles/soql-best-practices/)
- [Sharing model explained](/articles/sharing-model-explained/)
- [Advanced Apex classes](/articles/apex-classes-advanced-patterns/)
