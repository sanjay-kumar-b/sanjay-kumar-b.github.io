---
title: "Advanced Async Apex: Choosing, Combining and Hardening Background Jobs"
description: "Build reliable background processing: chained queueables, finalizers, platform-event alerts, backoff retries, idempotency keys and AsyncApexJob monitoring."
category: salesforce-development
tags: [Apex, Async, Advanced, Architecture, Batch Apex, Queueable]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/apex-async-advanced-patterns.jpg
sources:
  - title: "Asynchronous Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_async_overview.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "Queueable Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_queueables.htm"
  - title: "Transaction Finalizers (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_transaction_finalizers.htm"
  - title: "Apex Scheduler (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_scheduler.htm"
  - title: "AsyncApexJob (Object Reference)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_asyncapexjob.htm"
  - title: "Platform Events Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/platform_events_intro.htm"
---

Starting a background job is easy. Making it survive real traffic is the hard part. Jobs fail halfway, run twice, hit limits that you cannot catch, and fail quietly where nobody looks. This article is about the patterns that fix that: chaining jobs safely, catching failures that `try/catch` cannot, alerting through platform events, retrying with backoff, and making every step safe to repeat.

If you have not yet picked between the three async tools, read [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/) first. Here we assume Queueable Apex and go deep.

## The business scenario

Brightforge Components (a fictional manufacturer) receives orders from a web storefront. The storefront writes each order into a staging object, `Order_Intake__c`, through an integration, sometimes in loads of thousands. Salesforce must:

1. Reserve stock with the warehouse system (WMS) over HTTPS.
2. Create one `Fulfillment_Order__c` per order.
3. Never create two fulfillment orders for the same web order, even if the storefront resends it, or a job runs twice.
4. Survive a WMS outage: retry later, with growing delays, and give up after five attempts.
5. Tell operations when something is dead or a job crashes, without anyone watching logs.
6. Let an admin see how healthy the background processing is.

The patterns map to the rules: chained queueables and slicing (1, 2), idempotency keys (3), scheduled retry with backoff (4), a finalizer and a platform event (5), and `AsyncApexJob` monitoring (6).

## Before you start: setup

Use a Developer Edition or scratch org. Menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In Salesforce

1. **Create the staging object `Order_Intake__c`.** Setup, Object Manager, Create, Custom Object. Add these fields. Why: the code reads and writes them. Verify: all fields show in the object's Fields list.

   | Field (API name) | Type |
   |---|---|
   | `Idempotency_Key__c` | Text(80), External ID, Unique (case-insensitive is fine) |
   | `Payload__c` | Long Text Area (32768) |
   | `Status__c` | Picklist: New, Retry, Processed, Dead |
   | `Attempt_Count__c` | Number(2, 0), default 0 |
   | `Next_Attempt_At__c` | Date/Time |
   | `Last_Error__c` | Text(255) |

2. **Create `Fulfillment_Order__c`** with `Idempotency_Key__c` (Text(80), External ID, Unique), `Customer_Number__c` (Text(40)), `Sku__c` (Text(40)) and `Quantity__c` (Number(6, 0)). Why: the unique external ID lets the code upsert, so a repeat is an update, not a duplicate. Verify: the field is marked External ID.
3. **Create the platform event `Async_Failure__e`** with Text fields `Job_Id__c` (18), `Job_Type__c` (80), `Message__c` (255) and a Number `Record_Count__c` (6, 0). Set Publish Behavior to Publish Immediately. Why: the failure alert must leave even if the failing transaction rolls back. Verify: it is listed under Platform Events. The XML is in the example.
4. **Create a Named Credential** `Warehouse_WMS` with an External Credential that sends the WMS API key as a header. Grant your user access to the principal through a permission set. Why: callouts use `callout:Warehouse_WMS` and the key stays out of Apex. Verify: the credential exists and your user is in the permission set. See [REST callouts and Named Credentials](/articles/rest-callouts-named-credentials/).
5. **Give your user access** to all three custom objects and fields (a permission set with CRUD and field access). Why: the code uses `WITH USER_MODE`, so it respects the running user's permissions. Verify: you can create an `Order_Intake__c` record in the UI.

### In the external system

1. **Create a WMS sandbox API key** with permission to create stock reservations only. Verify: a `curl -X POST` with the key to the reservations endpoint returns 2xx.
2. **Confirm the WMS honours an `Idempotency-Key` header** (a repeat request with the same key returns the original result and does not reserve twice). Why: our retries can resend a request. If the WMS lacks this, our own idempotency at the Salesforce end still holds, but stock could be reserved twice. Verify: send the same request twice and check that stock drops once.
3. **No WMS yet?** Any HTTPS endpoint that returns 200 to a POST works. Unit tests mock it.

### On your machine

Install Salesforce CLI (`sf`). Verify: `sf --version` prints a version.

## How it works

### The five parts

| Part | Job |
|---|---|
| Intake trigger | Enqueues a Queueable for new rows. Keeps the user's save fast. |
| Chained Queueable | Processes a small slice, one callout phase then one DML phase. |
| Finalizer | Runs after the Queueable ends, even on an uncatchable failure. |
| Retry scheduler | A Schedulable that restarts work whose retry time has come. |
| Platform event | Carries failure alerts out of the transaction. |

### Chaining

