---
title: "Reliable Integrations: Idempotency, Retries, Ordering and Error Handling"
description: "Design integrations that survive failures: external IDs, stale-message checks, dead-letter records, retry scheduling and reconciliation, with full tested code."
category: salesforce-development
tags: [Integration, Architecture, Advanced, Reliability]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/integration-reliability-idempotency.jpg
sources:
  - title: "Integration Patterns (Salesforce Architects)"
    url: "https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
---

Networks fail, systems restart and messages arrive twice or out of order. A reliable integration assumes all of this and still ends with correct data. This article gives you four building blocks you can reuse in any integration: an **idempotent inbox**, a **stale-message check**, a **dead-letter record** and a **reconciliation job**.

## The business scenario

Summit Cycles (a fictional bike retailer) receives stock level messages from a warehouse system. The warehouse sends the same message again if it does not see an acknowledgement, and during a busy hour two messages for the same product can arrive in the wrong order, so an old count can overwrite a new one. Summit also needs bad messages kept somewhere humans can see, retried automatically, and a nightly check that Salesforce still matches the warehouse.

## Before you start: setup

### In Salesforce

1. Create `Stock_Level__c` with these fields: `External_Id__c` (text, External ID, Unique, case sensitive), `Sku__c` (text), `Quantity__c` (number), `Source_Version__c` (number, 18 digits, no decimals) and `Last_Synced__c` (date/time).
2. Create `Integration_Error__c` (metadata shown below) as the dead-letter store.
3. Create a permission set `Stock_Sync_Integration` granting create and edit on both objects and access to the Apex classes. Assign it to the integration user.
4. Use a sandbox or scratch org to deploy and run tests.

### In the external system

1. Make the warehouse include a **message id**, a **SKU** and a **monotonic version** (a sequence number or an update timestamp in milliseconds) in every message.
2. Make the warehouse retry only on timeouts or `5xx`, and treat any `2xx` as acknowledged.
3. Agree on a reconciliation endpoint or export that returns the current quantity for each SKU.

## How it works

Reliability rests on a few ideas:

- **Idempotency.** Processing a message twice gives the same result as once. Upserting on an External ID does this naturally for "set the value" messages.
- **Ordering.** Never trust arrival order. Each message carries a version; you apply it only if it is newer than the stored one.
- **Dead letters.** A message that cannot be processed is stored with its payload and error, not thrown away.
- **Retries with backoff.** Temporary failures are retried later with growing delays. Permanent ones go to humans.
- **Reconciliation.** A scheduled job compares both systems and repairs differences, because even a well designed pipeline can lose something.

## Basic example

The smallest idempotent write is a single upsert on an External ID.

```apex
public with sharing class StockSimple {
    public static void apply(String sku, Decimal quantity) {
        Stock_Level__c row = new Stock_Level__c(
            External_Id__c = sku,
            Sku__c = sku,
            Quantity__c = quantity
        );
        upsert row Stock_Level__c.External_Id__c;
    }
}
```

Run it twice with the same input and there is still one row. What this version cannot do is reject an older message that arrives late, record failures, or detect drift. The advanced version adds those.

## Advanced end-to-end example

**force-app/main/default/objects/Integration_Error__c/Integration_Error__c.object-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Integration Error</label>
    <pluralLabel>Integration Errors</pluralLabel>
    <nameField>
        <label>Error Number</label>
        <type>AutoNumber</type>
        <displayFormat>ERR-{00000}</displayFormat>
        <startingNumber>1</startingNumber>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
    <enableActivities>false</enableActivities>
    <enableReports>true</enableReports>
