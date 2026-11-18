---
title: "Schedulable Apex Complete Guide: Cron Expressions, Scheduling and Monitoring"
description: "Run Apex on a schedule: cron syntax, System.schedule, Setup scheduling, batch and queueable hand-off, and tests, built on a nightly SLA-breach sweep."
category: salesforce-development
tags: [Schedulable, Apex, Async, Beginner, Advanced]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/schedulable-apex-complete-guide.jpg
sources:
  - title: "Apex Scheduler (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_scheduler.htm"
  - title: "Using Batch Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_batch.htm"
  - title: "Queueable Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_queueables.htm"
  - title: "CronTrigger (Object Reference)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_crontrigger.htm"
  - title: "AsyncApexJob (Object Reference)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_asyncapexjob.htm"
---

Schedulable Apex runs a class at a time you choose: every night, every weekday morning, on the last day of the month. You write a class that implements the `Schedulable` interface, then register it with a **cron expression**, a short text pattern that says when to fire. The platform stores that registration and starts your class on time without anyone clicking anything.

The important design rule is that the scheduled class is a **trigger for work, not the work itself**. It wakes up, checks whether there is something to do, and hands the heavy lifting to Batch or Queueable Apex. This article builds that design end to end.

## The business scenario

Northwind Telecom (a fictional company) promises business customers a first response within an SLA window. Each Case has a custom date/time field, `SLA_Due__c`. When that time passes and the Case is still open, the Case has **breached** its SLA.

Support leads want this, every night:

1. Find every open Case whose `SLA_Due__c` is in the past and that has not been flagged yet.
2. Flag it (`SLA_Breached__c = true`) and raise its priority to High.
3. Tell the support operations channel how many Cases were flagged and how many failed, through a webhook.
4. Let an admin pause the sweep or change the batch size without a deployment.
5. Never run two sweeps at once, and never end up with two copies of the schedule.

A Flow could do step 1 and 2 for small volumes. Apex earns its place when the volume is large, the logic is complex, or you need a callout. See [Flow types: screen, scheduled and autolaunched](/articles/flow-types-screen-scheduled-autolaunched/) for the declarative option.

## Before you start: setup

Use a Developer Edition org or a scratch org. Menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In Salesforce

1. **Add two fields to Case.** Setup, Object Manager, Case, Fields and Relationships, New. Create `SLA_Due__c` (Date/Time) and `SLA_Breached__c` (Checkbox, default unchecked). Why: the sweep reads and writes them. Verify: both fields show on the Case object. The XML for both is in the advanced example if you deploy with the CLI.
2. **Create a Custom Metadata Type** named `SLA_Sweep_Setting` with fields `Is_Enabled__c` (Checkbox) and `Batch_Size__c` (Number, 3 digits, 0 decimals). Add one record with the label and name `Default`. Why: admins change settings by editing a record, with no code deploy. Verify: Setup, Custom Metadata Types, Manage Records shows `Default`. See [Custom metadata, settings and labels](/articles/custom-metadata-settings-and-labels/).
3. **Create a Named Credential** called `Support_Webhook` that points at your chat or incident tool's webhook base URL. Setup, Named Credentials (use the External Credential tab for the secret, as described in [REST callouts and Named Credentials](/articles/rest-callouts-named-credentials/)). Why: the callout goes to `callout:Support_Webhook` and no URL or secret lives in Apex. Verify: the credential appears in Setup and the running user has access to its principal.
4. **Give your user permission to schedule.** You need the Author Apex permission (an admin profile has it) and edit access to Case and the two new fields. Verify: Setup, Apex Classes shows a Schedule Apex button after you deploy the code.
5. **Create test data.** A handful of open Cases with `SLA_Due__c` set a few hours in the past. Verify: a list view filtered on `SLA Due` before now shows them.

### In the external system

1. **Create an incoming webhook** in your chat or incident tool and copy its URL into the Named Credential. Why: step 3 of the scenario posts there. Verify: a `curl -X POST` with a small JSON body returns a 2xx response.
2. **No tool yet?** Any HTTPS endpoint that accepts a POST will do. Unit tests use a mock and never call it.

### On your machine

Install Salesforce CLI (`sf`) and VS Code with the Salesforce extensions. Verify: `sf --version` prints a version and `sf org login web` connects your org.

## How it works

Three moving parts are involved.