**Chaining** means a Queueable enqueues the next one when it finishes. Each link is a separate transaction with fresh limits, so you can work through thousands of rows in small slices. A running job may enqueue only one child, so the child carries the rest. Chains have no depth limit in production orgs. Developer Edition and trial orgs cap the depth, so check the current docs if you test there.

### Finalizers

A **finalizer** is a class that implements `Finalizer` and is attached to a Queueable with `System.attachFinalizer`. After the Queueable ends, the platform runs the finalizer in a separate transaction and tells it the result: `SUCCESS` or `UNHANDLED_EXCEPTION`. This matters because some failures cannot be caught. A governor limit exception, for example, kills the transaction and `catch` never runs. The finalizer still runs. It can also enqueue the next job, so the chain survives a crash.

### Idempotency

An operation is **idempotent** when doing it twice has the same effect as doing it once. Async work needs this because jobs can be retried, a client can resend, and a scheduler can pick up a record that a running job is still working on. We use three layers: an **idempotency key** on the intake row (unique, so duplicates cannot be inserted), an upsert on the same key for the fulfillment order, and the same key sent to the WMS in a header.

### Backoff

**Exponential backoff** means each retry waits longer than the last: 5, 10, 20, 40 minutes, up to a cap. It gives a struggling system time to recover and stops you from hammering it. We store the time of the next attempt on the record. A scheduled job picks up what is due.

### Why the work is split into two phases

Inside one transaction, you cannot do DML and then a callout. The platform raises an "uncommitted work pending" error. So the service makes all callouts first, collects results, then performs all DML.

## Basic example

A minimal Queueable with a finalizer. The finalizer logs the failure of a job that throws.

```apex
public class BasicJobWithFinalizer implements Queueable {

    public class Failer extends Exception {}

    private final Boolean shouldFail;

    public BasicJobWithFinalizer(Boolean shouldFail) {
        this.shouldFail = shouldFail;
    }

    public void execute(QueueableContext ctx) {
        // Attach first, so it runs even if the next line throws.
        System.attachFinalizer(new BasicFinalizer());
        if (shouldFail) {
            throw new Failer('Boom');
        }
        System.debug('Job finished normally');
    }

    public class BasicFinalizer implements Finalizer {
        public void execute(FinalizerContext fc) {
            if (fc.getResult() == ParentJobResult.UNHANDLED_EXCEPTION) {
                System.debug(LoggingLevel.ERROR,
                    'Parent job ' + fc.getAsyncApexJobId() + ' failed: '
                    + fc.getException().getMessage());
            } else {
                System.debug('Parent job succeeded');
            }
        }
    }
}
```

```apex
// Anonymous Apex
System.enqueueJob(new BasicJobWithFinalizer(true));
```

Expected result: in Setup, Apex Jobs the job shows as Failed, and the debug log of the finalizer contains `Parent job <id> failed: Boom`.

## Advanced end-to-end example

### Metadata

**`force-app/main/default/objects/Async_Failure__e/Async_Failure__e.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <eventType>StandardVolume</eventType>
    <label>Async Failure</label>
    <pluralLabel>Async Failures</pluralLabel>
    <publishBehavior>PublishImmediately</publishBehavior>
    <fields>
        <fullName>Job_Id__c</fullName>
        <label>Job Id</label>
        <length>18</length>
        <required>false</required>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>Job_Type__c</fullName>
        <label>Job Type</label>
        <length>80</length>
        <required>false</required>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>Message__c</fullName>
        <label>Message</label>
        <length>255</length>
        <required>false</required>
        <type>Text</type>
    </fields>
    <fields>
        <fullName>Record_Count__c</fullName>
        <label>Record Count</label>
        <precision>6</precision>
        <required>false</required>
        <scale>0</scale>
        <type>Number</type>
    </fields>
</CustomObject>
```

### Retry policy

All the backoff rules live in one small class that is easy to test.

**`force-app/main/default/classes/RetryPolicy.cls`**

```apex
public with sharing class RetryPolicy {

    public static final Integer MAX_ATTEMPTS = 5;
    public static final Integer BASE_MINUTES = 5;
    public static final Integer CAP_MINUTES = 240;

    // Attempt 1 waits 5 minutes, 2 waits 10, 3 waits 20, and so on, up to the cap.
    public static Integer delayMinutes(Integer attempt) {
        Integer minutes = BASE_MINUTES;
        for (Integer i = 1; i < attempt; i++) {
            minutes = minutes * 2;
            if (minutes >= CAP_MINUTES) {
                return CAP_MINUTES;
            }
        }
        return Math.min(minutes, CAP_MINUTES);
    }

    public static Datetime nextAttemptAt(Datetime now, Integer attempt) {
        return now.addMinutes(delayMinutes(attempt));
    }

    public static Boolean isExhausted(Integer attempt) {
        return attempt >= MAX_ATTEMPTS;
    }

    // 408, 429 and 5xx are worth retrying. Other 4xx will fail again.
    public static Boolean isTransient(Integer statusCode) {
        return statusCode == 408 || statusCode == 429 || statusCode >= 500;
    }
}
```

### Failure handling and alerts

One place decides what a failure means for a record, and one place publishes alerts.

**`force-app/main/default/classes/OrderFailureHandler.cls`**

