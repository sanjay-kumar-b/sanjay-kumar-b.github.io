---
title: "Apex Governor Limits Cheat Sheet: The Numbers That Actually Matter"
description: "The per-transaction Apex limits you hit most, sync vs async, plus a limits-aware renewal engine that measures itself and hands work to a Queueable."
category: salesforce-development
tags: [Apex, Governor Limits, Performance]
publishedAt: 2026-10-20
updatedAt: 2026-11-14
cover: /images/covers/apex-governor-limits-cheat-sheet.jpg
featured: true
sources:
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Salesforce is multitenant, so Apex runs under **governor limits** that stop one transaction from hogging shared resources. You cannot raise them. You design around them.

> Limits change between releases, and a few numbers (heap size is the one most often misquoted) have been listed differently over time. Treat the table below as a working reference and confirm every number on the linked Execution Governors and Limits page before you rely on it in a design review.

This article gives you the numbers, then shows how limits behave in a real feature: a renewal-reminder engine that measures its own limit usage, processes 200 records in a constant number of queries, and hands work to a Queueable when the transaction has no headroom left.

## The business scenario

Bluepeak Software (a fictional SaaS company) closes about 200 deals at the end of every quarter, often in one bulk update from a sales-ops import. When an Opportunity becomes Closed Won, the customer success team needs reminder Tasks for the account's first three contacts, due eleven months later. The feature must survive that bulk update, survive other automation on the same Opportunity (Flows and triggers share the same limit counters), and never fail the sales rep's save because of a limit.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox with Sales Cloud features (Accounts, Contacts, Opportunities, Activities). Verify: you can create an Opportunity and a Task.
2. Open Setup, search for Debug Logs, and add yourself as a traced user with a log level that includes `APEX_CODE` at `DEBUG` and `LIMITS` at `INFO` (Setup labels can differ slightly by release). Verify: running any Apex produces a log in the list with a `CUMULATIVE_LIMIT_USAGE` section.
3. Make sure your user has Create permission on Task and Read on Account, Contact and Opportunity. The code runs in user mode, so a missing permission is a failure you should see in testing.
4. Install the Salesforce CLI and log in: `sf org login web --alias dev`.

### In the external system

5. No external system is needed. Everything in this article runs inside Salesforce. If you later want to ship limit measurements to a monitoring tool, send them from a Queueable with a callout, never from the transaction you are measuring.

## How it works

Limits are counted **per transaction**. A transaction starts at an entry point (a record save, a REST call, a button click) and ends at commit or rollback. Everything inside it shares one set of counters: your triggers, record-triggered Flows, validation rules, and any other Apex. A trigger that is safe on its own can fail when a Flow on the same object also runs queries.

### Per-transaction limits

| Limit | Synchronous | Asynchronous |
|---|---|---|
| SOQL queries issued | 100 | 200 |
| Records retrieved by SOQL | 50,000 | 50,000 |
| Records from `Database.getQueryLocator` | 10,000 | 10,000 |
| SOSL queries issued | 20 | 20 |
| DML statements | 150 | 150 |
| Records processed by DML | 10,000 | 10,000 |
| Callouts (HTTP or web service) | 100 | 100 |
| Cumulative callout timeout | 120 seconds | 120 seconds |
| `System.enqueueJob` calls | 50 | 1 |
| `sendEmail` invocations | 10 | 10 |
| Heap size | 10 MB | 25 MB |
| CPU time | 10,000 ms | 60,000 ms |

Other facts to remember:

- Triggers and `for` loops over query results process records in chunks of **200**.
- Up to **5** Batch Apex jobs can be queued or active at once, and up to **100** can wait in the flex queue.
- Each `execute` of a Batch Apex job and each Queueable job gets **its own** fresh set of limits.
- `Test.startTest()` and `Test.stopTest()` give the code between them a fresh set of limits.
- Some limits are not per transaction at all (for example daily asynchronous Apex executions and API request totals). They are measured over 24 hours. Check the limits page for those.
- Summer '26 release notes describe elastic async limits as a beta for Queueable and `@future`, and API 67.0 changes some defaults for Apex security. Neither changes the per-transaction numbers above; read the current release notes before you plan around them.

### The `Limits` class

You can read usage at run time. The pattern is always `Limits.getX()` (used so far) and `Limits.getLimitX()` (the ceiling):