| Part | What it is |
|---|---|
| `Schedulable` class | Your code. One method, `execute(SchedulableContext)`. |
| Cron expression | The when. Stored as text on the job. |
| `CronTrigger` record | The platform's record of one scheduled job: name, expression, state, next and previous fire times. |

`System.schedule(name, cron, instance)` saves a serialised copy of your object and a `CronTrigger`, and returns the `CronTrigger` Id. At the fire time the platform puts the job in the async queue, creates a new instance of your class from the saved copy, and calls `execute`. Start time is not a promise to the second. If the platform is busy, the job can start a little late.

### Cron expression syntax

An expression has six required fields and one optional field, separated by spaces:

| Field | Allowed values | Special characters |
|---|---|---|
| Seconds | 0-59 | `, - * /` |
| Minutes | 0-59 | `, - * /` |
| Hours | 0-23 | `, - * /` |
| Day of month | 1-31 | `, - * ? / L W` |
| Month | 1-12 or JAN-DEC | `, - * /` |
| Day of week | 1-7 or SUN-SAT | `, - * ? / L #` |

A seventh optional field holds the year. You must use `?` in either day of month or day of week, because you cannot constrain both at once.

| Expression | Meaning |
|---|---|
| `0 0 2 * * ?` | Every day at 02:00 |
| `0 30 6 ? * MON-FRI` | Weekdays at 06:30 |
| `0 0 3 L * ?` | 03:00 on the last day of each month |
| `0 0 0/4 * * ?` | Every four hours, on the hour |
| `0 15 9 ? * 2#1` | 09:15 on the first Monday of each month |

Check `NextFireTime` on the `CronTrigger` after you schedule. It shows exactly when the platform thinks the next run is, in the time zone it applied. If it surprises you, fix the expression, not the code.

### Limits and rules to remember

- An org can hold up to 100 scheduled Apex jobs at a time.
- A scheduled class cannot make a synchronous callout from `execute`. Start a Batch with `Database.AllowsCallouts` or a Queueable with `Database.AllowsCallouts` instead.
- `execute` runs in an asynchronous transaction, with the asynchronous governor limits. Treat it as a short transaction and do not rely on it for large work. Check the [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/) for numbers.
- Test methods that call `System.schedule` must wrap it in `Test.startTest()` and `Test.stopTest()`.

## Basic example

This is the smallest useful scheduled class. It starts a Batch job. Replace `DeactivateStaleLeads` with any `Database.Batchable` class you have.

```apex
public class NightlyCleanup implements Schedulable {
    public void execute(SchedulableContext sc) {
        // Keep this method thin: start the real work and return.
        Database.executeBatch(new DeactivateStaleLeads(), 200);
    }
}
```

Schedule it from Anonymous Apex:

```apex
// Anonymous Apex
String cron = '0 0 2 * * ?';   // every day at 02:00
Id jobId = System.schedule('Nightly cleanup', cron, new NightlyCleanup());
CronTrigger ct = [
    SELECT CronExpression, NextFireTime, State
    FROM CronTrigger WHERE Id = :jobId
];
System.debug('Next run: ' + ct.NextFireTime + ' state: ' + ct.State);
```

Expected result: the debug log prints a next run time in the future and the state `WAITING`.

You can also schedule without code. Setup, Apex Classes, Schedule Apex, pick the class, name the job, choose days and a start and end date, and a preferred start time. Setup is fine for a one-off. For anything you deploy across environments, schedule in code so it is repeatable.

Here is the version you should avoid. It does the work inline and reschedules itself:

```apex
public class BadNightlySweep implements Schedulable {
    public void execute(SchedulableContext sc) {
        // BAD: heavy work inside execute, limited to one transaction.
        List<Case> cases = [SELECT Id FROM Case WHERE IsClosed = false];
        for (Case c : cases) {
            c.Priority = 'High';
        }
        update cases;
        // BAD: self-rescheduling. If this run fails before this line,
        // the schedule is gone. Run it twice and you get two schedules.
        System.schedule('Sweep ' + Datetime.now().getTime(),
            '0 0 2 * * ?', new BadNightlySweep());
    }
}
```

The fix is the next section: one fixed cron job, a thin class, and a Batch for the work.

## Advanced end-to-end example

The design:

```text
CronTrigger (one job, fixed cron)
   |
   v
SlaBreachSweepScheduler.execute()      thin: read setting, guard, hand off
   |  Database.executeBatch(scope = Batch_Size__c)
   v
SlaBreachSweepBatch                    start / execute (x N) / finish
   |  finish(): enqueue one job
   v
SlaBreachNotifier (Queueable)          callout to the webhook
```