```apex
public with sharing class OrderFailureHandler {

    public static final String JOB_TYPE = 'OrderProcessing';

    // Applies a failure to a record update: Retry with backoff, or Dead.
    // Returns true when the record is now dead.
    public static Boolean applyFailure(
        Order_Intake__c update_, Integer attempts, String message,
        Boolean permanent, Datetime now
    ) {
        update_.Attempt_Count__c = attempts;
        update_.Last_Error__c = message == null ? null : message.left(255);
        if (permanent || RetryPolicy.isExhausted(attempts)) {
            update_.Status__c = 'Dead';
            update_.Next_Attempt_At__c = null;
            return true;
        }
        update_.Status__c = 'Retry';
        update_.Next_Attempt_At__c = RetryPolicy.nextAttemptAt(now, attempts);
        return false;
    }

    // Called by the finalizer when the whole slice crashed. The crashed
    // transaction rolled back, so the rows still hold their old values.
    public static void markForRetry(List<Id> ids, String message, Id jobId) {
        List<Order_Intake__c> rows = [
            SELECT Id, Attempt_Count__c FROM Order_Intake__c
            WHERE Id IN :ids AND Status__c IN ('New', 'Retry')
            WITH USER_MODE
        ];
        Datetime now = Datetime.now();
        List<Order_Intake__c> updates = new List<Order_Intake__c>();
        Integer dead = 0;
        for (Order_Intake__c row : rows) {
            Integer attempts = row.Attempt_Count__c == null
                ? 1 : Integer.valueOf(row.Attempt_Count__c) + 1;
            Order_Intake__c upd = new Order_Intake__c(Id = row.Id);
            if (applyFailure(upd, attempts, message, false, now)) {
                dead++;
            }
            updates.add(upd);
        }
        Database.update(updates, false, AccessLevel.USER_MODE);
        publish(new List<Async_Failure__e>{
            event(jobId, 'Job crashed, ' + rows.size() + ' rows set to retry, '
                + dead + ' dead. ' + message, rows.size())
        });
    }

    public static Async_Failure__e event(Id jobId, String message, Integer count) {
        return new Async_Failure__e(
            Job_Id__c = jobId == null ? null : String.valueOf(jobId),
            Job_Type__c = JOB_TYPE,
            Message__c = message == null ? null : message.left(255),
            Record_Count__c = count
        );
    }

    // One publish call for the whole list.
    public static void publish(List<Async_Failure__e> events) {
        if (events.isEmpty()) {
            return;
        }
        for (Database.SaveResult sr : EventBus.publish(events)) {
            if (!sr.isSuccess()) {
                System.debug(LoggingLevel.ERROR,
                    'Could not publish failure event: ' + sr.getErrors()[0].getMessage());
            }
        }
    }
}
```

### Service: callouts first, DML second

**`force-app/main/default/classes/OrderProcessingService.cls`**