</CustomObject>
```

Add these fields to `Integration_Error__c`: `Source__c` (text 80), `Error__c` (text 255), `Payload__c` (long text 32768), `Attempts__c` (number 3,0), `Status__c` (text 40, values `Needs review`, `Retry`, `Resolved`) and `Next_Attempt__c` (date/time).

**force-app/main/default/classes/StockMessage.cls**

```apex
public with sharing class StockMessage {
    public String messageId;
    public String sku;
    public Integer quantity;
    public Long version;

    public static StockMessage parse(String json) {
        return (StockMessage) System.JSON.deserialize(json, StockMessage.class);
    }

    public String validate() {
        if (String.isBlank(sku)) {
            return 'sku is required';
        }
        if (quantity == null || quantity < 0) {
            return 'quantity must be zero or more';
        }
        if (version == null) {
            return 'version is required';
        }
        return null;
    }
}
```

**force-app/main/default/classes/StockInboxService.cls**

```apex
public with sharing class StockInboxService {

    public enum Outcome { APPLIED, DUPLICATE_OR_STALE, REJECTED, DEAD_LETTERED }

    public static Outcome process(String rawJson) {
        StockMessage msg;
        try {
            msg = StockMessage.parse(rawJson);
        } catch (Exception e) {
            record('stock-inbox', rawJson, 'Unparseable JSON: ' + e.getMessage(), 'Needs review', 1);
            return Outcome.REJECTED;
        }

        String problem = msg.validate();
        if (problem != null) {
            record('stock-inbox', rawJson, problem, 'Needs review', 1);
            return Outcome.REJECTED;
        }

        try {
            List<Stock_Level__c> existing = [
                SELECT Id, Source_Version__c
                FROM Stock_Level__c
                WHERE External_Id__c = :msg.sku
                LIMIT 1
            ];
            if (!existing.isEmpty()
                && existing[0].Source_Version__c != null
                && existing[0].Source_Version__c >= msg.version) {
                return Outcome.DUPLICATE_OR_STALE;
            }

            upsert new Stock_Level__c(
                External_Id__c = msg.sku,
                Sku__c = msg.sku,
                Quantity__c = msg.quantity,
                Source_Version__c = msg.version,
                Last_Synced__c = System.now()
            ) Stock_Level__c.External_Id__c;
            return Outcome.APPLIED;
        } catch (DmlException e) {
            // Possibly a lock or a temporary problem: keep for retry.
            record('stock-inbox', rawJson, e.getMessage(), 'Retry', 1);
            return Outcome.DEAD_LETTERED;
        }
    }

    public static void record(String source, String payload, String error,
                              String status, Integer attempts) {
        insert new Integration_Error__c(
            Source__c = source,
            Payload__c = payload,
            Error__c = error == null ? null : error.left(255),
            Status__c = status,
            Attempts__c = attempts,
            Next_Attempt__c = status == 'Retry'
                ? System.now().addMinutes(Math.min(60, 5 * attempts * attempts))
                : null
        );
    }
}
```

**force-app/main/default/classes/StockRetryJob.cls**

```apex
public with sharing class StockRetryJob implements Schedulable {

    public static final Integer MAX_ATTEMPTS = 5;

    public void execute(SchedulableContext ctx) {
        List<Integration_Error__c> due = [
            SELECT Id, Payload__c, Attempts__c
            FROM Integration_Error__c
            WHERE Status__c = 'Retry'
              AND Next_Attempt__c <= :System.now()
            ORDER BY Next_Attempt__c
            LIMIT 50
        ];

        List<Integration_Error__c> updates = new List<Integration_Error__c>();
        for (Integration_Error__c row : due) {
            Integer attempts = (Integer) row.Attempts__c + 1;
            StockInboxService.Outcome result = StockInboxService.Outcome.REJECTED;
            try {
                result = reprocess(row.Payload__c);
            } catch (Exception e) {
                result = StockInboxService.Outcome.DEAD_LETTERED;
            }

            if (result == StockInboxService.Outcome.APPLIED
                || result == StockInboxService.Outcome.DUPLICATE_OR_STALE) {
                updates.add(new Integration_Error__c(Id = row.Id, Status__c = 'Resolved'));
            } else if (attempts >= MAX_ATTEMPTS) {
                updates.add(new Integration_Error__c(
                    Id = row.Id, Status__c = 'Needs review', Attempts__c = attempts));
            } else {
                updates.add(new Integration_Error__c(
                    Id = row.Id,
                    Attempts__c = attempts,
                    Next_Attempt__c = System.now().addMinutes(Math.min(60, 5 * attempts * attempts))
                ));
            }
        }
        update updates;
    }

    // Reprocess without creating a second dead letter for the same message.
    @TestVisible
    private static StockInboxService.Outcome reprocess(String payload) {
        StockMessage msg = StockMessage.parse(payload);
        List<Stock_Level__c> existing = [
            SELECT Source_Version__c FROM Stock_Level__c
            WHERE External_Id__c = :msg.sku LIMIT 1
        ];
        if (!existing.isEmpty() && existing[0].Source_Version__c >= msg.version) {
            return StockInboxService.Outcome.DUPLICATE_OR_STALE;
        }
        upsert new Stock_Level__c(
            External_Id__c = msg.sku, Sku__c = msg.sku, Quantity__c = msg.quantity,
            Source_Version__c = msg.version, Last_Synced__c = System.now()
        ) Stock_Level__c.External_Id__c;
        return StockInboxService.Outcome.APPLIED;
    }
}
```

**force-app/main/default/classes/StockReconciliationBatch.cls**

```apex
public with sharing class StockReconciliationBatch implements Database.Batchable<SObject> {

    // Injected in tests; in production this calls the warehouse export.
    public static Map<String, Integer> warehouseCounts = new Map<String, Integer>();

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator(
            'SELECT Id, Sku__c, Quantity__c FROM Stock_Level__c');
    }

    public void execute(Database.BatchableContext bc, List<Stock_Level__c> scope) {
        List<Integration_Error__c> drift = new List<Integration_Error__c>();
        for (Stock_Level__c row : scope) {
            Integer expected = warehouseCounts.get(row.Sku__c);
            if (expected != null && expected != row.Quantity__c) {
                drift.add(new Integration_Error__c(
                    Source__c = 'reconciliation',
                    Error__c = 'Drift for ' + row.Sku__c + ': Salesforce '
                        + row.Quantity__c + ', warehouse ' + expected,
                    Status__c = 'Needs review',
                    Attempts__c = 0
                ));
            }
        }
        insert drift;
    }

    public void finish(Database.BatchableContext bc) {}
}
```

**force-app/main/default/classes/StockReliabilityTest.cls**

```apex
@IsTest
private class StockReliabilityTest {