| Used | Ceiling |
|---|---|
| `Limits.getQueries()` | `Limits.getLimitQueries()` |
| `Limits.getQueryRows()` | `Limits.getLimitQueryRows()` |
| `Limits.getDmlStatements()` | `Limits.getLimitDmlStatements()` |
| `Limits.getDmlRows()` | `Limits.getLimitDmlRows()` |
| `Limits.getCpuTime()` | `Limits.getLimitCpuTime()` |
| `Limits.getHeapSize()` | `Limits.getLimitHeapSize()` |

## Basic example

The classic mistake, and its fix. Run both in the Developer Console's anonymous Apex window and compare.

**Bad: one query per record**

```apex
// Anonymous Apex
List<Contact> contacts = [SELECT Id, AccountId FROM Contact WHERE AccountId != null LIMIT 150];
Integer before = Limits.getQueries();
for (Contact c : contacts) {
    // BAD: a query inside a loop. 150 contacts = 150 queries = LimitException at 101.
    Account a = [SELECT Name FROM Account WHERE Id = :c.AccountId];
}
System.debug('Queries used: ' + (Limits.getQueries() - before));
```

Expected: the run fails with `System.LimitException: Too many SOQL queries: 101`.

**Good: one query, then a map lookup**

```apex
// Anonymous Apex
List<Contact> contacts = [SELECT Id, AccountId FROM Contact WHERE AccountId != null LIMIT 150];
Integer before = Limits.getQueries();

Set<Id> accountIds = new Set<Id>();
for (Contact c : contacts) {
    accountIds.add(c.AccountId);
}
Map<Id, Account> accounts = new Map<Id, Account>(
    [SELECT Id, Name FROM Account WHERE Id IN :accountIds]
);
for (Contact c : contacts) {
    Account a = accounts.get(c.AccountId); // no query here
}

System.debug('Queries used: ' + (Limits.getQueries() - before)); // 1
System.debug('Rows read: ' + Limits.getQueryRows() + ' of ' + Limits.getLimitQueryRows());
```

Expected: `Queries used: 1`, no matter how many contacts. The same rule applies to DML: collect records in a list and run one `insert` or `update` after the loop.

## Advanced end-to-end example

The renewal engine has five parts: a measuring helper, a guard that checks headroom, the planner that does the work in a fixed number of queries, a Queueable that takes overflow, and the trigger.

**`force-app/main/default/classes/LimitsSnapshot.cls`**

```apex
// Captures the current limit counters so you can print what a block of code consumed.
public class LimitsSnapshot {
    public final Integer queries;
    public final Integer queryRows;
    public final Integer dmlStatements;
    public final Integer dmlRows;
    public final Integer cpuTime;
    public final Integer heapSize;

    public LimitsSnapshot() {
        this.queries = Limits.getQueries();
        this.queryRows = Limits.getQueryRows();
        this.dmlStatements = Limits.getDmlStatements();
        this.dmlRows = Limits.getDmlRows();
        this.cpuTime = Limits.getCpuTime();
        this.heapSize = Limits.getHeapSize();
    }

    // What was used between 'start' and now.
    public static String usedSince(LimitsSnapshot start, String label) {
        LimitsSnapshot now = new LimitsSnapshot();
        return label
            + ' | SOQL ' + (now.queries - start.queries) + '/' + Limits.getLimitQueries()
            + ' | rows ' + (now.queryRows - start.queryRows) + '/' + Limits.getLimitQueryRows()
            + ' | DML ' + (now.dmlStatements - start.dmlStatements) + '/' + Limits.getLimitDmlStatements()
            + ' | DML rows ' + (now.dmlRows - start.dmlRows) + '/' + Limits.getLimitDmlRows()
            + ' | CPU ' + (now.cpuTime - start.cpuTime) + '/' + Limits.getLimitCpuTime() + ' ms'
            + ' | heap ' + now.heapSize + '/' + Limits.getLimitHeapSize();
    }
}
```

**`force-app/main/default/classes/LimitsGuard.cls`**

```apex
// Answers one question: does this transaction have room for the work I am about to do?
public class LimitsGuard {

    // Tests flip this to force the "no headroom" path.
    @TestVisible
    private static Boolean forceLow = false;

    private static final Integer CPU_RESERVE_MS = 2000;

    public static Boolean hasHeadroom(Integer queries, Integer dmlStatements, Integer dmlRows) {
        if (forceLow) {
            return false;
        }
        return (Limits.getLimitQueries() - Limits.getQueries()) > queries
            && (Limits.getLimitDmlStatements() - Limits.getDmlStatements()) > dmlStatements
            && (Limits.getLimitDmlRows() - Limits.getDmlRows()) > dmlRows
            && (Limits.getLimitCpuTime() - Limits.getCpuTime()) > CPU_RESERVE_MS;
    }
}
```