Why a fixed cron and no self-rescheduling: the schedule is data, created once by an idempotent installer. A failure inside a run cannot delete the next run, and two runs cannot create two schedules.

**`force-app/main/default/objects/Case/fields/SLA_Due__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>SLA_Due__c</fullName>
    <label>SLA Due</label>
    <type>DateTime</type>
    <required>false</required>
</CustomField>
```

**`force-app/main/default/objects/Case/fields/SLA_Breached__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>SLA_Breached__c</fullName>
    <label>SLA Breached</label>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
</CustomField>
```

**`force-app/main/default/objects/SLA_Sweep_Setting__mdt/SLA_Sweep_Setting__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>SLA Sweep Setting</label>
    <pluralLabel>SLA Sweep Settings</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/SLA_Sweep_Setting__mdt/fields/Is_Enabled__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Is_Enabled__c</fullName>
    <label>Is Enabled</label>
    <type>Checkbox</type>
    <defaultValue>false</defaultValue>
    <fieldManageability>DeveloperControlled</fieldManageability>
</CustomField>
```

**`force-app/main/default/objects/SLA_Sweep_Setting__mdt/fields/Batch_Size__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Batch_Size__c</fullName>
    <label>Batch Size</label>
    <type>Number</type>
    <precision>4</precision>
    <scale>0</scale>
    <fieldManageability>DeveloperControlled</fieldManageability>
</CustomField>
```

**`force-app/main/default/customMetadata/SLA_Sweep_Setting.Default.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Is_Enabled__c</field>
        <value xsi:type="xsd:boolean">true</value>
    </values>
    <values>
        <field>Batch_Size__c</field>
        <value xsi:type="xsd:double">200.0</value>
    </values>
</CustomMetadata>
```

**`force-app/main/default/classes/SlaBreachSweepScheduler.cls`**

```apex
public with sharing class SlaBreachSweepScheduler implements Schedulable {

    public static final String BATCH_CLASS = 'SlaBreachSweepBatch';
    public static final Integer DEFAULT_SIZE = 200;

    // Tests cannot rely on deployed metadata, so they inject a setting.
    @TestVisible
    private static SLA_Sweep_Setting__mdt settingOverride;

    public void execute(SchedulableContext sc) {
        SLA_Sweep_Setting__mdt cfg = settingOverride != null
            ? settingOverride
            : SLA_Sweep_Setting__mdt.getInstance('Default');

        // Guard 1: the admin switch.
        if (cfg == null || cfg.Is_Enabled__c != true) {
            System.debug(LoggingLevel.INFO, 'SLA sweep disabled, skipping.');
            return;
        }
        // Guard 2: never overlap with a sweep that is still running.
        if (isSweepRunning()) {
            System.debug(LoggingLevel.WARN, 'SLA sweep already running.');
            return;
        }
        Integer size = cfg.Batch_Size__c == null
            ? DEFAULT_SIZE : Integer.valueOf(cfg.Batch_Size__c);
        Database.executeBatch(new SlaBreachSweepBatch(), size);
    }

    @TestVisible
    private static Boolean isSweepRunning() {
        Integer active = [
            SELECT COUNT() FROM AsyncApexJob
            WHERE ApexClass.Name = :BATCH_CLASS
            AND JobType = 'BatchApex'
            AND Status IN ('Queued', 'Preparing', 'Processing', 'Holding')
        ];
        return active > 0;
    }
}
```

**`force-app/main/default/classes/SlaBreachSweepBatch.cls`**