    private static String msg(String sku, Integer qty, Long version) {
        return '{"messageId":"m-' + version + '","sku":"' + sku
            + '","quantity":' + qty + ',"version":' + version + '}';
    }

    @IsTest
    static void duplicateIsIgnored() {
        StockInboxService.process(msg('BIKE-1', 10, 100));
        StockInboxService.Outcome second = StockInboxService.process(msg('BIKE-1', 10, 100));
        System.assertEquals(StockInboxService.Outcome.DUPLICATE_OR_STALE, second);
        System.assertEquals(1, [SELECT COUNT() FROM Stock_Level__c]);
    }

    @IsTest
    static void olderMessageDoesNotOverwriteNewer() {
        StockInboxService.process(msg('BIKE-1', 20, 200));
        StockInboxService.process(msg('BIKE-1', 5, 150));
        Stock_Level__c row = [SELECT Quantity__c FROM Stock_Level__c WHERE Sku__c = 'BIKE-1'];
        System.assertEquals(20, row.Quantity__c);
    }

    @IsTest
    static void newerMessageWins() {
        StockInboxService.process(msg('BIKE-1', 20, 200));
        StockInboxService.process(msg('BIKE-1', 12, 300));
        Stock_Level__c row = [SELECT Quantity__c FROM Stock_Level__c WHERE Sku__c = 'BIKE-1'];
        System.assertEquals(12, row.Quantity__c);
    }

    @IsTest
    static void badMessageBecomesDeadLetter() {
        StockInboxService.Outcome o = StockInboxService.process('{"sku":"","quantity":-1}');
        System.assertEquals(StockInboxService.Outcome.REJECTED, o);
        Integration_Error__c err = [SELECT Status__c, Error__c FROM Integration_Error__c];
        System.assertEquals('Needs review', err.Status__c);
        System.assertEquals(0, [SELECT COUNT() FROM Stock_Level__c]);
    }

    @IsTest
    static void retryJobResolvesDueRows() {
        insert new Integration_Error__c(
            Source__c = 'stock-inbox',
            Payload__c = msg('BIKE-2', 7, 400),
            Status__c = 'Retry',
            Attempts__c = 1,
            Next_Attempt__c = System.now().addMinutes(-1)
        );
        Test.startTest();
        new StockRetryJob().execute(null);
        Test.stopTest();
        System.assertEquals('Resolved', [SELECT Status__c FROM Integration_Error__c].Status__c);
        System.assertEquals(7, [SELECT Quantity__c FROM Stock_Level__c WHERE Sku__c = 'BIKE-2'].Quantity__c);
    }

    @IsTest
    static void retryJobEscalatesAfterMaxAttempts() {
        insert new Integration_Error__c(
            Source__c = 'stock-inbox',
            Payload__c = 'not json',
            Status__c = 'Retry',
            Attempts__c = StockRetryJob.MAX_ATTEMPTS - 1,
            Next_Attempt__c = System.now().addMinutes(-1)
        );
        Test.startTest();
        new StockRetryJob().execute(null);
        Test.stopTest();
        System.assertEquals('Needs review', [SELECT Status__c FROM Integration_Error__c].Status__c);
    }