**`force-app/main/default/classes/RenewalResult.cls`**

```apex
public class RenewalResult {
    public Integer created = 0;
    public Integer failed = 0;
    public List<String> errors = new List<String>();
}
```

**`force-app/main/default/classes/RenewalPlanner.cls`**

```apex
public with sharing class RenewalPlanner {

    private static final Integer MAX_CONTACTS_PER_ACCOUNT = 3;
    private static final Integer MONTHS_UNTIL_RENEWAL_CHECK = 11;

    // Entry point from the trigger: run now if the transaction has room, else go async.
    public static void planFor(Set<Id> opportunityIds) {
        // Needs 2 queries, 1 DML statement, and up to 3 task rows per opportunity.
        if (LimitsGuard.hasHeadroom(2, 1, opportunityIds.size() * MAX_CONTACTS_PER_ACCOUNT)) {
            run(opportunityIds);
        } else {
            System.enqueueJob(new RenewalPlannerJob(opportunityIds));
        }
    }

    // The work itself: 2 queries and 1 DML statement for any number of opportunities (up to 200 per call).
    public static RenewalResult run(Set<Id> opportunityIds) {
        RenewalResult result = new RenewalResult();

        List<Opportunity> opps = [
            SELECT Id, Name, AccountId, CloseDate, OwnerId
            FROM Opportunity
            WHERE Id IN :opportunityIds AND AccountId != null
            WITH USER_MODE
        ];
        if (opps.isEmpty()) {
            return result;
        }

        Set<Id> accountIds = new Set<Id>();
        for (Opportunity o : opps) {
            accountIds.add(o.AccountId);
        }

        // One query for every account's contacts. The SOQL for-loop streams rows in chunks,
        // so a large result does not sit in memory all at once.
        Map<Id, List<Id>> contactsByAccount = new Map<Id, List<Id>>();
        for (Contact c : [
            SELECT Id, AccountId
            FROM Contact
            WHERE AccountId IN :accountIds
            WITH USER_MODE
            ORDER BY CreatedDate ASC
        ]) {
            List<Id> ids = contactsByAccount.get(c.AccountId);
            if (ids == null) {
                ids = new List<Id>();
                contactsByAccount.put(c.AccountId, ids);
            }
            if (ids.size() < MAX_CONTACTS_PER_ACCOUNT) {
                ids.add(c.Id);
            }
        }

        List<Task> tasks = new List<Task>();
        for (Opportunity o : opps) {
            List<Id> contactIds = contactsByAccount.get(o.AccountId);
            if (contactIds == null) {
                continue;
            }
            for (Id contactId : contactIds) {
                tasks.add(new Task(
                    Subject = 'Renewal check-in: ' + o.Name,
                    WhatId = o.Id,
                    WhoId = contactId,
                    OwnerId = o.OwnerId,
                    ActivityDate = o.CloseDate.addMonths(MONTHS_UNTIL_RENEWAL_CHECK),
                    Status = 'Not Started'
                ));
            }
        }

        if (tasks.isEmpty()) {
            return result;
        }

        // One DML statement, partial success allowed: one bad row must not drop the others.
        List<Database.SaveResult> saves = Database.insert(tasks, false, AccessLevel.USER_MODE);
        for (Integer i = 0; i < saves.size(); i++) {
            if (saves[i].isSuccess()) {
                result.created++;
            } else {
                result.failed++;
                result.errors.add(tasks[i].WhatId + ': ' + saves[i].getErrors()[0].getMessage());
            }
        }
        if (result.failed > 0) {
            System.debug(LoggingLevel.WARN, 'Renewal tasks failed: ' + result.errors);
        }
        return result;
    }
}
```

**`force-app/main/default/classes/RenewalPlannerJob.cls`**

```apex
// Overflow path. Async jobs have higher limits and their own counters.
public with sharing class RenewalPlannerJob implements Queueable {

    private static final Integer CHUNK_SIZE = 200;
    private final Set<Id> opportunityIds;

    public RenewalPlannerJob(Set<Id> opportunityIds) {
        this.opportunityIds = opportunityIds;
    }

    public void execute(QueueableContext context) {
        Set<Id> now = new Set<Id>();
        Set<Id> later = new Set<Id>();
        Integer position = 0;
        for (Id oppId : opportunityIds) {
            if (position < CHUNK_SIZE) {
                now.add(oppId);
            } else {
                later.add(oppId);
            }
            position++;
        }

        RenewalPlanner.run(now);

        if (!later.isEmpty()) {
            System.enqueueJob(new RenewalPlannerJob(later)); // chain the remainder
        }
    }
}
```