```apex
public with sharing class OrderProcessingService {

    public class OrderPayload {
        public String customerNumber;
        public String sku;
        public Integer quantity;
    }

    public enum Outcome { OK, TRANSIENT_FAIL, PERMANENT_FAIL }

    public class Result {
        public Outcome outcome;
        public String message;
        public OrderPayload payload;
    }

    public static Integer process(List<Order_Intake__c> slice, Id jobId) {
        // Phase 1: callouts only. No DML may happen before this loop ends.
        Map<Id, Result> results = new Map<Id, Result>();
        for (Order_Intake__c intake : slice) {
            results.put(intake.Id, reserve(intake));
        }
        // Phase 2: all DML.
        return persist(slice, results, jobId);
    }

    private static Result reserve(Order_Intake__c intake) {
        Result r = new Result();
        if (String.isBlank(intake.Payload__c)) {
            return fail(r, Outcome.PERMANENT_FAIL, 'Empty payload');
        }
        try {
            r.payload = (OrderPayload) JSON.deserialize(
                intake.Payload__c, OrderPayload.class);
        } catch (JSONException e) {
            return fail(r, Outcome.PERMANENT_FAIL, 'Invalid payload: ' + e.getMessage());
        }
        if (String.isBlank(r.payload.sku) || r.payload.quantity == null
            || r.payload.quantity <= 0) {
            return fail(r, Outcome.PERMANENT_FAIL, 'Missing sku or quantity');
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Warehouse_WMS/reservations');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        // The same key on every retry makes the WMS call safe to repeat.
        req.setHeader('Idempotency-Key', intake.Idempotency_Key__c);
        req.setTimeout(20000);
        req.setBody(JSON.serialize(r.payload));
        try {
            HttpResponse res = new Http().send(req);
            Integer code = res.getStatusCode();
            if (code >= 200 && code <= 299) {
                r.outcome = Outcome.OK;
                return r;
            }
            return fail(r, RetryPolicy.isTransient(code)
                ? Outcome.TRANSIENT_FAIL : Outcome.PERMANENT_FAIL, 'WMS returned ' + code);
        } catch (CalloutException e) {
            return fail(r, Outcome.TRANSIENT_FAIL, 'Callout error: ' + e.getMessage());
        }
    }

    private static Result fail(Result r, Outcome outcome, String message) {
        r.outcome = outcome;
        r.message = message;
        return r;
    }

    private static Integer persist(
        List<Order_Intake__c> slice, Map<Id, Result> results, Id jobId
    ) {
        Datetime now = Datetime.now();
        Map<Id, Order_Intake__c> updates = new Map<Id, Order_Intake__c>();
        Map<String, Id> intakeByKey = new Map<String, Id>();
        List<Fulfillment_Order__c> orders = new List<Fulfillment_Order__c>();
        List<Async_Failure__e> events = new List<Async_Failure__e>();

        for (Order_Intake__c intake : slice) {
            Result r = results.get(intake.Id);
            Order_Intake__c upd = new Order_Intake__c(Id = intake.Id);
            updates.put(intake.Id, upd);
            if (r.outcome == Outcome.OK) {
                orders.add(new Fulfillment_Order__c(
                    Idempotency_Key__c = intake.Idempotency_Key__c,
                    Customer_Number__c = r.payload.customerNumber,
                    Sku__c = r.payload.sku,
                    Quantity__c = r.payload.quantity
                ));
                intakeByKey.put(intake.Idempotency_Key__c, intake.Id);
                upd.Status__c = 'Processed';
                upd.Last_Error__c = null;
                upd.Next_Attempt_At__c = null;
            } else {
                recordFailure(intake, upd, r, now, events, jobId);
            }
        }

        // Upsert on the external ID: a replay updates, it never duplicates.
        SObjectAccessDecision decision =
            Security.stripInaccessible(AccessType.UPSERTABLE, orders);
        List<Database.UpsertResult> saved = Database.upsert(
            decision.getRecords(), Fulfillment_Order__c.Idempotency_Key__c, false);
        for (Integer i = 0; i < saved.size(); i++) {
            if (!saved[i].isSuccess()) {
                String key = orders[i].Idempotency_Key__c;
                Id intakeId = intakeByKey.get(key);
                Order_Intake__c original = new Map<Id, Order_Intake__c>(slice).get(intakeId);
                Result r = new Result();
                r.outcome = Outcome.TRANSIENT_FAIL;
                r.message = 'Save failed: ' + saved[i].getErrors()[0].getMessage();
                recordFailure(original, updates.get(intakeId), r, now, events, jobId);
            }
        }

        Integer processed = 0;
        for (Order_Intake__c u : updates.values()) {
            if (u.Status__c == 'Processed') {
                processed++;
            }
        }
        Database.update(updates.values(), false, AccessLevel.USER_MODE);
        OrderFailureHandler.publish(events);
        return processed;
    }

    private static void recordFailure(
        Order_Intake__c intake, Order_Intake__c upd, Result r,
        Datetime now, List<Async_Failure__e> events, Id jobId
    ) {
        Integer attempts = intake.Attempt_Count__c == null
            ? 1 : Integer.valueOf(intake.Attempt_Count__c) + 1;
        Boolean dead = OrderFailureHandler.applyFailure(
            upd, attempts, r.message, r.outcome == Outcome.PERMANENT_FAIL, now);
        if (dead) {
            events.add(OrderFailureHandler.event(
                jobId, 'Order ' + intake.Idempotency_Key__c + ' is dead: ' + r.message, 1));
        }
    }
}
```

### Chained queueable and finalizer

**`force-app/main/default/classes/OrderProcessorQueueable.cls`**

```apex
public with sharing class OrderProcessorQueueable
    implements Queueable, Database.AllowsCallouts {

    // 20 callouts per slice leaves a wide margin under the 100 callout limit.
    public static final Integer SLICE_SIZE = 20;

    public class ForcedFailureException extends Exception {}

    @TestVisible
    private static Boolean forceFailure = false;

    private final List<Id> intakeIds;

    public OrderProcessorQueueable(List<Id> intakeIds) {
        this.intakeIds = intakeIds;
    }

    public void execute(QueueableContext ctx) {
        List<Id> slice = new List<Id>();
        List<Id> rest = new List<Id>();
        for (Integer i = 0; i < intakeIds.size(); i++) {
            if (i < SLICE_SIZE) {
                slice.add(intakeIds[i]);
            } else {
                rest.add(intakeIds[i]);
            }
        }
        // Attach before any work. The finalizer owns the chain from here on.
        System.attachFinalizer(new OrderProcessorFinalizer(slice, rest));

        if (forceFailure) {
            throw new ForcedFailureException('Forced failure for test');
        }
        // Re-query and filter by status: a replayed job finds nothing to do.
        List<Order_Intake__c> intakes = [
            SELECT Id, Idempotency_Key__c, Payload__c, Attempt_Count__c
            FROM Order_Intake__c
            WHERE Id IN :slice AND Status__c IN ('New', 'Retry')
            WITH USER_MODE
        ];
        OrderProcessingService.process(intakes, ctx.getJobId());
    }
}
```

**`force-app/main/default/classes/OrderProcessorFinalizer.cls`**

```apex
public with sharing class OrderProcessorFinalizer implements Finalizer {

    private final List<Id> slice;
    private final List<Id> rest;

    public OrderProcessorFinalizer(List<Id> slice, List<Id> rest) {
        this.slice = slice;
        this.rest = rest;
    }

    public void execute(FinalizerContext ctx) {
        if (ctx.getResult() == ParentJobResult.UNHANDLED_EXCEPTION) {
            Exception ex = ctx.getException();
            OrderFailureHandler.markForRetry(
                slice,
                ex == null ? 'Unhandled exception' : ex.getMessage(),
                ctx.getAsyncApexJobId()
            );
        }
        // Continue the chain whether the slice worked or crashed.
        // Apex tests cannot chain queueable jobs, so the guard keeps them green.
        if (!rest.isEmpty() && !Test.isRunningTest()) {
            System.enqueueJob(new OrderProcessorQueueable(rest));
        }
    }
}
```

