---
title: "Batch Apex Complete Guide: From First Batch to Stateful, Chained Jobs"
description: "Learn Batch Apex end to end: start/execute/finish, scope size, Database.Stateful, error summaries, platform events, chaining, scheduling and testing."
category: salesforce-development
tags: [Batch Apex, Apex, Async, Advanced]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/batch-apex-complete-guide.jpg
sources:
  - title: "Using Batch Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_batch.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "Subscribe to Platform Events with Apex Triggers (Platform Events Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/platform_events_subscribe_apex.htm"
---

Batch Apex processes a large set of records in small chunks. Salesforce reads the records, slices them into scopes (the chunk size, 200 by default), and runs your code once per scope. Each run is its own transaction with its own governor limits. A million records is therefore not one giant transaction. It is thousands of small ones, and one failing chunk does not undo the others.

Batch Apex is the right tool when the work is large, can wait, and is naturally "for every record matching this query". It is the wrong tool for one-off follow-up work after a save (use Queueable Apex) or for small lists. If you are still choosing, read [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/) first.

This article starts with a minimal batch, then builds a production-style nightly archival and data-quality job. The job keeps running totals with `Database.Stateful`, tolerates bad records, reports errors by email and platform event, chains a second job, and is scheduled and tested.

## The business scenario

Northwind Subscriptions (a fictional SaaS company) has years of closed support cases. They slow down reports and inflate storage. The rules for the nightly job:

1. Every night, copy closed cases older than a retention period (default 730 days) into a lightweight `Case_Archive__c` object, then flag the case as archived.
2. Re-running must be safe. A case that was copied but not flagged (because of an error) must not create a duplicate archive row.
3. Count cases that have no contact. They are a data-quality problem the support-ops team wants to see.
4. One bad record must not stop the job. At the end, send a short summary: how many scanned, archived, failed, and the first few error messages.
5. Publish a platform event with the same summary so monitoring tools can react.
6. When the archive step finishes, automatically start a second job that purges archive rows past their own, longer, retention period.
7. Retention, batch size and the notification address are admin-editable without a deployment.

## Before you start: setup

Use a Developer Edition org or a scratch org. Labels can differ slightly by release, so use Quick Find in Setup if a path has moved. This job needs no external system. The "external" parts are an email inbox and, optionally, a monitoring subscriber to the platform event.

### In Salesforce

1. **Enable email deliverability.** Setup, Email, Deliverability, set Access level to "All email". Why: the summary email is not sent otherwise. Verify: send a test email from Setup, Email, Send Test Email.
2. **Create the custom fields on Case.** Object Manager, Case, Fields & Relationships: `Archived__c` (Checkbox, default unchecked). Why: the job's query excludes archived cases. Verify: the field appears on a Case in the field list.
3. **Create the custom object `Case_Archive__c`.** Fields: `Name` (Text, 80), `Source_Case_Id__c` (Text 18, External ID, Unique), `Subject__c` (Text 255), `Account_Id__c` (Text 18), `Closed_On__c` (Date/Time). Why: the external ID is what makes the upsert idempotent. Verify: Object Manager shows `Source_Case_Id__c` with "External ID" and "Unique" ticked.
4. **Create the custom metadata type `Archive_Setting__mdt`.** Fields: `Retention_Days__c` (Number 18,0), `Batch_Size__c` (Number 18,0), `Purge_After_Days__c` (Number 18,0), `Notify_Email__c` (Email). Then create one record named `Default`. Why: admins change behaviour here instead of redeploying. Verify: Setup, Custom Metadata Types, Manage Records shows the `Default` row.
5. **Create the platform event `Batch_Run_Summary__e`.** Setup, Platform Events, New Platform Event. Fields: `Job_Id__c` (Text 18), `Status__c` (Text 255), `Scanned__c`, `Archived__c`, `Failed__c`, `Flagged__c` (all Number 18,0). Why: this is the job's machine-readable report. Verify: it appears under Platform Events.
6. **Run the job as a dedicated user.** Create a permission set with read and edit on Case (including `Archived__c`) and create, read, delete on `Case_Archive__c`, and assign it to an integration or admin user. Why: the code reads with `WITH USER_MODE`, so the running user's CRUD and FLS apply. A scheduled job runs as the user who scheduled it. Verify: log in as that user and open a closed case and an archive record.
7. **Create test data.** After deploying, create at least a few closed cases. Why: you need rows for the query to find. Verify: `SELECT COUNT() FROM Case WHERE IsClosed = true` returns more than zero.

### On your machine

1. Install the Salesforce CLI and authorize an org: `sf org login web --alias dev`. Verify with `sf org list`.
2. Create a folder structure `force-app/main/default/...` as used in the file paths below (an SFDX project from `sf project generate --name archive-demo`).

## How it works

A batch class implements `Database.Batchable<SObject>`, which has three methods.

| Method | Runs | What it does |
|---|---|---|
| `start` | Once | Returns the records to process: a `Database.QueryLocator` or an `Iterable`. |
| `execute` | Once per scope | Receives a list of records and does the work. Fresh limits every time. |
| `finish` | Once | Runs after the last scope. Good for summaries and chaining. |

Key terms:

- **Scope**: the list of records passed to one `execute`. Set it in `Database.executeBatch(job, scopeSize)`. The maximum is 2,000.
- **QueryLocator**: a server-side cursor over the query. A query locator can return up to 50 million rows, far more than a normal SOQL query.
- **Database.Stateful**: by default each `execute` gets a fresh copy of your instance variables, so counters reset. Implementing this marker interface makes Salesforce serialize the instance between scopes so totals survive. Serialization costs time and heap, so keep the state small.
- **AsyncApexJob**: the record Salesforce keeps for each job, with status and error counts. You can query it in `finish` using `bc.getJobId()`.
- **Flex queue**: a holding area for batch jobs waiting for one of the limited active slots. Check the Apex Developer Guide for the current concurrency numbers.

```text
executeBatch(job, 200)
   |
   v
start()  --> QueryLocator (cursor over N records)
   |
   +--> execute(scope 1: 200 records)   own transaction, own limits
   +--> execute(scope 2: 200 records)   own transaction, own limits
   +--> ...                             a failure here does not roll back scope 1
   |
   v
finish()   summary, email, event, chain next job
```

Between scopes, the platform stores your state (if Stateful), queues the next scope, and runs it when capacity allows. Scopes can run minutes apart on a busy org. Never assume the data you queried in `start` is still unchanged when a scope runs.

## Basic example

The smallest useful batch marks stale leads as cold. It uses `Database.Stateful` so the totals survive across scopes.

```apex
public class ColdenStaleLeadsBatch implements Database.Batchable<SObject>, Database.Stateful {
    private Integer updated = 0;
    private Integer failed = 0;

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator([
            SELECT Id, Rating FROM Lead
            WHERE IsConverted = false AND LastActivityDate < LAST_N_DAYS:365
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Lead> scope) {
        for (Lead l : scope) {
            l.Rating = 'Cold';
        }
        // false = partial success: good rows save, bad rows return an error
        List<Database.SaveResult> results = Database.update(scope, false);
        for (Database.SaveResult r : results) {
            if (r.isSuccess()) {
                updated++;
            } else {
                failed++;
            }
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('Leads updated=' + updated + ', failed=' + failed);
    }
}
```

Run it from Anonymous Apex:

```apex
// Anonymous Apex
Id jobId = Database.executeBatch(new ColdenStaleLeadsBatch(), 200);
System.debug('Started batch job ' + jobId);
```

Expected result: a job Id is returned immediately. Under Setup, Apex Jobs, the job moves from Queued to Processing to Completed. The debug log for `finish` prints the totals.

The most common beginner bug is losing state. This version looks fine but always prints zero:

```apex
public class LostStateBatch implements Database.Batchable<SObject> {
    // BAD: no Database.Stateful, so this resets to 0 for every scope
    private Integer updated = 0;

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator('SELECT Id FROM Lead LIMIT 1000');
    }

    public void execute(Database.BatchableContext bc, List<Lead> scope) {
        updated += scope.size();
    }

    public void finish(Database.BatchableContext bc) {
        // finish runs on a deserialized copy. Without Stateful, this prints 0.
        System.debug('Updated: ' + updated);
    }
}
```

The fix is the one in the first example: add `Database.Stateful` to the `implements` list.

## Advanced end-to-end example

The files below build the nightly archive job: settings, the batch, the chained purge job, the scheduler, metadata and tests.

**`force-app/main/default/classes/CaseArchiveSettings.cls`**

```apex
/**
 * Reads admin-editable settings from Archive_Setting__mdt with safe defaults,
 * so the job still runs if the record is missing.
 */
public with sharing class CaseArchiveSettings {
    public Integer retentionDays { get; private set; }
    public Integer batchSize { get; private set; }
    public Integer purgeAfterDays { get; private set; }
    public String notifyEmail { get; private set; }

    private CaseArchiveSettings() {
        retentionDays = 730;
        batchSize = 200;
        purgeAfterDays = 2555;
    }

    public static CaseArchiveSettings load() {
        CaseArchiveSettings s = new CaseArchiveSettings();
        Archive_Setting__mdt rec = Archive_Setting__mdt.getInstance('Default');
        if (rec != null) {
            if (rec.Retention_Days__c != null) {
                s.retentionDays = Integer.valueOf(rec.Retention_Days__c);
            }
            if (rec.Batch_Size__c != null) {
                s.batchSize = Integer.valueOf(rec.Batch_Size__c);
            }
            if (rec.Purge_After_Days__c != null) {
                s.purgeAfterDays = Integer.valueOf(rec.Purge_After_Days__c);
            }
            s.notifyEmail = rec.Notify_Email__c;
        }
        // Scope size must be between 1 and 2000
        s.batchSize = Math.max(1, Math.min(2000, s.batchSize));
        return s;
    }
}
```

**`force-app/main/default/classes/CaseArchiveBatch.cls`**

```apex
/**
 * Nightly job: copy old closed cases to Case_Archive__c, flag them, report.
 * Stateful: running totals and a capped error list survive across scopes.
 * RaisesPlatformEvents: unhandled exceptions publish BatchApexErrorEvent.
 */
public with sharing class CaseArchiveBatch
    implements Database.Batchable<SObject>, Database.Stateful, Database.RaisesPlatformEvents {

    // Test seam: ids listed here are treated as failed archive rows
    @TestVisible private static Set<Id> simulatedFailures = new Set<Id>();

    private static final Integer MAX_ERRORS_KEPT = 50;
    private static final Integer MAX_ERRORS_EMAILED = 10;

    private final Datetime cutoff;
    private Integer scanned = 0;
    private Integer archived = 0;
    private Integer failed = 0;
    private Integer flagged = 0;
    private List<String> errorLines = new List<String>();

    public CaseArchiveBatch(Integer retentionDays) {
        this.cutoff = Datetime.now().addDays(-retentionDays);
    }

    public Database.QueryLocator start(Database.BatchableContext bc) {
        // Fail fast if the running user cannot create archive rows
        if (!Schema.SObjectType.Case_Archive__c.isCreateable()) {
            throw new CaseArchiveException('User cannot create Case_Archive__c records');
        }
        Datetime cutoffValue = cutoff;
        return Database.getQueryLocator([
            SELECT Id, CaseNumber, Subject, ClosedDate, AccountId, ContactId
            FROM Case
            WHERE IsClosed = true AND Archived__c = false AND ClosedDate < :cutoffValue
            WITH USER_MODE
            ORDER BY ClosedDate
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Case> scope) {
        scanned += scope.size();

        // 1. Build one archive row per case (no SOQL or DML inside this loop)
        List<Case_Archive__c> archives = new List<Case_Archive__c>();
        for (Case c : scope) {
            if (c.ContactId == null) {
                flagged++;
            }
            archives.add(new Case_Archive__c(
                Name = c.CaseNumber,
                Source_Case_Id__c = c.Id,
                Subject__c = c.Subject,
                Account_Id__c = c.AccountId,
                Closed_On__c = c.ClosedDate
            ));
        }

        // 2. Idempotent upsert on the external id, partial success allowed
        List<Database.UpsertResult> upserts =
            Database.upsert(archives, Case_Archive__c.Source_Case_Id__c, false);

        // 3. Flag only the cases whose archive row really exists
        List<Case> toFlag = new List<Case>();
        for (Integer i = 0; i < scope.size(); i++) {
            String problem = null;
            if (simulatedFailures.contains(scope[i].Id)) {
                problem = 'Simulated failure';
            } else if (!upserts[i].isSuccess()) {
                problem = firstError(upserts[i].getErrors());
            }
            if (problem == null) {
                scope[i].Archived__c = true;
                toFlag.add(scope[i]);
            } else {
                recordFailure(scope[i], 'archive', problem);
            }
        }

        List<Database.SaveResult> saves = Database.update(toFlag, false);
        for (Integer i = 0; i < saves.size(); i++) {
            if (saves[i].isSuccess()) {
                archived++;
            } else {
                recordFailure(toFlag[i], 'flag', firstError(saves[i].getErrors()));
            }
        }
    }

    public void finish(Database.BatchableContext bc) {
        AsyncApexJob job = [
            SELECT Id, Status, NumberOfErrors, JobItemsProcessed, TotalJobItems
            FROM AsyncApexJob
            WHERE Id = :bc.getJobId()
        ];
        CaseArchiveSettings settings = CaseArchiveSettings.load();

        // Machine-readable summary for monitoring subscribers
        EventBus.publish(new Batch_Run_Summary__e(
            Job_Id__c = String.valueOf(job.Id),
            Status__c = job.Status,
            Scanned__c = scanned,
            Archived__c = archived,
            Failed__c = failed,
            Flagged__c = flagged
        ));

        // Human-readable summary only when something went wrong
        if ((failed > 0 || job.NumberOfErrors > 0) && String.isNotBlank(settings.notifyEmail)) {
            sendSummaryEmail(settings.notifyEmail, job);
        }

        // Chain the purge job. Tests cannot run chained batches from finish.
        if (!Test.isRunningTest()) {
            Database.executeBatch(new CaseArchivePurgeBatch(settings.purgeAfterDays), 200);
        }
    }

    private void sendSummaryEmail(String toAddress, AsyncApexJob job) {
        List<String> lines = new List<String>{
            'Job ' + job.Id + ' finished with status ' + job.Status,
            'Scanned: ' + scanned,
            'Archived: ' + archived,
            'Failed: ' + failed,
            'Cases without a contact: ' + flagged,
            'Unhandled batch errors: ' + job.NumberOfErrors,
            '',
            'First errors:'
        };
        Integer shown = Math.min(errorLines.size(), MAX_ERRORS_EMAILED);
        for (Integer i = 0; i < shown; i++) {
            lines.add(' - ' + errorLines[i]);
        }
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setToAddresses(new List<String>{ toAddress });
        mail.setSubject('Nightly case archive: ' + failed + ' failures');
        mail.setPlainTextBody(String.join(lines, '\n'));
        Messaging.sendEmail(new List<Messaging.Email>{ mail }, false);
    }

    private void recordFailure(Case c, String step, String message) {
        failed++;
        // Cap the list so Stateful serialization stays small
        if (errorLines.size() < MAX_ERRORS_KEPT) {
            errorLines.add(c.CaseNumber + ' (' + step + '): ' + message);
        }
    }

    private static String firstError(List<Database.Error> errs) {
        if (errs == null || errs.isEmpty()) {
            return 'Unknown error';
        }
        return errs[0].getStatusCode() + ': ' + errs[0].getMessage();
    }

    public class CaseArchiveException extends Exception {}
}
```

**`force-app/main/default/classes/CaseArchivePurgeBatch.cls`**

```apex
/**
 * Second stage of the chain: delete archive rows older than the purge period.
 * Stateless on purpose: it has nothing to carry between scopes.
 */
public with sharing class CaseArchivePurgeBatch implements Database.Batchable<SObject> {
    private final Datetime cutoff;

    public CaseArchivePurgeBatch(Integer purgeAfterDays) {
        this.cutoff = Datetime.now().addDays(-purgeAfterDays);
    }

    public Database.QueryLocator start(Database.BatchableContext bc) {
        Datetime cutoffValue = cutoff;
        return Database.getQueryLocator([
            SELECT Id FROM Case_Archive__c
            WHERE Closed_On__c < :cutoffValue
            WITH USER_MODE
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Case_Archive__c> scope) {
        List<Database.DeleteResult> results = Database.delete(scope, false);
        for (Database.DeleteResult r : results) {
            if (!r.isSuccess()) {
                System.debug(LoggingLevel.WARN, 'Purge failed: ' + r.getErrors()[0].getMessage());
            }
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('Purge job ' + bc.getJobId() + ' finished');
    }
}
```

**`force-app/main/default/classes/CaseArchiveScheduler.cls`**

```apex
/**
 * Entry point for the nightly run. A scheduled job only starts the batch;
 * the batch does the heavy lifting.
 */
public with sharing class CaseArchiveScheduler implements Schedulable {
    public void execute(SchedulableContext sc) {
        CaseArchiveSettings settings = CaseArchiveSettings.load();
        Database.executeBatch(new CaseArchiveBatch(settings.retentionDays), settings.batchSize);
    }
}
```

**`force-app/main/default/objects/Batch_Run_Summary__e/Batch_Run_Summary__e.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <eventType>StandardVolume</eventType>
    <label>Batch Run Summary</label>
    <pluralLabel>Batch Run Summaries</pluralLabel>
    <publishBehavior>PublishAfterCommit</publishBehavior>
</CustomObject>
```

**`force-app/main/default/customMetadata/Archive_Setting.Default.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
                xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Retention_Days__c</field>
        <value xsi:type="xsd:double">730</value>
    </values>
    <values>
        <field>Batch_Size__c</field>
        <value xsi:type="xsd:double">200</value>
    </values>
    <values>
        <field>Purge_After_Days__c</field>
        <value xsi:type="xsd:double">2555</value>
    </values>
    <values>
        <field>Notify_Email__c</field>
        <value xsi:type="xsd:string">support-ops@example.com</value>
    </values>
</CustomMetadata>
```

The platform event fields from step 5 and the custom object from step 3 can be created in Setup, or retrieved into source with `sf project retrieve start` once they exist.

**`force-app/main/default/classes/CaseArchiveBatchTest.cls`**

```apex
@IsTest
private class CaseArchiveBatchTest {

    private static List<Case> makeClosedCases(Integer n) {
        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < n; i++) {
            cases.add(new Case(Subject = 'Closed case ' + i, Status = 'Closed'));
        }
        insert cases;
        return cases;
    }

    // ClosedDate cannot be back-dated, so retention -1 puts the cutoff in the future
    private static void runBatch() {
        Test.startTest();
        Database.executeBatch(new CaseArchiveBatch(-1), 200);
        Test.stopTest();
    }

    @IsTest
    static void archivesTwoHundredCasesInOneScope() {
        List<Case> cases = makeClosedCases(200);
        runBatch();

        System.assertEquals(200, [SELECT COUNT() FROM Case_Archive__c]);
        System.assertEquals(200, [SELECT COUNT() FROM Case WHERE Archived__c = true]);
    }

    @IsTest
    static void oneFailureDoesNotStopTheRest() {
        List<Case> cases = makeClosedCases(200);
        CaseArchiveBatch.simulatedFailures = new Set<Id>{ cases[0].Id };
        runBatch();

        System.assertEquals(199, [SELECT COUNT() FROM Case WHERE Archived__c = true]);
        Case failedCase = [SELECT Archived__c FROM Case WHERE Id = :cases[0].Id];
        System.assertEquals(false, failedCase.Archived__c, 'Failed case stays unflagged');
    }

    @IsTest
    static void rerunDoesNotDuplicateArchiveRows() {
        List<Case> cases = makeClosedCases(5);
        // Simulate a previous run that copied the case but never flagged it
        insert new Case_Archive__c(Name = 'old', Source_Case_Id__c = cases[0].Id);
        runBatch();

        System.assertEquals(5, [SELECT COUNT() FROM Case_Archive__c]);
    }

    @IsTest
    static void alreadyArchivedCasesAreSkipped() {
        List<Case> cases = makeClosedCases(3);
        for (Case c : cases) {
            c.Archived__c = true;
        }
        update cases;
        runBatch();

        System.assertEquals(0, [SELECT COUNT() FROM Case_Archive__c]);
    }

    @IsTest
    static void purgeRemovesOnlyOldArchiveRows() {
        insert new List<Case_Archive__c>{
            new Case_Archive__c(Name = 'old', Closed_On__c = Datetime.now().addYears(-10)),
            new Case_Archive__c(Name = 'recent', Closed_On__c = Datetime.now().addDays(-5))
        };
        Test.startTest();
        Database.executeBatch(new CaseArchivePurgeBatch(2555), 200);
        Test.stopTest();

        List<Case_Archive__c> left = [SELECT Name FROM Case_Archive__c];
        System.assertEquals(1, left.size());
        System.assertEquals('recent', left[0].Name);
    }

    @IsTest
    static void schedulerRegistersAJob() {
        Test.startTest();
        Id cronId = System.schedule('Test nightly archive', '0 0 2 * * ?', new CaseArchiveScheduler());
        Test.stopTest();

        CronTrigger ct = [SELECT CronExpression FROM CronTrigger WHERE Id = :cronId];
        System.assertEquals('0 0 2 * * ?', ct.CronExpression);
    }
}
```

**`scripts/deploy-and-run.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

# Deploy the source and run the tests that cover the job
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names CaseArchiveBatchTest --target-org dev \
  --result-format human --wait 10

# Schedule the nightly run at 02:00 (Salesforce cron format: sec min hour day month weekday)
cat > /tmp/schedule.apex <<'APEX'
System.schedule('Nightly case archive', '0 0 2 * * ?', new CaseArchiveScheduler());
APEX
sf apex run --file /tmp/schedule.apex --target-org dev
```

## What happens behind the scenes

Follow one nightly run with 10,000 eligible cases and the default scope size of 200.

1. **02:00, scheduler.** The platform wakes the `CaseArchiveScheduler` as the user who scheduled it. `execute` loads settings (a custom metadata read, which does not count as a SOQL query) and calls `Database.executeBatch`. The scheduler transaction ends within a fraction of a second. That is why a scheduler should only start work.
2. **`start`.** The query locator is created. The query does not return 10,000 rows into your heap. The platform holds a cursor. `WITH USER_MODE` applies the running user's object and field permissions.
3. **50 scopes.** Salesforce queues 10,000 / 200 = 50 `execute` calls. Each is a separate transaction. In each one you use one SOQL-free loop, one upsert (200 DML rows) and one update (up to 200 DML rows). That is two DML statements and up to 400 DML rows per scope, comfortably inside the per-transaction limits (150 DML statements, 10,000 DML rows).
4. **Stateful serialization.** After each scope the platform serializes the batch instance (counters and up to 50 error strings) and deserializes it for the next scope. Capping the error list at 50 keeps that cost flat. An uncapped list would grow with every failure.
5. **Partial failure.** If case 17 of scope 3 fails the upsert, `Database.upsert(..., false)` returns an error for that row only. The other 199 rows save. We skip flagging case 17, so tomorrow's run picks it up again, and the external id means no duplicate archive row appears.
6. **Unhandled exception.** If an exception escapes `execute`, that scope's transaction rolls back, the job continues with the next scope, and `NumberOfErrors` goes up. Because the class implements `Database.RaisesPlatformEvents`, the platform also publishes a `BatchApexErrorEvent` that an Apex trigger could subscribe to.
7. **`finish`.** Runs in its own transaction after the last scope. It queries `AsyncApexJob`, publishes `Batch_Run_Summary__e` (delivered after commit), sends one email if there were failures, and starts the purge batch.

In the debug log (set a trace flag on the running user, Setup, Debug Logs) look for one `BATCH_APEX_START`-style block per scope, `DML_BEGIN` lines with `Rows:200`, and `LIMIT_USAGE_FOR_NS` at the end of each transaction. Compare `Number of SOQL queries` against 200 and `Maximum CPU time` against 60,000 ms for asynchronous work. For history, Setup, Apex Jobs lists each scope's progress, and `AsyncApexJob` can be queried with SOQL.

## Test it and verify

1. **Run the unit tests.**
   ```bash
   sf apex run test --class-names CaseArchiveBatchTest --target-org dev --result-format human --wait 10
   ```
   Expected: all six tests pass.
2. **Run one real job.** In Developer Console, Debug, Open Execute Anonymous Apex:
   ```apex
   // Anonymous Apex
   Id jobId = Database.executeBatch(new CaseArchiveBatch(0), 200);
   System.debug(jobId);
   ```
   A retention of 0 days archives every closed case, so use a sandbox.
3. **Watch the job.** Setup, Apex Jobs. Status goes Queued, Processing, Completed. "Total Batches" times the scope size should cover your record count.
4. **Check the data.** Run `SELECT COUNT() FROM Case_Archive__c` and `SELECT COUNT() FROM Case WHERE Archived__c = true`. The two numbers match when nothing failed.
5. **Check the event and email.** Subscribe with the Event Monitor tool or your monitoring subscriber and look for `Batch_Run_Summary__e`. Force a failure in a sandbox (for example, remove edit access to `Archived__c` from the running user) and confirm the email arrives with the first errors.
6. **Confirm the schedule.** Setup, Scheduled Jobs, "Nightly case archive", and the next run time.

## Common mistakes and fixes

1. **Counters are always zero in `finish`.** Cause: no `Database.Stateful`. Fix: implement it, and keep the state small.
2. **The job fails after a few scopes with a heap or serialization problem.** Cause: Stateful state that grows (all failed records or all ids). Fix: store counters and a capped list of messages, not records.
3. **A single bad record rolls back its whole scope.** Cause: `update scope;` with all-or-none behaviour. Fix: use `Database.update(scope, false)` and inspect each result, as shown above.
4. **SOQL or DML inside the `for` loop.** The limits reset per scope, but not per record. Fix: query and write once per scope.
5. **Callouts fail with "uncommitted work pending" or are not allowed at all.** Cause: the class does not implement `Database.AllowsCallouts`, or a callout comes after DML in the same scope. Fix: add the interface and make callouts before DML.
6. **The chained job never starts in tests, or a test errors on chaining.** Cause: starting a batch from `finish` in a test. Fix: guard the chain call with `Test.isRunningTest()` and test each batch on its own.
7. **Scheduling a job that does the work itself.** A scheduled class runs in a short transaction with synchronous limits. Fix: the scheduler only calls `Database.executeBatch`.
8. **Very large scope sizes cause CPU or heap errors; very small ones are slow.** Fix: start at 200, lower it when each record is heavy (callouts, many child rows), and measure.
9. **Assuming scopes run in a fixed time or order.** Other jobs and platform load change the timing. Fix: make every scope idempotent, as the external-id upsert does.

## Key takeaways

- A batch is many small transactions. Each `execute` has fresh limits, and a failed scope does not undo the others.
- Use `Database.Stateful` for totals, and cap what you keep. Use partial-success DML and inspect every result.
- Make the work idempotent (external id upsert, a flag in the query) so reruns are safe.
- Report at the end: `AsyncApexJob`, an email for people, a platform event for systems.
- Chain from `finish` for the next stage, and keep schedulers thin.
- Check the Apex Developer Guide and your org's limits page for current concurrency and daily allocations.

## Where to go next

- [Schedulable Apex complete guide](/articles/schedulable-apex-complete-guide/)
- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/)
- [Apex async advanced patterns](/articles/apex-async-advanced-patterns/)