    @IsTest
    static void reconciliationFlagsDrift() {
        insert new Stock_Level__c(External_Id__c = 'BIKE-3', Sku__c = 'BIKE-3', Quantity__c = 10);
        StockReconciliationBatch.warehouseCounts = new Map<String, Integer>{ 'BIKE-3' => 8 };
        Test.startTest();
        Database.executeBatch(new StockReconciliationBatch());
        Test.stopTest();
        Integration_Error__c err = [SELECT Error__c FROM Integration_Error__c WHERE Source__c = 'reconciliation'];
        System.assert(err.Error__c.contains('Drift for BIKE-3'));
    }
}
```

Create a small schedulable wrapper so the nightly batch can be scheduled by name:

```apex
public with sharing class StockReconciliationSchedule implements Schedulable {
    public void execute(SchedulableContext ctx) {
        Database.executeBatch(new StockReconciliationBatch(), 200);
    }
}
```

Then schedule everything once from **Anonymous Apex** (Developer Console, **Debug > Open Execute Anonymous Window**). Salesforce cron expressions cannot run more often than hourly in one entry, so the retry job is scheduled four times to run every 15 minutes:

```apex
System.schedule('Stock retry 00', '0 0 * * * ?', new StockRetryJob());
System.schedule('Stock retry 15', '0 15 * * * ?', new StockRetryJob());
System.schedule('Stock retry 30', '0 30 * * * ?', new StockRetryJob());
System.schedule('Stock retry 45', '0 45 * * * ?', new StockRetryJob());
System.schedule('Stock reconciliation', '0 0 2 * * ?', new StockReconciliationSchedule());
```

In production, replace the test-only `warehouseCounts` map with a callout to the warehouse export (see the outbound callouts article). A batch can make callouts only if it also implements `Database.AllowsCallouts`, so add that interface when you do.

## What happens behind the scenes

Salesforce guarantees that an upsert on an External ID finds the existing row or creates one inside one transaction, so two copies of the same message cannot create two rows. The unique index on the External ID enforces this even under parallel requests, and one of the two parallel inserts fails with a duplicate error, which is why retrying is safe.

The stale check reads the stored version and compares it with the incoming one. Two messages can still race, so for high concurrency you may lock the row with `FOR UPDATE` in the query or accept that a later retry will repair it. The scheduler reads due rows by `Next_Attempt__c`, and each failure pushes that time further away, which is exponential-style backoff capped at one hour. Reconciliation is a safety net: it does not assume the messages were reliable, it checks the final state.

A word on **choosing the version**. A sequence number from the warehouse is best because it never goes backwards. A last-modified timestamp in milliseconds also works, but two updates in the same millisecond tie, and your check treats a tie as already applied. If the source offers neither, you cannot detect stale messages reliably, and you should ask the source team to add one before you build the integration.

A word on **what to retry**. A lock error or a timeout is temporary, so the message goes to `Retry`. A validation error means the data itself is wrong, so it goes straight to `Needs review`. Mixing the two fills your retry queue with messages that can never succeed and hides the real problems.

## Test it and verify

1. Deploy the objects, fields and classes, then run `StockReliabilityTest`.
2. In Anonymous Apex run `StockInboxService.process('{"sku":"B1","quantity":5,"version":10}');` twice. Confirm one `Stock_Level__c` row.
3. Process the same SKU with version `5` and quantity `99`. Confirm quantity is still `5`.
4. Process `{"sku":"","quantity":-1}`. Confirm an `Integration_Error__c` row with `Needs review`.
5. Create a retry row by hand with `Next_Attempt__c` in the past and run `new StockRetryJob().execute(null);`. Confirm it becomes `Resolved`.
6. Build a list view of `Integration_Error__c` filtered on `Needs review` so support can work the queue.

## Common mistakes and fixes

- **Using arrival time as order.** Always compare a version from the source.
- **Retrying forever.** Cap attempts and escalate to humans.
- **Retrying bad data.** A malformed message will never succeed, so mark it `Needs review` immediately.
- **Losing the payload.** Without the original message you cannot replay it. Always store it.
- **No reconciliation.** Silent drift is found by customers. Compare on a schedule.
- **Unbounded queues.** Process a fixed number of rows per run to stay inside limits.

## Key takeaways

- Treat every message as possibly duplicated, delayed or reordered.
- Use External IDs for idempotent writes and versions for ordering.
- Keep failed messages with their payload, status and next attempt time.
- Back off between retries and stop after a limit.
- Reconcile on a schedule as the final safety net.

## Where to go next

- Read [Outbound callouts: credentials, retries and testing](/articles/outbound-callouts-advanced/) for the sending side.
- Read [Batch Apex complete guide](/articles/batch-apex-complete-guide/) for the reconciliation pattern.
- Read [Schedulable Apex complete guide](/articles/schedulable-apex-complete-guide/) for scheduling details.