```apex
public with sharing class SlaBreachSweepBatch
    implements Database.Batchable<SObject>, Database.Stateful {

    public static final Integer SAMPLE_SIZE = 20;

    // Database.Stateful keeps these between execute() calls.
    private Integer flagged = 0;
    private Integer failed = 0;
    private List<Id> sampleIds = new List<Id>();
    private List<String> sampleErrors = new List<String>();

    public Database.QueryLocator start(Database.BatchableContext bc) {
        Datetime cutoff = Datetime.now();
        return Database.getQueryLocator([
            SELECT Id, Priority, SLA_Breached__c
            FROM Case
            WHERE IsClosed = false
            AND SLA_Breached__c = false
            AND SLA_Due__c < :cutoff
            WITH USER_MODE
        ]);
    }

    public void execute(Database.BatchableContext bc, List<Case> scope) {
        for (Case c : scope) {
            c.SLA_Breached__c = true;
            c.Priority = 'High';
        }
        // allOrNone = false: one bad row must not roll back the chunk.
        List<Database.SaveResult> results =
            Database.update(scope, false, AccessLevel.USER_MODE);

        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                flagged++;
                if (sampleIds.size() < SAMPLE_SIZE) {
                    sampleIds.add(scope[i].Id);
                }
            } else {
                failed++;
                if (sampleErrors.size() < SAMPLE_SIZE) {
                    sampleErrors.add(scope[i].Id + ': '
                        + results[i].getErrors()[0].getMessage());
                }
            }
        }
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('SLA sweep done. flagged=' + flagged + ' failed=' + failed);
        if (flagged + failed == 0) {
            return; // nothing happened, no need to notify
        }
        // One Queueable per finish(): the platform allows a single enqueue here.
        System.enqueueJob(
            new SlaBreachNotifier(flagged, failed, sampleIds, sampleErrors)
        );
    }
}
```

**`force-app/main/default/classes/SlaBreachNotifier.cls`**

```apex
public with sharing class SlaBreachNotifier
    implements Queueable, Database.AllowsCallouts {

    public class NotifyException extends Exception {}

    private final String body;

    public SlaBreachNotifier(
        Integer flagged, Integer failed, List<Id> sampleIds, List<String> errors
    ) {
        this.body = JSON.serialize(new Map<String, Object>{
            'text' => 'SLA sweep: ' + flagged + ' flagged, ' + failed + ' failed.',
            'flagged' => flagged,
            'failed' => failed,
            'sampleCaseIds' => sampleIds,
            'sampleErrors' => errors
        });
    }

    public void execute(QueueableContext ctx) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Support_Webhook/sla-breaches');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(20000);
        req.setBody(body);

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() < 200 || res.getStatusCode() > 299) {
            // Throwing marks the AsyncApexJob as failed, which is visible
            // on the Apex Jobs page and in monitoring queries.
            throw new NotifyException('Webhook returned ' + res.getStatusCode());
        }
    }
}
```

**`force-app/main/default/classes/SlaSweepScheduleInstaller.cls`**

```apex
public with sharing class SlaSweepScheduleInstaller {

    public static final String JOB_NAME = 'SLA breach sweep (nightly)';
    public static final String CRON = '0 0 2 * * ?';

    // Idempotent: run it as often as you like, you always end with one job.
    public static Id install() {
        for (CronTrigger ct : [
            SELECT Id FROM CronTrigger WHERE CronJobDetail.Name = :JOB_NAME
        ]) {
            System.abortJob(ct.Id);
        }
        return System.schedule(JOB_NAME, CRON, new SlaBreachSweepScheduler());
    }
}
```

**`scripts/apex/install-schedule.apex`**

```apex
// Anonymous Apex
Id jobId = SlaSweepScheduleInstaller.install();
CronTrigger ct = [
    SELECT CronJobDetail.Name, CronExpression, NextFireTime, State
    FROM CronTrigger WHERE Id = :jobId
];
System.debug(ct.CronJobDetail.Name + ' | ' + ct.CronExpression
    + ' | next ' + ct.NextFireTime + ' | ' + ct.State);
```

**`force-app/main/default/classes/SlaSweepTests.cls`**