### Entry points: idempotent intake and trigger

**`force-app/main/default/classes/OrderIntakeService.cls`**

```apex
public with sharing class OrderIntakeService {

    @TestVisible
    private static Boolean suppressEnqueue = false;

    // The storefront may resend. Keep only keys we have not seen.
    public static Integer accept(List<Order_Intake__c> incoming) {
        Set<String> keys = new Set<String>();
        for (Order_Intake__c o : incoming) {
            if (String.isNotBlank(o.Idempotency_Key__c)) {
                keys.add(o.Idempotency_Key__c);
            }
        }
        Set<String> existing = new Set<String>();
        for (Order_Intake__c e : [
            SELECT Idempotency_Key__c FROM Order_Intake__c
            WHERE Idempotency_Key__c IN :keys WITH USER_MODE
        ]) {
            existing.add(e.Idempotency_Key__c);
        }
        List<Order_Intake__c> fresh = new List<Order_Intake__c>();
        for (Order_Intake__c o : incoming) {
            // add() returns false for a key we already saw in this batch.
            if (String.isNotBlank(o.Idempotency_Key__c)
                && !existing.contains(o.Idempotency_Key__c)
                && existing.add(o.Idempotency_Key__c)) {
                o.Status__c = 'New';
                fresh.add(o);
            }
        }
        // The unique constraint is the backstop for a race between two loads.
        Database.insert(fresh, false, AccessLevel.USER_MODE);
        return fresh.size();
    }

    public static void enqueueNew(List<Order_Intake__c> rows) {
        if (suppressEnqueue || rows.isEmpty()) {
            return;
        }
        // In an async context only one more job is allowed. If we are out of
        // room, leave the rows as New: the retry scheduler sweeps stale ones.
        if (Limits.getQueueableJobs() >= Limits.getLimitQueueableJobs()) {
            return;
        }
        List<Id> ids = new List<Id>();
        for (Order_Intake__c r : rows) {
            ids.add(r.Id);
        }
        System.enqueueJob(new OrderProcessorQueueable(ids));
    }
}
```

**`force-app/main/default/triggers/OrderIntakeTrigger.trigger`**

```apex
trigger OrderIntakeTrigger on Order_Intake__c (after insert) {
    // One job for the whole chunk of up to 200 rows, never one per row.
    OrderIntakeService.enqueueNew(Trigger.new);
}
```

**`force-app/main/default/triggers/AsyncFailureTrigger.trigger`**

```apex
trigger AsyncFailureTrigger on Async_Failure__e (after insert) {
    // Subscriber: turn each alert into a Case for the operations queue.
    List<Case> cases = new List<Case>();
    for (Async_Failure__e e : Trigger.new) {
        cases.add(new Case(
            Subject = 'Async failure: ' + e.Job_Type__c,
            Description = 'Job ' + e.Job_Id__c + ' | rows: ' + e.Record_Count__c
                + '\n' + e.Message__c,
            Priority = 'High',
            Origin = 'Internal'
        ));
    }
    Database.insert(cases, false);
}
```

### Scheduled retry

**`force-app/main/default/classes/OrderRetryScheduler.cls`**

```apex
public with sharing class OrderRetryScheduler implements Schedulable {

    public static final Integer MAX_PER_RUN = 1000;
    public static final Integer STALE_NEW_MINUTES = 10;

    public void execute(SchedulableContext sc) {
        Datetime now = Datetime.now();
        Datetime staleBefore = now.addMinutes(-STALE_NEW_MINUTES);
        List<Id> ids = new List<Id>();
        for (Order_Intake__c o : [
            SELECT Id FROM Order_Intake__c
            WHERE (Status__c = 'Retry' AND Next_Attempt_At__c <= :now)
               OR (Status__c = 'New' AND CreatedDate < :staleBefore)
            WITH USER_MODE
            ORDER BY CreatedDate
            LIMIT :MAX_PER_RUN
        ]) {
            ids.add(o.Id);
        }
        if (!ids.isEmpty()) {
            // One job starts the chain. It slices the rest by itself.
            System.enqueueJob(new OrderProcessorQueueable(ids));
        }
    }
}
```

Schedule it every five minutes:

```apex
// Anonymous Apex
System.schedule('Order retry sweep', '0 0/5 * * * ?', new OrderRetryScheduler());
```

### Monitoring

**`force-app/main/default/classes/AsyncJobMonitor.cls`**

