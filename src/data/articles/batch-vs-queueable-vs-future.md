---
title: "Batch Apex vs Queueable vs Future: Which Async Tool to Use"
description: "Choose between future methods, Queueable and Batch Apex by building one credit-score refresh three ways, with a decision table, limits and tests."
category: salesforce-development
tags: [Batch Apex, Queueable, Apex, Async]
publishedAt: 2026-10-22
updatedAt: 2026-11-13
cover: /images/covers/batch-vs-queueable-vs-future.jpg
sources:
  - title: "Asynchronous Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_async_overview.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "Future Methods (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_invoking_future_methods.htm"
  - title: "Queueable Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_queueables.htm"
  - title: "Using Batch Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_batch.htm"
---

Asynchronous Apex runs outside the user's request. The user clicks Save, the page returns, and your code runs a moment later in a separate transaction with its own, usually higher, limits. Salesforce gives you three main tools for this: **future methods**, **Queueable Apex** and **Batch Apex**. They overlap, which is why people pick the wrong one.

The way to choose is to ask about the *shape of the work*: how many records, whether you need a callout, whether you need to pass objects, and whether you need to track or chain the job. This article answers those questions by implementing the same task three times, then giving you a decision table.

## The business scenario

Northwind Logistics (a fictional freight company) keeps a credit score on each customer Account. The score comes from an external credit-scoring service. The service accepts up to 100 account numbers per request and returns a score for each.

The work arrives in three sizes:

1. **One account edited by a user.** A credit controller changes an Account and expects the score to refresh in seconds.
2. **A data load changes a few thousand accounts.** An integration updates 4,000 Accounts. They all need a fresh score, with no one waiting.
3. **The nightly full refresh.** Every Account with an account number, which may be millions of rows, is rescored.

All three use the same core logic: call the service, then save `Credit_Score__c` and `Credit_Refreshed_At__c` on the Account. We write that logic once in a service class and wrap it in three async entry points.

## Before you start: setup

Use a Developer Edition or scratch org. Menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In Salesforce

1. **Add two fields to Account.** Setup, Object Manager, Account, Fields and Relationships. `Credit_Score__c` (Number, 3 digits, 0 decimals) and `Credit_Refreshed_At__c` (Date/Time). Why: the service writes them. Verify: both fields appear on the Account object. The standard `AccountNumber` field is used as the key sent to the service.
2. **Create a Named Credential** `Credit_Scoring` for the service's base URL, with an External Credential that holds the API key as a custom header. Setup, Named Credentials. Why: Apex calls `callout:Credit_Scoring` and the secret never appears in code. Verify: the record exists, and a permission set grants your user access to the external credential principal. See [REST callouts and Named Credentials](/articles/rest-callouts-named-credentials/).
3. **Create sample Accounts** with account numbers. Run this once in Anonymous Apex:

   ```apex
   // Anonymous Apex
   List<Account> accounts = new List<Account>();
   for (Integer i = 0; i < 250; i++) {
       accounts.add(new Account(
           Name = 'Credit demo ' + i,
           AccountNumber = 'CD-' + String.valueOf(1000 + i)
       ));
   }
   insert accounts;
   ```

   Verify: `SELECT COUNT() FROM Account WHERE AccountNumber LIKE 'CD-%'` returns 250.

### In the external system

1. **Get a sandbox API key** from the scoring service and give it read scope only. Why: least privilege. Verify: a `curl` with the key returns 200.
2. **Expected API shape** used in this article (adapt to your vendor): `POST /scores` with `{"accounts":[{"accountNumber":"CD-1000"}]}` returns `{"scores":[{"accountNumber":"CD-1000","score":712}]}`. Unit tests mock this and never call the service.

### On your machine

Install Salesforce CLI (`sf`). Verify: `sf --version` prints a version.

## How it works

All three tools queue work to run later, in a new transaction, as the user who started it. They differ in what you can pass, what you get back, and how much data they handle.

| | Future | Queueable | Batch |
|---|---|---|---|
| Declared as | `@future` static method | Class implementing `Queueable` | Class implementing `Database.Batchable` |
| Parameters | Primitives and collections of primitives | Any serialisable member variables, including sObjects | Constructor plus a `QueryLocator` or `Iterable` |
| Returns a job Id | No | Yes, from `System.enqueueJob` | Yes, from `Database.executeBatch` |
| Chaining | No | Yes, one child per job | Yes, from `finish` |
| Data volume | Small | Small to medium, by chunks | Large, up to 50 million rows from a `QueryLocator` |
| Callouts | `callout=true` | `Database.AllowsCallouts` | `Database.AllowsCallouts` |

Three terms to know:

- **Transaction.** One unit of work with its own governor limits. Each future call, each Queueable `execute`, and each Batch chunk is its own transaction.
- **Chunk.** In Batch Apex, a slice of the records, called the scope. The default is 200 and the maximum is 2,000.
- **Job queue.** The platform's list of waiting async work. Order is not guaranteed.

### Rules and limits that drive the choice

- A synchronous transaction can start up to 50 future calls and up to 50 Queueable jobs. A transaction already running in an async context can enqueue only one Queueable job.
- A future method cannot call another future method, and cannot be called from a Batch job. Check `System.isFuture()` and `System.isBatch()` before calling one from shared code.
- Batch jobs: at most five queued or active at once, with further jobs waiting in the Flex Queue.
- Async limits are higher than sync limits: 200 SOQL queries instead of 100, 60 seconds of CPU instead of 10, and 12 MB of heap instead of 6 MB. Callouts stay at 100 per transaction.
- Daily cap: the number of async executions per 24 hours (future calls, Queueable jobs, Batch chunks, scheduled jobs) is the greater of 250,000 or 200 times the number of user licenses. Check the current docs for your edition.
- Never do DML before a callout in the same transaction. The platform raises an "uncommitted work pending" error. Do all callouts first, then the DML. The service below follows this rule.

## Basic example

The smallest version of each tool, with a placeholder body, so you can see the shape.

```apex
public class AsyncShapes {

    // 1. Future: static, void, primitives only.
    @future(callout=true)
    public static void viaFuture(Set<Id> accountIds) {
        System.debug('future got ' + accountIds.size() + ' ids');
    }

    // 2. Queueable: an object, so it can hold sObjects and return an Id.
    public class DemoJob implements Queueable {
        private final List<Account> accounts;
        public DemoJob(List<Account> accounts) {
            this.accounts = accounts;
        }
        public void execute(QueueableContext ctx) {
            System.debug('queueable got ' + accounts.size() + ' accounts');
        }
    }

    // 3. Batch: three methods, one transaction per chunk.
    public class DemoBatch implements Database.Batchable<SObject> {
        public Database.QueryLocator start(Database.BatchableContext bc) {
            return Database.getQueryLocator([SELECT Id FROM Account]);
        }
        public void execute(Database.BatchableContext bc, List<Account> scope) {
            System.debug('batch chunk of ' + scope.size());
        }
        public void finish(Database.BatchableContext bc) {
            System.debug('batch finished');
        }
    }
}
```

Start each one:

```apex
// Anonymous Apex
List<Account> some = [SELECT Id FROM Account LIMIT 5];
AsyncShapes.viaFuture(new Map<Id, Account>(some).keySet());
Id queueableId = System.enqueueJob(new AsyncShapes.DemoJob(some));
Id batchId = Database.executeBatch(new AsyncShapes.DemoBatch(), 200);
System.debug('Queueable ' + queueableId + ', batch ' + batchId);
```

Expected result: two job Ids print. Setup, Apex Jobs lists the Queueable and Batch jobs. The future method appears there too, as a `Future` job type. Debug logs for each job show the lines above.

## Advanced end-to-end example

First the shared service. All three wrappers call it, so you can compare them without the business logic getting in the way.

**`force-app/main/default/classes/CreditScoreService.cls`**

```apex
public with sharing class CreditScoreService {

    public static final Integer CALLOUT_CHUNK = 100;
    public class ScoreException extends Exception {}

    // Step 1: callouts only, no DML. One request per chunk of 100.
    public static Map<String, Integer> fetchScores(List<Account> accounts) {
        Map<String, Integer> scores = new Map<String, Integer>();
        for (Integer start = 0; start < accounts.size(); start += CALLOUT_CHUNK) {
            Integer stop = Math.min(start + CALLOUT_CHUNK, accounts.size());
            List<Map<String, String>> items = new List<Map<String, String>>();
            for (Integer i = start; i < stop; i++) {
                if (String.isNotBlank(accounts[i].AccountNumber)) {
                    items.add(new Map<String, String>{
                        'accountNumber' => accounts[i].AccountNumber
                    });
                }
            }
            if (items.isEmpty()) {
                continue;
            }
            scores.putAll(callService(items));
        }
        return scores;
    }

    private static Map<String, Integer> callService(
        List<Map<String, String>> items
    ) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Credit_Scoring/scores');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(30000);
        req.setBody(JSON.serialize(new Map<String, Object>{ 'accounts' => items }));

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new ScoreException('Scoring service returned ' + res.getStatusCode());
        }
        Map<String, Integer> result = new Map<String, Integer>();
        Map<String, Object> parsed =
            (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        for (Object o : (List<Object>) parsed.get('scores')) {
            Map<String, Object> row = (Map<String, Object>) o;
            result.put((String) row.get('accountNumber'), (Integer) row.get('score'));
        }
        return result;
    }

    // Step 2: DML after all callouts. Partial success so one bad row is isolated.
    public static Integer saveScores(
        List<Account> accounts, Map<String, Integer> scores
    ) {
        List<Account> toUpdate = new List<Account>();
        for (Account a : accounts) {
            if (scores.containsKey(a.AccountNumber)) {
                toUpdate.add(new Account(
                    Id = a.Id,
                    Credit_Score__c = scores.get(a.AccountNumber),
                    Credit_Refreshed_At__c = Datetime.now()
                ));
            }
        }
        Integer saved = 0;
        for (Database.SaveResult sr : Database.update(toUpdate, false, AccessLevel.USER_MODE)) {
            if (sr.isSuccess()) {
                saved++;
            }
        }
        return saved;
    }

    // Convenience used by every wrapper: query, call, save.
    public static Integer refreshByIds(Set<Id> accountIds) {
        List<Account> accounts = [
            SELECT Id, AccountNumber FROM Account
            WHERE Id IN :accountIds WITH USER_MODE
        ];
        return refreshAccounts(accounts);
    }

    public static Integer refreshAccounts(List<Account> accounts) {
        return saveScores(accounts, fetchScores(accounts));
    }
}
```

Now the three wrappers.

**`force-app/main/default/classes/CreditRefreshFuture.cls`**

```apex
public with sharing class CreditRefreshFuture {

    // Only primitives or collections of primitives are allowed as parameters.
    // Pass Ids and re-query: the data may have changed by the time this runs.
    @future(callout=true)
    public static void refresh(Set<Id> accountIds) {
        CreditScoreService.refreshByIds(accountIds);
    }
}
```

**`force-app/main/default/classes/CreditRefreshQueueable.cls`**

```apex
public with sharing class CreditRefreshQueueable
    implements Queueable, Database.AllowsCallouts {

    public static final Integer CHUNK = 100;
    private final List<Id> accountIds;

    public CreditRefreshQueueable(List<Id> accountIds) {
        this.accountIds = accountIds;
    }

    // Pure function so tests can check the split without chaining.
    @TestVisible
    private static List<List<Id>> split(List<Id> ids, Integer size) {
        List<List<Id>> parts = new List<List<Id>>();
        for (Integer i = 0; i < ids.size(); i += size) {
            List<Id> part = new List<Id>();
            for (Integer j = i; j < Math.min(i + size, ids.size()); j++) {
                part.add(ids[j]);
            }
            parts.add(part);
        }
        return parts;
    }

    public void execute(QueueableContext ctx) {
        List<List<Id>> parts = split(accountIds, CHUNK);
        if (parts.isEmpty()) {
            return;
        }
        CreditScoreService.refreshByIds(new Set<Id>(parts[0]));

        // Chain the rest: one child job per parent. Apex tests cannot chain
        // queueable jobs, so the guard keeps tests green.
        if (parts.size() > 1 && !Test.isRunningTest()) {
            List<Id> rest = new List<Id>();
            for (Integer i = 1; i < parts.size(); i++) {
                rest.addAll(parts[i]);
            }
            System.enqueueJob(new CreditRefreshQueueable(rest));
        }
    }
}
```

**`force-app/main/default/classes/CreditRefreshBatch.cls`**

```apex
public with sharing class CreditRefreshBatch
    implements Database.Batchable<SObject>, Database.AllowsCallouts, Database.Stateful {

    private Integer saved = 0;
    private Integer seen = 0;

    public Database.QueryLocator start(Database.BatchableContext bc) {
        return Database.getQueryLocator([
            SELECT Id, AccountNumber FROM Account
            WHERE AccountNumber != null
            WITH USER_MODE
        ]);
    }

    // Run with scope 100 so each chunk makes exactly one callout.
    public void execute(Database.BatchableContext bc, List<Account> scope) {
        seen += scope.size();
        saved += CreditScoreService.refreshAccounts(scope);
    }

    public void finish(Database.BatchableContext bc) {
        System.debug('Credit refresh: saved ' + saved + ' of ' + seen);
    }
}
```

The decision logic can live in one dispatcher so callers do not choose by hand.

**`force-app/main/default/classes/CreditRefreshDispatcher.cls`**

```apex
public with sharing class CreditRefreshDispatcher {

    // These thresholds are team policy, not platform limits.
    public static final Integer QUEUEABLE_MAX = 5000;

    public enum Route { NONE, QUEUEABLE, BATCH }

    public static Route choose(Integer count) {
        if (count == 0) {
            return Route.NONE;
        }
        return count <= QUEUEABLE_MAX ? Route.QUEUEABLE : Route.BATCH;
    }

    public static Route refresh(List<Id> accountIds) {
        Route route = choose(accountIds.size());
        if (route == Route.QUEUEABLE) {
            // Allowed from sync code, and from async code once.
            System.enqueueJob(new CreditRefreshQueueable(accountIds));
        } else if (route == Route.BATCH) {
            // Full refresh. The batch re-queries every account itself.
            Database.executeBatch(new CreditRefreshBatch(), 100);
        }
        return route;
    }

    // Legacy callers that must use @future can ask before calling it.
    public static Boolean canCallFuture() {
        return !System.isFuture() && !System.isBatch();
    }
}
```

Here is the mistake the dispatcher prevents:

```apex
public class BadFutureUsage {
    // BAD: a future method inside a loop, one async call per record.
    // 200 records in a trigger means 200 future calls, and the limit is 50.
    public static void onAccountsChanged(List<Account> accounts) {
        for (Account a : accounts) {
            CreditRefreshFuture.refresh(new Set<Id>{ a.Id });
        }
    }
}
```

```apex
public class GoodFutureUsage {
    // GOOD: one call for the whole set, and a guard for async callers.
    public static void onAccountsChanged(List<Account> accounts) {
        if (!CreditRefreshDispatcher.canCallFuture()) {
            return;
        }
        CreditRefreshFuture.refresh(new Map<Id, Account>(accounts).keySet());
    }
}
```

**`force-app/main/default/classes/CreditScoringMock.cls`**

```apex
@IsTest
public class CreditScoringMock implements HttpCalloutMock {

    public static Integer calls = 0;
    private final Integer status;

    public CreditScoringMock(Integer status) {
        this.status = status;
    }

    // Echo back a score for every account number in the request.
    public HttpResponse respond(HttpRequest req) {
        calls++;
        HttpResponse res = new HttpResponse();
        res.setStatusCode(status);
        if (status != 200) {
            res.setBody('{"error":"down"}');
            return res;
        }
        Map<String, Object> body =
            (Map<String, Object>) JSON.deserializeUntyped(req.getBody());
        List<Map<String, Object>> scores = new List<Map<String, Object>>();
        for (Object o : (List<Object>) body.get('accounts')) {
            Map<String, Object> item = (Map<String, Object>) o;
            scores.add(new Map<String, Object>{
                'accountNumber' => item.get('accountNumber'),
                'score' => 700
            });
        }
        res.setBody(JSON.serialize(new Map<String, Object>{ 'scores' => scores }));
        return res;
    }
}
```

**`force-app/main/default/classes/CreditRefreshTests.cls`**

```apex
@IsTest
private class CreditRefreshTests {

    @TestSetup
    static void setup() {
        List<Account> accounts = new List<Account>();
        for (Integer i = 0; i < 200; i++) {
            accounts.add(new Account(
                Name = 'Test ' + i, AccountNumber = 'T-' + (1000 + i)
            ));
        }
        insert accounts;
    }

    private static List<Id> allIds() {
        return new List<Id>(new Map<Id, Account>([SELECT Id FROM Account]).keySet());
    }

    @IsTest
    static void futureRefreshesAll200() {
        CreditScoringMock.calls = 0;
        Test.setMock(HttpCalloutMock.class, new CreditScoringMock(200));
        Test.startTest();
        CreditRefreshFuture.refresh(new Set<Id>(allIds()));
        Test.stopTest();
        System.assertEquals(200,
            [SELECT COUNT() FROM Account WHERE Credit_Score__c = 700]);
        System.assertEquals(2, CreditScoringMock.calls, '200 rows = 2 chunks of 100');
    }

    @IsTest
    static void queueableRefreshesFirstChunk() {
        Test.setMock(HttpCalloutMock.class, new CreditScoringMock(200));
        List<Id> ids = allIds();
        List<Id> firstHundred = new List<Id>();
        for (Integer i = 0; i < 100; i++) {
            firstHundred.add(ids[i]);
        }
        Test.startTest();
        System.enqueueJob(new CreditRefreshQueueable(firstHundred));
        Test.stopTest();
        System.assertEquals(100,
            [SELECT COUNT() FROM Account WHERE Credit_Score__c = 700]);
    }

    @IsTest
    static void queueableSplitsIntoChunks() {
        List<List<Id>> parts = CreditRefreshQueueable.split(allIds(), 100);
        System.assertEquals(2, parts.size());
        System.assertEquals(100, parts[0].size());
        System.assertEquals(100, parts[1].size());
    }

    @IsTest
    static void batchRefreshesEverything() {
        Test.setMock(HttpCalloutMock.class, new CreditScoringMock(200));
        Test.startTest();
        Database.executeBatch(new CreditRefreshBatch(), 100);
        Test.stopTest();
        // A batch in a test runs the first chunk only, so check that chunk.
        System.assertEquals(100,
            [SELECT COUNT() FROM Account WHERE Credit_Score__c = 700]);
    }

    @IsTest
    static void serviceThrowsWhenScoringIsDown() {
        Test.setMock(HttpCalloutMock.class, new CreditScoringMock(503));
        Boolean threw = false;
        Test.startTest();
        try {
            CreditScoreService.refreshByIds(new Set<Id>(allIds()));
        } catch (CreditScoreService.ScoreException e) {
            threw = true;
        }
        Test.stopTest();
        System.assert(threw, 'A 503 must raise ScoreException');
        System.assertEquals(0,
            [SELECT COUNT() FROM Account WHERE Credit_Score__c != null]);
    }

    @IsTest
    static void dispatcherPicksRouteBySize() {
        System.assertEquals(
            CreditRefreshDispatcher.Route.NONE, CreditRefreshDispatcher.choose(0));
        System.assertEquals(
            CreditRefreshDispatcher.Route.QUEUEABLE, CreditRefreshDispatcher.choose(4000));
        System.assertEquals(
            CreditRefreshDispatcher.Route.BATCH, CreditRefreshDispatcher.choose(50000));
    }
}
```

Deploy and run the tests:

```bash
sf project deploy start --source-dir force-app --target-org my-sandbox
sf apex run test --class-names CreditRefreshTests --result-format human \
  --code-coverage --wait 10 --target-org my-sandbox
```

### Decision table

| Question | Answer | Choose |
|---|---|---|
| Fewer than about 5,000 records and you need a job Id, object parameters or chaining? | Yes | Queueable |
| Millions of rows, or a nightly sweep with a progress view? | Yes | Batch |
| Tiny fire-and-forget callout from a trigger, in code that already exists? | Yes | Future (prefer Queueable for new code) |
| Need to run on a schedule? | Yes | Schedulable that starts a Batch or Queueable |
| Need to react to a failure after the fact? | Yes | Queueable with a finalizer, see [Advanced async Apex](/articles/apex-async-advanced-patterns/) |
| Called from a future or a Batch? | Yes | Not future. Queueable, once, or `finish` |

For new code, start with Queueable and move to Batch only when volume demands it. Future methods still work, but have fewer features, and the platform offers nothing that a future method can do that Queueable cannot.

## What happens behind the scenes

1. **Future.** `CreditRefreshFuture.refresh(ids)` serialises the Id set into a queue entry and returns at once. The caller's transaction commits. A worker later runs the method as a new transaction. The caller never gets an Id, so you cannot check status or cancel from Apex. The service makes two callouts for 200 accounts, then one `Database.update`. All callouts finish before the DML, so there is no "uncommitted work pending" error.
2. **Queueable.** `System.enqueueJob` serialises the job object, including the Id list, and returns an `AsyncApexJob` Id. `execute` runs in a new transaction and refreshes the first 100. For larger inputs it enqueues one child. Each link of the chain is a separate transaction with fresh limits, and the child starts only after the parent finishes.
3. **Batch.** `Database.executeBatch` returns an Id. `start` opens the `QueryLocator`. The platform then slices the rows into chunks of 100 and runs `execute` once per chunk, each as its own transaction with its own callout. `finish` runs after the last chunk. `Database.Stateful` keeps the counters between chunks by serialising the batch object after each one. Without it the counters reset every chunk.
4. **Limits used.** For 100 accounts, one sync-style transaction uses about one SOQL query, one callout and one DML statement, a tiny share of the async limits. The binding limit is the callout cap of 100 per transaction. That cap, not heap or CPU, is why the service sends 100 accounts per request and the batch uses scope 100.
5. **In debug logs.** Look for `CODE_UNIT_STARTED` lines with the class name, `CALLOUT_REQUEST` and `CALLOUT_RESPONSE` lines for each chunk, and `DML_BEGIN` after them. In Setup, Apex Jobs, a Batch row shows `Total Batches`, `Batches Processed` and `Failures`.

## Test it and verify

1. Run the unit tests with the command above. Expected: six tests pass.
2. In Anonymous Apex run `Id jobId = System.enqueueJob(new CreditRefreshQueueable(ids))` with 100 Account Ids. Expected: Apex Jobs shows a `Queueable` row that completes, and 100 Accounts have `Credit_Refreshed_At__c` set. Without a live service the job fails with a callout error, which also appears on that row.
3. Run `Database.executeBatch(new CreditRefreshBatch(), 100);`. Expected: a `BatchApex` row, `Batches Processed` counting up.
4. Run `CreditRefreshFuture.refresh(someIds);` and find it under `Future` in Apex Jobs.
5. Open Setup, Debug Logs, add a trace flag for yourself, and repeat step 3 to see one `CALLOUT_REQUEST` per chunk.

## Common mistakes and fixes

- **Symptom: "Too many future calls: 51".** Cause: a future call inside a loop or a trigger processing many chunks. Fix: pass the whole set in one call, or use Queueable.
- **Symptom: "Future method cannot be called from a future or batch method".** Cause: shared code reached from async context. Fix: check `System.isFuture()` and `System.isBatch()`, or use a Queueable.
- **Symptom: "You have uncommitted work pending. Please commit or rollback before calling out".** Cause: DML before a callout in the same transaction. Fix: callouts first, DML last, as in `CreditScoreService`.
- **Symptom: "Too many queueable jobs added to the queue: 2" inside async code.** Cause: enqueuing more than one Queueable from an async transaction. Fix: enqueue one child that carries the rest of the work.
- **Symptom: Batch counters are zero in `finish`.** Cause: the class does not implement `Database.Stateful`. Fix: add it, and keep stateful data small, because it is serialised after every chunk.
- **Symptom: a Queueable test fails with a stack depth error.** Cause: chaining in a test. Fix: guard the chain with `Test.isRunningTest()` and test the split logic as its own function.
- **Symptom: stale data in a future method.** Cause: you passed field values captured earlier. Fix: pass Ids and re-query inside the job.
- **Symptom: a Batch runs slowly or hits the callout limit.** Cause: scope size above the callout chunk. Fix: set scope to the largest size that keeps callouts per chunk under 100.

## Key takeaways

- Choose by the shape of the work: how many records, what you need to pass, and what you need back.
- Default to Queueable for new code. Use Batch for large volumes. Keep future methods for existing code that already uses them.
- Put the business logic in a service class and keep each async tool as a thin wrapper, so you can change the tool without rewriting the logic.
- Do callouts before DML, bulkify the callout, and keep Batch scope aligned with callout limits.
- Test each wrapper with a mock, a bulk of 200 and a failing service.

## Where to go next

- [Future methods complete guide](/articles/future-methods-complete-guide/)
- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)
- [Batch Apex complete guide](/articles/batch-apex-complete-guide/)
- [Advanced async Apex patterns](/articles/apex-async-advanced-patterns/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