```apex
@IsTest
private class SlaSweepTests {

    private class WebhookMock implements HttpCalloutMock {
        private final Integer status;
        WebhookMock(Integer status) {
            this.status = status;
        }
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(status);
            res.setBody('{"ok":true}');
            return res;
        }
    }

    private static List<Case> makeCases(Integer count, Datetime due) {
        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < count; i++) {
            cases.add(new Case(
                Subject = 'Test case ' + i,
                Status = 'New',
                Priority = 'Low',
                SLA_Due__c = due
            ));
        }
        insert cases;
        return cases;
    }

    private static SLA_Sweep_Setting__mdt setting(Boolean enabled, Decimal size) {
        return new SLA_Sweep_Setting__mdt(
            DeveloperName = 'Default', Is_Enabled__c = enabled, Batch_Size__c = size
        );
    }

    @IsTest
    static void flagsOverdueCasesInBulk() {
        makeCases(200, Datetime.now().addHours(-3));
        makeCases(5, Datetime.now().addHours(3)); // not due yet
        SlaBreachSweepScheduler.settingOverride = setting(true, 200);
        Test.setMock(HttpCalloutMock.class, new WebhookMock(200));

        Test.startTest();
        new SlaBreachSweepScheduler().execute(null);
        Test.stopTest();

        System.assertEquals(200,
            [SELECT COUNT() FROM Case WHERE SLA_Breached__c = true]);
        System.assertEquals(200,
            [SELECT COUNT() FROM Case WHERE Priority = 'High']);
        System.assertEquals(5,
            [SELECT COUNT() FROM Case WHERE SLA_Breached__c = false]);
    }

    @IsTest
    static void disabledSettingStartsNoBatch() {
        makeCases(10, Datetime.now().addHours(-3));
        SlaBreachSweepScheduler.settingOverride = setting(false, 200);

        Test.startTest();
        new SlaBreachSweepScheduler().execute(null);
        Test.stopTest();

        System.assertEquals(0,
            [SELECT COUNT() FROM Case WHERE SLA_Breached__c = true]);
        System.assertEquals(0, [
            SELECT COUNT() FROM AsyncApexJob
            WHERE ApexClass.Name = :SlaBreachSweepScheduler.BATCH_CLASS
        ]);
    }

    @IsTest
    static void notifierThrowsOnWebhookFailure() {
        Test.setMock(HttpCalloutMock.class, new WebhookMock(500));
        SlaBreachNotifier job = new SlaBreachNotifier(
            1, 0, new List<Id>(), new List<String>()
        );
        Boolean threw = false;
        Test.startTest();
        try {
            job.execute(null);
        } catch (SlaBreachNotifier.NotifyException e) {
            threw = true;
        }
        Test.stopTest();
        System.assert(threw, 'A 500 from the webhook must surface as an error');
    }

    @IsTest
    static void installerCreatesExactlyOneJob() {
        Test.startTest();
        Id first = SlaSweepScheduleInstaller.install();
        Id second = SlaSweepScheduleInstaller.install();
        Test.stopTest();

        System.assertNotEquals(first, second);
        List<CronTrigger> jobs = [
            SELECT CronExpression, TimesTriggered, NextFireTime
            FROM CronTrigger
            WHERE CronJobDetail.Name = :SlaSweepScheduleInstaller.JOB_NAME
        ];
        System.assertEquals(1, jobs.size());
        System.assertEquals(SlaSweepScheduleInstaller.CRON, jobs[0].CronExpression);
        System.assertNotEquals(null, jobs[0].NextFireTime);
    }
}
```

Deploy and schedule:

```bash
sf project deploy start --source-dir force-app --target-org my-sandbox
sf apex run --file scripts/apex/install-schedule.apex --target-org my-sandbox
sf apex run test --class-names SlaSweepTests --result-format human \
  --code-coverage --wait 10 --target-org my-sandbox
```

## What happens behind the scenes

1. **You call `System.schedule`.** The platform validates the cron text, serialises the `SlaBreachSweepScheduler` instance, and creates a `CronTrigger` row. Your transaction ends. Nothing runs yet.
2. **02:00 arrives.** The scheduler puts the job in the async queue. The job starts when a worker is free, so it may begin a little after 02:00. `PreviousFireTime` and `TimesTriggered` update on the `CronTrigger`.
3. **`execute` runs in its own transaction** with asynchronous limits. It reads one Custom Metadata record (custom metadata reads do not count as SOQL queries), runs one count query on `AsyncApexJob`, and calls `Database.executeBatch`. That call only queues the batch. The scheduled transaction ends in milliseconds.
4. **The batch starts.** `start` runs in its own transaction and returns a `QueryLocator`. A QueryLocator can stream up to 50 million rows, so the sweep scales far beyond the limit on normal SOQL result rows.
5. **`execute` runs once per chunk.** Each chunk of `Batch_Size__c` Cases is a separate transaction with fresh limits: one update DML per chunk, a fraction of the SOQL budget, and no state except what `Database.Stateful` carries over. A failure in chunk 7 does not undo chunk 6.
6. **`finish` runs once.** It enqueues the `SlaBreachNotifier`. Enqueuing from an async context is limited to one job, which is why the notifier carries counts rather than one job per chunk.
7. **The notifier runs** in its own transaction, makes one callout through the Named Credential (the platform adds the credential headers), and ends. A non-2xx status raises `NotifyException`, so the `AsyncApexJob` row shows an error.