```apex
public with sharing class AsyncJobMonitor {

    public static final Set<String> OUR_CLASSES = new Set<String>{
        'OrderProcessorQueueable', 'OrderRetryScheduler'
    };

    // Counts of our jobs by status in the last N hours.
    public static Map<String, Integer> statusCounts(Set<String> classNames, Integer hours) {
        Datetime since = Datetime.now().addHours(-hours);
        Map<String, Integer> counts = new Map<String, Integer>();
        for (AsyncApexJob j : [
            SELECT Status FROM AsyncApexJob
            WHERE ApexClass.Name IN :classNames AND CreatedDate >= :since
        ]) {
            Integer current = counts.containsKey(j.Status) ? counts.get(j.Status) : 0;
            counts.put(j.Status, current + 1);
        }
        return counts;
    }

    // Recent failures with the platform's own error text.
    public static List<AsyncApexJob> recentFailures(Set<String> classNames, Integer hours) {
        Datetime since = Datetime.now().addHours(-hours);
        return [
            SELECT Id, ApexClass.Name, JobType, Status, ExtendedStatus, CreatedDate
            FROM AsyncApexJob
            WHERE ApexClass.Name IN :classNames
            AND CreatedDate >= :since
            AND Status = 'Failed'
            ORDER BY CreatedDate DESC
            LIMIT 50
        ];
    }

    // How much is waiting right now.
    public static Integer waiting() {
        return [
            SELECT COUNT() FROM AsyncApexJob
            WHERE Status IN ('Queued', 'Preparing', 'Holding')
        ];
    }
}
```

The same checks work as plain SOQL in Developer Console or `sf data query`:

```soql
SELECT Id, ApexClass.Name, JobType, Status, NumberOfErrors, ExtendedStatus,
       CreatedDate, CompletedDate
FROM AsyncApexJob
WHERE ApexClass.Name = 'OrderProcessorQueueable'
AND CreatedDate = LAST_N_DAYS:1
ORDER BY CreatedDate DESC
```

### Tests

**`force-app/main/default/classes/WmsMock.cls`**

```apex
@IsTest
public class WmsMock implements HttpCalloutMock {

    public static Integer calls = 0;
    private final Integer status;

    public WmsMock(Integer status) {
        this.status = status;
    }

    public HttpResponse respond(HttpRequest req) {
        calls++;
        System.assertNotEquals(null, req.getHeader('Idempotency-Key'),
            'Every WMS call must carry the idempotency key');
        HttpResponse res = new HttpResponse();
        res.setStatusCode(status);
        res.setBody('{"reserved":true}');
        return res;
    }
}
```

**`force-app/main/default/classes/OrderAsyncTests.cls`**