**`force-app/main/default/triggers/OpportunityRenewalTrigger.trigger`**

```apex
trigger OpportunityRenewalTrigger on Opportunity (after update) {
    Set<Id> newlyWon = new Set<Id>();
    for (Opportunity o : Trigger.new) {
        if (o.IsWon && !Trigger.oldMap.get(o.Id).IsWon) {
            newlyWon.add(o.Id);
        }
    }
    if (!newlyWon.isEmpty()) {
        RenewalPlanner.planFor(newlyWon);
    }
}
```

### Tests

**`force-app/main/default/classes/RenewalPlannerTest.cls`**

```apex
@IsTest
private class RenewalPlannerTest {

    @TestSetup
    static void setup() {
        List<Account> accounts = new List<Account>();
        for (Integer i = 0; i < 200; i++) {
            accounts.add(new Account(Name = 'Renewal Account ' + i));
        }
        insert accounts;

        List<Contact> contacts = new List<Contact>();
        List<Opportunity> opps = new List<Opportunity>();
        for (Account a : accounts) {
            contacts.add(new Contact(AccountId = a.Id, LastName = 'One'));
            contacts.add(new Contact(AccountId = a.Id, LastName = 'Two'));
            opps.add(new Opportunity(
                AccountId = a.Id,
                Name = 'Deal ' + a.Name,
                StageName = 'Prospecting',
                CloseDate = Date.today().addDays(30)
            ));
        }
        insert contacts;
        insert opps;
    }

    private static void closeAllOpportunities() {
        List<Opportunity> opps = [SELECT Id FROM Opportunity];
        for (Opportunity o : opps) {
            o.StageName = 'Closed Won';
        }
        update opps;
    }

    @IsTest
    static void bulkCloseCreatesTasksInConstantQueries() {
        Test.startTest(); // resets the counters, so measure after this line
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        closeAllOpportunities();
        Integer queriesUsed = Limits.getQueries() - queriesBefore;
        Integer dmlUsed = Limits.getDmlStatements() - dmlBefore;
        Test.stopTest();

        Assert.areEqual(400, [SELECT COUNT() FROM Task WHERE Subject LIKE 'Renewal check-in:%'],
            'Two contacts per account and 200 opportunities gives 400 tasks');
        // Planner uses 2 queries; the test's own query and other org automation need some room.
        Assert.isTrue(queriesUsed <= 8, 'Queries should stay constant, used: ' + queriesUsed);
        Assert.isTrue(dmlUsed <= 4, 'DML statements should stay constant, used: ' + dmlUsed);
    }

    @IsTest
    static void noHeadroomHandsTheWorkToAQueueable() {
        LimitsGuard.forceLow = true;

        Test.startTest();
        closeAllOpportunities();
        Integer tasksInsideTransaction = [SELECT COUNT() FROM Task WHERE Subject LIKE 'Renewal check-in:%'];
        Test.stopTest(); // the Queueable runs here

        Assert.areEqual(0, tasksInsideTransaction, 'Nothing is created inline when there is no headroom');
        Assert.areEqual(400, [SELECT COUNT() FROM Task WHERE Subject LIKE 'Renewal check-in:%'],
            'The Queueable creates all the tasks');
        Assert.isTrue(
            [SELECT COUNT() FROM AsyncApexJob WHERE ApexClass.Name = 'RenewalPlannerJob'] >= 1,
            'A RenewalPlannerJob must have been enqueued'
        );
    }

    @IsTest
    static void opportunitiesWithoutContactsCreateNoTasks() {
        delete [SELECT Id FROM Contact];

        Test.startTest();
        closeAllOpportunities();
        Test.stopTest();

        Assert.areEqual(0, [SELECT COUNT() FROM Task], 'No contacts, no reminders');
    }

    @IsTest
    static void snapshotReportsWhatWasUsed() {
        LimitsSnapshot start = new LimitsSnapshot();
        List<Account> accounts = [SELECT Id FROM Account LIMIT 5];
        String report = LimitsSnapshot.usedSince(start, 'check');
        Assert.isTrue(report.contains('SOQL 1/'), 'One query was used: ' + report);
        Assert.areEqual(5, accounts.size(), 'Query returned five rows');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names RenewalPlannerTest --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

Follow the bulk close of 200 Opportunities:

1. The `update` is **one** DML statement with 200 rows. The platform hands the trigger all 200 records in a single call (it chunks larger operations into groups of 200).
2. The trigger finds the 200 newly won ids and calls `planFor`. The guard reads the counters: queries used so far (a handful from other automation), DML used, CPU used. There is room, so `run` executes inline.
3. `run` issues query 1 (opportunities) and query 2 (contacts, via a SOQL for-loop). The query count does not grow with the number of records, which is the whole point.
4. The planner builds up to 600 Task objects in memory, then issues one `Database.insert` with partial success. It counts as one DML statement and up to 600 DML rows out of 10,000.
5. If other automation had already used most of the budget, the guard returns false and the work moves to a Queueable. The Queueable runs after the original transaction commits, in a new transaction with fresh counters and the async ceilings (for example 200 queries and 60,000 ms CPU).
6. In the debug log you would see `LIMIT_USAGE_FOR_NS` and `CUMULATIVE_LIMIT_USAGE` blocks that list each namespace's usage. Look at `Number of SOQL queries: 7 out of 100`: that total is the sum for the whole transaction, not just your class.

Why heap and CPU matter even in a design that looks small: CPU time counts everything Apex does, including the loops that build tasks, and it also includes time spent in triggers of other packages. Heap counts everything you hold in memory at once: large lists, long strings and big query results. SOQL for-loops, small chunks and not holding on to data you no longer need are the main defenses.

## Test it and verify

1. Run the test class. Expected: 4 passed. The two key tests are `bulkCloseCreatesTasksInConstantQueries` and `noHeadroomHandsTheWorkToAQueueable`.
2. Manually: in an org with demo data, close several Opportunities in a list view (mass edit). Open the Tasks list and look for `Renewal check-in:` records.
3. Print what the planner consumed. Run this anonymous Apex against Opportunity ids from your org:

```apex
// Anonymous Apex
Set<Id> ids = new Map<Id, Opportunity>([SELECT Id FROM Opportunity WHERE IsWon = true LIMIT 50]).keySet();
LimitsSnapshot start = new LimitsSnapshot();
RenewalResult r = RenewalPlanner.run(ids);
System.debug(LimitsSnapshot.usedSince(start, 'planner'));
System.debug('created=' + r.created + ' failed=' + r.failed);
```

Expected: `SOQL 2/100`, `DML 1/150`, and the same SOQL count whether the set holds 5 or 200 ids.
4. Open Setup, Apex Jobs, and run the forced-low scenario by temporarily creating many Flows or triggers that use queries. Easier: rely on the unit test, which proves the Queueable path.

## Common mistakes and fixes

- **Symptom: `Too many SOQL queries: 101` only in production.** Cause: your code is fine alone, but a Flow, a package trigger and your trigger share the counter. Fix: reduce queries everywhere on the object, and use the `CUMULATIVE_LIMIT_USAGE` log section to see which namespace used them.
- **Symptom: `Too many DML rows: 10001`.** Cause: a single transaction updates too many records, for example an import plus child updates. Fix: process in a Batch Apex job (200 rows per `execute` by default) or chunk the work through a Queueable chain.
- **Symptom: `Apex CPU time limit exceeded`.** Cause: nested loops over large collections, repeated string building, or heavy JSON work. Fix: precompute maps and sets, avoid `list.contains` in a loop, and move work to async.
- **Symptom: `Apex heap size too large`.** Cause: a large query result or a list that holds everything at once. Fix: use SOQL for-loops, select fewer fields, and process in smaller batches. Confirm the current heap ceiling on the limits page.
- **Symptom: a test passes with 3 records and fails with 200.** Cause: a hidden SOQL or DML in a loop. Fix: every trigger needs a 200-record test with a limit assertion, as shown above.
- **Symptom: `Too many queueable jobs added to the queue: 2` from async code.** Cause: a Queueable can enqueue only one job. Fix: chain one job at a time, as `RenewalPlannerJob` does.
- **Symptom: you "fixed" a limit by using `Test.isRunningTest()`.** Cause: the production path is untested. Fix: add a test seam such as `LimitsGuard.forceLow` that runs the real code.
- **Symptom: limit assumptions copied from an old blog post.** Fix: read the current Execution Governors and Limits page for the numbers you design around, and write the page version next to them in your design document.

## Key takeaways

- Limits are per transaction and shared by all automation on the record.
- Use maps and sets: one query and one DML statement per object type, not per record.
- Read `Limits.getX()` and `Limits.getLimitX()` to measure and to decide.
- Async jobs reset the counters and raise some ceilings, so hand overflow work to a Queueable or Batch Apex.
- Prove it with a 200-record test that asserts query and DML counts.

## Where to go next

- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
- [Batch Apex: the complete guide](/articles/batch-apex-complete-guide/)
- [Writing Apex tests that actually catch bugs](/articles/apex-test-classes-best-practices/)