In the debug log, filter on `CODE_UNIT_STARTED`. You will see one unit for the scheduler class, then `Database.executeBatch`, then separate units per batch chunk, and a last one for the Queueable. Each unit has its own `LIMIT_USAGE_FOR_NS` summary. If your debug log shows the scheduler doing SOQL for the Cases, the work has leaked out of the batch.

The test side works similarly. `Test.startTest()` and `Test.stopTest()` capture the asynchronous work you start in between and run it synchronously at `stopTest`. That is why the assertions come after `stopTest`. A Batch started in a test runs a single chunk of up to the scope size, so keep test data at or under 200 rows, or test `execute` directly with `List<Case>`.

## Test it and verify

1. Deploy: `sf project deploy start --source-dir force-app`. Verify: the command ends with `Succeeded`.
2. Run the tests: `sf apex run test --class-names SlaSweepTests --code-coverage --wait 10`. Expected: all pass and `SlaBreachSweepScheduler` and `SlaBreachSweepBatch` show high coverage.
3. Create overdue data in Anonymous Apex:

   ```apex
   // Anonymous Apex
   List<Case> cases = new List<Case>();
   for (Integer i = 0; i < 25; i++) {
       cases.add(new Case(Subject = 'Sweep demo ' + i, Status = 'New',
           SLA_Due__c = Datetime.now().addHours(-2)));
   }
   insert cases;
   ```

4. Run the sweep now without waiting for 02:00: `new SlaBreachSweepScheduler().execute(null);` in Anonymous Apex. Expected: Setup, Apex Jobs shows a `SlaBreachSweepBatch` row, then a `SlaBreachNotifier` row, both Completed.
5. Check the data: `SELECT COUNT() FROM Case WHERE SLA_Breached__c = true AND Subject LIKE 'Sweep demo%'` returns 25.
6. Install the schedule: `sf apex run --file scripts/apex/install-schedule.apex`. Expected: one line with the job name and `WAITING`.
7. Open Setup, Scheduled Jobs. Expected: `SLA breach sweep (nightly)` with a next run time. Run the installer again and confirm there is still one row.
8. Set `Is_Enabled__c` to false on the `Default` record, run step 4, and confirm no batch row appears.

## Common mistakes and fixes

- **Symptom: "Callout from scheduled Apex not supported."** Cause: a synchronous callout in `execute`. Fix: hand off to a Queueable or Batch that implements `Database.AllowsCallouts`.
- **Symptom: the job never fires, or fires at an odd time.** Cause: the cron fields are wrong or in the wrong order, or you read the time in another time zone. Fix: always read `NextFireTime` from the `CronTrigger` after scheduling and adjust.
- **Symptom: duplicate jobs, or the schedule disappears after a failure.** Cause: self-rescheduling inside `execute`, or running a setup script twice. Fix: use a fixed cron and an installer that aborts the old job by name before scheduling.
- **Symptom: "You have exceeded the maximum number of scheduled Apex jobs."** Cause: the org reached its limit of scheduled jobs, often from unique job names created in a loop or by earlier self-rescheduling. Fix: delete stale jobs on Setup, Scheduled Jobs, or abort them with `System.abortJob`.
- **Symptom: a test fails with "System.NullPointerException" on the custom metadata record.** Cause: relying on a deployed `Default` record that is missing in the test org. Fix: inject a setting with `@TestVisible`, as the code does.
- **Symptom: assertions fail because nothing changed.** Cause: asserting before `Test.stopTest()`. Fix: put every assertion on async results after `stopTest`.
- **Symptom: two sweeps overlap and update the same Cases.** Cause: a long sweep still running when the next trigger fires, for example after a manual run. Fix: keep the `AsyncApexJob` guard in the scheduler.

## Key takeaways

- A scheduled class is a trigger for work. Keep `execute` thin and hand off to Batch or Queueable.
- Use one fixed cron expression and an idempotent installer. Do not reschedule from inside `execute`.
- Put switches and sizes in Custom Metadata so admins can pause or tune without a deployment.
- Guard against overlap by checking `AsyncApexJob` before you start a batch.
- Verify with the `CronTrigger` record: `NextFireTime`, `State` and `TimesTriggered` tell you what the platform will do.

## Where to go next

- [Batch Apex complete guide](/articles/batch-apex-complete-guide/)
- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)
- [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/)
- [Apex test classes best practices](/articles/apex-test-classes-best-practices/)