```apex
@IsTest
private class OrderAsyncTests {

    private static final String GOOD =
        '{"customerNumber":"C-1","sku":"SKU-9","quantity":3}';

    private static List<Order_Intake__c> makeIntakes(Integer count, String payload) {
        List<Order_Intake__c> rows = new List<Order_Intake__c>();
        for (Integer i = 0; i < count; i++) {
            rows.add(new Order_Intake__c(
                Idempotency_Key__c = 'K-' + i + '-' + Math.abs(Crypto.getRandomInteger()),
                Payload__c = payload,
                Status__c = 'New'
            ));
        }
        return rows;
    }

    @IsTest
    static void bulkInsertEnqueuesOneJobAndProcessesFirstSlice() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        Test.startTest();
        insert makeIntakes(200, GOOD);
        Test.stopTest();

        System.assertEquals(1, [
            SELECT COUNT() FROM AsyncApexJob
            WHERE ApexClass.Name = 'OrderProcessorQueueable'
        ], 'One job for the whole 200-row chunk');
        // Chaining is skipped in tests, so only the first slice is processed.
        System.assertEquals(OrderProcessorQueueable.SLICE_SIZE,
            [SELECT COUNT() FROM Order_Intake__c WHERE Status__c = 'Processed']);
        System.assertEquals(OrderProcessorQueueable.SLICE_SIZE,
            [SELECT COUNT() FROM Fulfillment_Order__c]);
    }

    @IsTest
    static void transientFailureSchedulesRetryWithBackoff() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(503));
        Test.startTest();
        insert makeIntakes(1, GOOD);
        Test.stopTest();

        Order_Intake__c row = [
            SELECT Status__c, Attempt_Count__c, Next_Attempt_At__c, Last_Error__c
            FROM Order_Intake__c LIMIT 1
        ];
        System.assertEquals('Retry', row.Status__c);
        System.assertEquals(1, row.Attempt_Count__c);
        System.assert(row.Next_Attempt_At__c > Datetime.now().addMinutes(3));
        System.assert(row.Last_Error__c.contains('503'));
    }

    @IsTest
    static void permanentFailureGoesDeadAndRaisesAlert() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        Test.startTest();
        insert makeIntakes(1, 'not json');
        Test.stopTest();
        Test.getEventBus().deliver();

        System.assertEquals('Dead', [SELECT Status__c FROM Order_Intake__c LIMIT 1].Status__c);
        System.assertEquals(1, [SELECT COUNT() FROM Case WHERE Subject LIKE 'Async failure%']);
    }

    @IsTest
    static void exhaustedRetriesGoDead() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(503));
        List<Order_Intake__c> rows = makeIntakes(1, GOOD);
        rows[0].Attempt_Count__c = RetryPolicy.MAX_ATTEMPTS - 1;
        Test.startTest();
        insert rows;
        Test.stopTest();

        System.assertEquals('Dead', [SELECT Status__c FROM Order_Intake__c LIMIT 1].Status__c);
    }

    @IsTest
    static void processingTwiceNeverDuplicatesTheOrder() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        OrderIntakeService.suppressEnqueue = true;
        insert makeIntakes(1, GOOD);
        List<Order_Intake__c> rows = [
            SELECT Id, Idempotency_Key__c, Payload__c, Attempt_Count__c
            FROM Order_Intake__c
        ];
        Test.startTest();
        OrderProcessingService.process(rows, null);
        OrderProcessingService.process(rows, null); // replay of the same rows
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM Fulfillment_Order__c]);
    }

    @IsTest
    static void acceptDropsRepeatedKeys() {
        OrderIntakeService.suppressEnqueue = true;
        Order_Intake__c a = new Order_Intake__c(Idempotency_Key__c = 'DUP', Payload__c = GOOD);
        Order_Intake__c b = new Order_Intake__c(Idempotency_Key__c = 'DUP', Payload__c = GOOD);
        System.assertEquals(1, OrderIntakeService.accept(
            new List<Order_Intake__c>{ a, b }));
        // The storefront resends the same order.
        Order_Intake__c c = new Order_Intake__c(Idempotency_Key__c = 'DUP', Payload__c = GOOD);
        System.assertEquals(0, OrderIntakeService.accept(
            new List<Order_Intake__c>{ c }));
        System.assertEquals(1, [SELECT COUNT() FROM Order_Intake__c]);
    }

    @IsTest
    static void finalizerMarksCrashedSliceForRetry() {
        OrderProcessorQueueable.forceFailure = true;
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        Test.startTest();
        insert makeIntakes(3, GOOD);
        Test.stopTest();
        Test.getEventBus().deliver();

        System.assertEquals(3, [
            SELECT COUNT() FROM Order_Intake__c WHERE Status__c = 'Retry'
        ]);
        System.assertEquals(1, [SELECT COUNT() FROM Case WHERE Subject LIKE 'Async failure%']);
    }

    @IsTest
    static void markForRetryHandlesDirectCall() {
        OrderIntakeService.suppressEnqueue = true;
        List<Order_Intake__c> rows = makeIntakes(2, GOOD);
        insert rows;
        Test.startTest();
        OrderFailureHandler.markForRetry(
            new List<Id>{ rows[0].Id, rows[1].Id }, 'CPU limit', null);
        Test.stopTest();
        System.assertEquals(2, [
            SELECT COUNT() FROM Order_Intake__c
            WHERE Status__c = 'Retry' AND Attempt_Count__c = 1
        ]);
    }

    @IsTest
    static void schedulerPicksOnlyDueRetries() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        OrderIntakeService.suppressEnqueue = true;
        List<Order_Intake__c> rows = makeIntakes(4, GOOD);
        for (Integer i = 0; i < 3; i++) {
            rows[i].Status__c = 'Retry';
            rows[i].Next_Attempt_At__c = Datetime.now().addMinutes(-1);
        }
        rows[3].Status__c = 'Retry';
        rows[3].Next_Attempt_At__c = Datetime.now().addHours(2);
        insert rows;

        Test.startTest();
        new OrderRetryScheduler().execute(null);
        Test.stopTest();

        System.assertEquals(3, [SELECT COUNT() FROM Order_Intake__c WHERE Status__c = 'Processed']);
        System.assertEquals(1, [SELECT COUNT() FROM Order_Intake__c WHERE Status__c = 'Retry']);
    }

    @IsTest
    static void backoffGrowsAndIsCapped() {
        System.assertEquals(5, RetryPolicy.delayMinutes(1));
        System.assertEquals(10, RetryPolicy.delayMinutes(2));
        System.assertEquals(20, RetryPolicy.delayMinutes(3));
        System.assertEquals(RetryPolicy.CAP_MINUTES, RetryPolicy.delayMinutes(12));
        System.assert(RetryPolicy.isTransient(503));
        System.assert(RetryPolicy.isTransient(429));
        System.assert(!RetryPolicy.isTransient(400));
    }

    @IsTest
    static void monitorCountsJobsByStatus() {
        Test.setMock(HttpCalloutMock.class, new WmsMock(200));
        Test.startTest();
        insert makeIntakes(2, GOOD);
        Test.stopTest();

        Map<String, Integer> counts = AsyncJobMonitor.statusCounts(
            AsyncJobMonitor.OUR_CLASSES, 1);
        System.assert(counts.containsKey('Completed'));
        System.assertEquals(0, AsyncJobMonitor.recentFailures(
            AsyncJobMonitor.OUR_CLASSES, 1).size());
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org my-sandbox
sf apex run test --class-names OrderAsyncTests --result-format human \
  --code-coverage --wait 10 --target-org my-sandbox
```

## What happens behind the scenes

1. **Insert and trigger.** The storefront loads 200 rows. The `after insert` trigger runs once per chunk of 200 and calls `System.enqueueJob` once. The user's transaction commits with a single queue entry, so the save stays fast.
2. **First link.** The platform starts `OrderProcessorQueueable` after the commit. It splits 200 Ids into a slice of 20 and a rest of 180, and attaches the finalizer before any work. One SOQL query reads the slice. Twenty callouts follow, each with its own idempotency header. Then one `Database.upsert` for the fulfillment orders and one `Database.update` for the intake rows. Callouts used: 20 of 100. DML statements used: 2 of 150. Both are small, which is why the slice size is cautious.
3. **Finalizer.** When `execute` returns, the platform runs the finalizer in a separate transaction. On success it only enqueues the next link with the 180 remaining Ids. The chain continues in slices of 20 until the rest is empty. Each link starts only after the previous one and its finalizer have finished.
4. **A crash.** Suppose a link throws a limit exception. The whole link rolls back, so no half-processed row stays. `catch` blocks never run, but the finalizer does. It sees `UNHANDLED_EXCEPTION`, moves the slice to Retry with backoff, publishes an `Async_Failure__e`, and still enqueues the rest. The chain does not die.
5. **A WMS outage.** Callouts return 503. The service classifies them as transient, and `persist` writes `Status__c = 'Retry'` and `Next_Attempt_At__c` five minutes ahead, then ten, then twenty. After the fifth attempt the record is Dead and one alert is published.
6. **Event delivery.** `EventBus.publish` with Publish Immediately sends the event right away, even if this transaction later fails. The `AsyncFailureTrigger` runs in its own transaction as the Automated Process user and creates the Case.
7. **Scheduler.** Every five minutes `OrderRetryScheduler` runs a single query, finds due Retry rows and stale New rows, and enqueues one job that starts a new chain. If the previous chain is still working on a row, both may read it. The status filter, the unique key and the WMS header make that overlap harmless: you may do the call twice, but you never get two orders.

In debug logs, look for `CODE_UNIT_STARTED` with `OrderProcessorQueueable` and then another for the finalizer class. Each has its own `LIMIT_USAGE_FOR_NS` block. Platform events show as `EVENT_SERVICE` lines.

## Test it and verify

1. Deploy and run the tests as shown above. Expected: all tests pass.
2. Create 60 intake rows in Anonymous Apex:

   ```apex
   // Anonymous Apex
   List<Order_Intake__c> rows = new List<Order_Intake__c>();
   for (Integer i = 0; i < 60; i++) {
       rows.add(new Order_Intake__c(
           Idempotency_Key__c = 'DEMO-' + i,
           Payload__c = '{"customerNumber":"C-1","sku":"SKU-9","quantity":2}'
       ));
   }
   System.debug(OrderIntakeService.accept(rows));
   System.debug(OrderIntakeService.accept(rows.clone()));
   ```

   Expected: the first line prints 60, and the second prints 0 because the keys already exist. (Run it once only, as the objects hold the rows afterwards.)
3. Open Setup, Apex Jobs. Expected: a chain of `OrderProcessorQueueable` rows, three links for 60 rows.
4. Query `SELECT Status__c, COUNT(Id) FROM Order_Intake__c GROUP BY Status__c`. Expected: Processed 60 if the WMS answers, or Retry if it does not.
5. Break the WMS endpoint on purpose, insert one row, and wait. Expected: `Retry`, `Attempt_Count__c = 1` and a `Next_Attempt_At__c` about five minutes ahead.
6. Run `System.debug(AsyncJobMonitor.statusCounts(AsyncJobMonitor.OUR_CLASSES, 24));` Expected: a map of status to count.
7. Force a crash by running in Anonymous Apex `System.enqueueJob(new OrderProcessorQueueable(new List<Id>{ someIntakeId }));` against a row whose Payload makes the service throw, or temporarily change the code to throw. Expected: a Failed job, a finalizer log line, an `Async_Failure__e` and a new Case.

## Common mistakes and fixes

- **Symptom: "You have uncommitted work pending".** Cause: DML before a callout in the same transaction. Fix: split into a callout phase and a DML phase, as `OrderProcessingService` does.
- **Symptom: the chain stops after one failure and the rest never run.** Cause: the chaining line sits after code that threw. Fix: let the finalizer enqueue the next link, as shown.
- **Symptom: duplicate fulfillment orders.** Cause: `insert` instead of `upsert`, or no unique external ID. Fix: upsert on the idempotency key and add the unique constraint.
- **Symptom: "Too many queueable jobs added to the queue: 2".** Cause: enqueuing in a loop, or from async code that already enqueued once. Fix: one job per transaction carrying the whole list, and a check of `Limits.getQueueableJobs()`.
- **Symptom: a retry storm against a failing system.** Cause: immediate or fixed-interval retries. Fix: exponential backoff with a cap and a maximum attempt count, stored on the record.
- **Symptom: `UNABLE_TO_LOCK_ROW` errors when two chains touch the same rows.** Cause: overlapping jobs. Fix: keep slices small, filter by status inside the job, and retry on the next sweep.
- **Symptom: failures nobody notices.** Cause: only `System.debug` on failure. Fix: publish a platform event with Publish Immediately and give operations a Case, a Slack message or both.
- **Symptom: a test fails with a chaining or stack depth error.** Cause: chaining a Queueable inside a test. Fix: guard the chain with `Test.isRunningTest()`, and keep slice logic in testable methods.

## Key takeaways

- Process in small slices and chain. Each link has fresh limits, and a crash costs one slice.
- Attach a finalizer first, and let it own failure handling and the next link.
- Make every step safe to repeat: unique keys, upserts, status filters and an idempotency header.
- Retry with growing delays and a hard stop, and keep the schedule in data on the record.
- Alert through a platform event and watch `AsyncApexJob` so failures are never silent.

## Where to go next

- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)
- [Schedulable Apex complete guide](/articles/schedulable-apex-complete-guide/)
- [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/)
- [Integration reliability and idempotency](/articles/integration-reliability-idempotency/)
- [Apex exception handling and logging](/articles/apex-exception-handling-and-logging/)
