---
title: "Queueable Apex Complete Guide: Chaining, Finalizers and Async Options"
description: "Learn Queueable Apex end to end: enqueueing, callouts, chaining, transaction finalizers, AsyncOptions, retries and testing with an enrichment pipeline."
category: salesforce-development
tags: [Queueable, Apex, Async, Advanced]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/queueable-apex-complete-guide.jpg
sources:
  - title: "Queueable Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_queueing_jobs.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "Using Batch Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_batch.htm"
  - title: "Future Methods (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_invoking_future_methods.htm"
---

Queueable Apex runs a class of yours later, in its own transaction, outside the request that started it. You write a class that implements `Queueable`, pass an instance to `System.enqueueJob`, and get back a job Id. The platform runs `execute` when a worker is free.

It is the modern default for "do this after the save" work. Compared with `@future` methods, a queueable can take rich constructor arguments (lists, maps, your own classes), returns a job Id you can monitor, and can chain a follow-up job. Compared with Batch Apex, it is lighter to start and better for one specific piece of work rather than a sweep over a huge table.

This article starts with a tiny job, then builds an account-enrichment pipeline with external callouts, chunked chaining, retries with delay, duplicate protection and a transaction finalizer that cleans up when the job crashes.

## The business scenario

Lumen Freight (a fictional logistics broker) lets sales reps create accounts with just a website. A third-party firmographic API, "Company Insights" (also fictional), can return the company's industry, headcount and revenue from the web domain. The rules:

1. When an account is inserted with a website, or the website changes, enrich it automatically. Triggers cannot call out, so a queueable does the work.
2. Never enrich 200 accounts in one go. Each callout takes time, so process 20 accounts per job and chain the rest.
3. Network blips and rate limits (HTTP 429 or 5xx) are retried up to three times per account, with a short delay. A 404 means the company is unknown and is final.
4. If a job crashes for any reason, including a limit exception, a finalizer retries the whole set later, and after three crashes marks the accounts as Failed with the message.
5. Saving the same set of accounts twice in a minute must not queue two identical jobs.
6. The API key must never appear in code.

## Before you start: setup

Use a Developer Edition org or scratch org. Labels can differ slightly by release, so use Quick Find in Setup if a menu has moved.

### In the external system

1. **Get API access.** Sign up for the vendor's sandbox (here, the fictional Company Insights) and create an API key. Why: the key goes into Salesforce as a credential, not code. Verify: `curl -H "X-Api-Key: $KEY" "https://api.insightsco.example/v1/companies?domain=example.com"` returns JSON with `name`, `industry`, `employees` and `revenue`.
2. **Learn the contract.** Note the rate limit, the status codes (200 found, 404 unknown, 429 slow down) and the maximum calls per minute. Why: it decides your chunk size and retry delay. Verify: you can write these three numbers down.

### In Salesforce

1. **Create the fields on Account.** Object Manager, Account, Fields & Relationships:

   | Field (API name) | Type |
   |---|---|
   | `Enrichment_Status__c` | Text(20) |
   | `Enrichment_Error__c` | Text(255) |
   | `Enrichment_Attempts__c` | Number(2,0) |
   | `Enriched_On__c` | Date/Time |
   | `Enriched_Industry__c` | Text(80) |
   | `Enriched_Employees__c` | Number(9,0) |
   | `Enriched_Revenue__c` | Currency(16,2) |

   Why: the job writes these. Verify: all seven show on the Account field list.
2. **Create the External Credential.** Setup, Security, Named Credentials, External Credentials tab, New. Name it `Company_Insights_EC`, choose authentication protocol "Custom", add a Principal, and add an authentication parameter named `ApiKey` holding your key. Why: the secret lives in the platform's encrypted store. Verify: the principal shows with its parameter.
3. **Create the Named Credential.** Same page, Named Credentials tab, New. Name `Company_Insights`, URL `https://api.insightsco.example`, select the external credential, and add a custom header `X-Api-Key` with the value `{!$Credential.Company_Insights_EC.ApiKey}`. Why: Apex then calls `callout:Company_Insights/...` and the platform adds the header. It also removes the need for a Remote Site Setting. Verify: the credential saves without errors.
4. **Grant access.** Create or edit a permission set, open External Credential Principal Access, and enable your principal. Assign it to every user whose saves can trigger the job. Why: without it the callout fails with an authorization error. Verify: assign it to yourself and run the anonymous callout in the "Test it and verify" section.
5. **Plan test data.** You will insert accounts with websites. Verify later with `SELECT COUNT() FROM Account WHERE Enrichment_Status__c = 'Enriched'`.

### On your machine

Install the Salesforce CLI, authorize the org with `sf org login web --alias dev`, and use an SFDX project. Verify with `sf org list`.

## How it works

| Term | Meaning |
|---|---|
| Enqueue | `System.enqueueJob(job)` serializes your object and adds it to the async queue. Returns the job Id. |
| Serialization | Member variables are saved with the job. Keep them small and serializable. Mark fields `transient` to skip them. |
| Callouts | A queueable must also implement `Database.AllowsCallouts` to make HTTP callouts. |
| Chaining | `execute` may enqueue one more job. This is how long work is split into steps. |
| Finalizer | A class implementing `Finalizer`, attached inside `execute` with `System.attachFinalizer`. It runs after the job ends, even when `execute` threw an unhandled exception. |
| AsyncOptions | An options object passed as a second argument to `System.enqueueJob`: a minimum delay, a duplicate signature and a maximum stack depth. |

```text
Trigger (sync) ---enqueueJob---> queue
                                   |
                          execute() in own transaction (async limits)
                           |  attachFinalizer(...)
                           |  callouts first, DML last
                           |  enqueueJob(next chunk)  <- chain, one child only
                           v
                    Finalizer.execute(ctx)   always runs: SUCCESS or UNHANDLED_EXCEPTION
```

Useful facts to know (check the Apex Developer Guide for current values):

- A synchronous transaction can enqueue up to 50 jobs. An asynchronous transaction, including a queueable, can enqueue only one child. That is why chains are linear.
- Developer Edition and trial orgs cap the depth of a chain. Production orgs do not have that cap, so always design a chain to end.
- Queueable jobs get the asynchronous limits (for example 200 SOQL queries and 60 seconds of CPU).
- You cannot make a callout after DML in the same transaction without committing, so do callouts first and DML last.

## Basic example

A queueable that stamps contacts after a save.

```apex
public class WelcomeStampJob implements Queueable {
    private final List<Id> contactIds;

    public WelcomeStampJob(List<Id> contactIds) {
        this.contactIds = contactIds;
    }

    public void execute(QueueableContext ctx) {
        List<Contact> contacts = [
            SELECT Id, Description FROM Contact WHERE Id IN :contactIds
        ];
        for (Contact c : contacts) {
            c.Description = 'Welcomed on ' + Date.today().format();
        }
        update contacts;
    }
}
```

Run it and look at the job:

```apex
// Anonymous Apex
List<Contact> some = [SELECT Id FROM Contact LIMIT 5];
List<Id> ids = new List<Id>();
for (Contact c : some) {
    ids.add(c.Id);
}
Id jobId = System.enqueueJob(new WelcomeStampJob(ids));
System.debug('Queued job ' + jobId);
```

Expected result: a job Id prints at once. A few seconds later the contacts have a Description, and `SELECT Status FROM AsyncApexJob WHERE Id = :jobId` shows `Completed`.

A frequent mistake is queueing one job per record:

```apex
public class BadEnqueueExample {
    // BAD: one job per record. A synchronous transaction can enqueue only 50.
    public static void enqueueEach(List<Id> ids) {
        for (Id contactId : ids) {
            System.enqueueJob(new WelcomeStampJob(new List<Id>{ contactId }));
        }
    }

    // FIXED: one job carries the whole list
    public static void enqueueOnce(List<Id> ids) {
        if (!ids.isEmpty()) {
            System.enqueueJob(new WelcomeStampJob(ids));
        }
    }
}
```

## Advanced end-to-end example

**`force-app/main/default/classes/CompanyInsightsClient.cls`**

```apex
/**
 * Thin HTTP client for the Company Insights API. It returns a result object
 * instead of throwing, so the caller can decide which failures are retryable.
 */
public with sharing class CompanyInsightsClient {

    public class Insight {
        public String name;
        public String industry;
        public Integer employees;
        public Decimal revenue;
    }

    public class Result {
        public Boolean success = false;
        public Boolean transientError = false;
        public String message;
        public Insight insight;
    }

    public static Result lookup(String domain) {
        Result res = new Result();
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Company_Insights/v1/companies?domain='
            + EncodingUtil.urlEncode(domain, 'UTF-8'));
        req.setMethod('GET');
        req.setHeader('Accept', 'application/json');
        req.setTimeout(10000);

        try {
            HttpResponse resp = new Http().send(req);
            Integer code = resp.getStatusCode();
            if (code == 200) {
                res.insight = (Insight) JSON.deserialize(resp.getBody(), Insight.class);
                res.success = true;
            } else {
                // 429 and 5xx are worth retrying. 404 and other 4xx are final.
                res.transientError = (code == 429 || code >= 500);
                res.message = 'HTTP ' + code;
            }
        } catch (CalloutException e) {
            res.transientError = true;
            res.message = 'Callout failed: ' + e.getMessage();
        } catch (JSONException e) {
            res.message = 'Bad response body: ' + e.getMessage();
        }
        return res;
    }
}
```

**`force-app/main/default/classes/AccountEnrichmentJob.cls`**

```apex
/**
 * Enriches up to CHUNK_SIZE accounts per run, then chains the rest.
 * Order inside execute: attach finalizer, query, callouts, one DML, chain.
 */
public with sharing class AccountEnrichmentJob implements Queueable, Database.AllowsCallouts {

    public static final Integer CHUNK_SIZE = 20;
    public static final Integer MAX_ATTEMPTS = 3;

    private final List<Id> allIds;
    private final Integer attempt;

    public AccountEnrichmentJob(List<Id> allIds, Integer attempt) {
        this.allIds = allIds;
        this.attempt = attempt;
    }

    /** Single entry point: adds delay and duplicate protection. */
    public static Id enqueue(List<Id> ids, Integer attempt, Integer delayMinutes) {
        if (ids == null || ids.isEmpty()) {
            return null;
        }
        AsyncOptions opts = new AsyncOptions();
        opts.MinimumQueueableDelayInMinutes = delayMinutes;
        opts.DuplicateSignature = new QueueableDuplicateSignature.Builder()
            .addString('AccountEnrichment')
            .addId(ids[0])
            .addInteger(ids.size())
            .addInteger(attempt)
            .build();
        try {
            return System.enqueueJob(new AccountEnrichmentJob(ids, attempt), opts);
        } catch (System.DuplicateMessageException e) {
            // An identical job is already waiting. Nothing to do.
            return null;
        }
    }

    public void execute(QueueableContext ctx) {
        System.attachFinalizer(new AccountEnrichmentFinalizer(allIds, attempt));

        List<Id> chunk = new List<Id>();
        List<Id> remainder = new List<Id>();
        for (Integer i = 0; i < allIds.size(); i++) {
            if (i < CHUNK_SIZE) {
                chunk.add(allIds[i]);
            } else {
                remainder.add(allIds[i]);
            }
        }

        Map<Id, Account> accounts = new Map<Id, Account>([
            SELECT Id, Website, Enrichment_Attempts__c
            FROM Account
            WHERE Id IN :chunk
            WITH USER_MODE
        ]);

        List<Account> updates = new List<Account>();
        List<Id> retry = new List<Id>();

        // Callouts for the whole chunk first. No DML has happened yet.
        for (Id accountId : chunk) {
            Account a = accounts.get(accountId);
            if (a == null) {
                continue;
            }
            Integer tries = (a.Enrichment_Attempts__c == null)
                ? 1 : Integer.valueOf(a.Enrichment_Attempts__c) + 1;
            a.Enrichment_Attempts__c = tries;

            String domain = domainOf(a.Website);
            if (domain == null) {
                markFailed(a, 'No usable website');
            } else {
                CompanyInsightsClient.Result r = CompanyInsightsClient.lookup(domain);
                if (r.success) {
                    a.Enrichment_Status__c = 'Enriched';
                    a.Enrichment_Error__c = null;
                    a.Enriched_On__c = Datetime.now();
                    a.Enriched_Industry__c = r.insight.industry;
                    a.Enriched_Employees__c = r.insight.employees;
                    a.Enriched_Revenue__c = r.insight.revenue;
                } else if (r.transientError && tries < MAX_ATTEMPTS) {
                    a.Enrichment_Status__c = 'Pending';
                    a.Enrichment_Error__c = r.message;
                    retry.add(a.Id);
                } else {
                    markFailed(a, r.message);
                }
            }
            updates.add(a);
        }

        // One DML statement for the chunk. Partial success: one bad row is isolated.
        List<Database.SaveResult> results = Database.update(updates, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Update failed for ' + updates[i].Id
                    + ': ' + results[i].getErrors()[0].getMessage());
            }
        }

        // Chain: remaining work plus transient failures. Only one child is allowed.
        List<Id> next = new List<Id>(remainder);
        next.addAll(retry);
        if (!next.isEmpty() && !Test.isRunningTest()) {
            // Only retries left means we are being rate limited: wait a little
            enqueue(next, attempt, remainder.isEmpty() ? 2 : 0);
        }
    }

    private static void markFailed(Account a, String message) {
        a.Enrichment_Status__c = 'Failed';
        a.Enrichment_Error__c = String.isBlank(message) ? 'Unknown error' : message.abbreviate(255);
    }

    @TestVisible
    private static String domainOf(String website) {
        if (String.isBlank(website)) {
            return null;
        }
        String d = website.trim().toLowerCase();
        d = d.replaceFirst('^[a-z]+://', '');
        d = d.replaceFirst('^www\\.', '');
        Integer slash = d.indexOf('/');
        if (slash >= 0) {
            d = d.substring(0, slash);
        }
        return String.isBlank(d) ? null : d;
    }
}
```

**`force-app/main/default/classes/AccountEnrichmentFinalizer.cls`**

```apex
/**
 * Runs after AccountEnrichmentJob ends, success or not. On an unhandled
 * exception (including a governor limit) it retries, then gives up cleanly.
 */
public with sharing class AccountEnrichmentFinalizer implements Finalizer {

    private final List<Id> ids;
    private final Integer attempt;

    public AccountEnrichmentFinalizer(List<Id> ids, Integer attempt) {
        this.ids = ids;
        this.attempt = attempt;
    }

    public void execute(FinalizerContext ctx) {
        if (ctx.getResult() == ParentJobResult.SUCCESS) {
            return;
        }
        Exception ex = ctx.getException();
        String message = (ex == null) ? 'Unknown failure' : ex.getMessage();
        System.debug(LoggingLevel.ERROR, 'Enrichment job ' + ctx.getAsyncApexJobId()
            + ' crashed (attempt ' + attempt + '): ' + message);

        if (attempt < AccountEnrichmentJob.MAX_ATTEMPTS) {
            AccountEnrichmentJob.enqueue(ids, attempt + 1, 5);
        } else {
            markFailed(ids, message);
        }
    }

    /** Marks every account that was not already enriched as Failed. */
    @TestVisible
    private static void markFailed(List<Id> accountIds, String message) {
        List<Account> toFail = [
            SELECT Id FROM Account
            WHERE Id IN :accountIds
              AND (Enrichment_Status__c = null OR Enrichment_Status__c = 'Pending')
            WITH USER_MODE
        ];
        for (Account a : toFail) {
            a.Enrichment_Status__c = 'Failed';
            a.Enrichment_Error__c = ('Job crashed: ' + message).abbreviate(255);
        }
        Database.update(toFail, false);
    }
}
```

**`force-app/main/default/classes/AccountEnrichmentTriggerHandler.cls`**

```apex
public with sharing class AccountEnrichmentTriggerHandler {

    public static void handle(List<Account> newRecords, Map<Id, Account> oldMap) {
        List<Id> toEnrich = new List<Id>();
        for (Account a : newRecords) {
            if (String.isBlank(a.Website)) {
                continue;
            }
            Boolean isNew = (oldMap == null);
            Boolean websiteChanged = !isNew && a.Website != oldMap.get(a.Id).Website;
            if (isNew || websiteChanged) {
                toEnrich.add(a.Id);
            }
        }
        // One job for the whole trigger batch, however many accounts it holds.
        // The job's own updates do not change Website, so this cannot loop.
        AccountEnrichmentJob.enqueue(toEnrich, 1, 0);
    }
}
```

**`force-app/main/default/triggers/AccountEnrichmentTrigger.trigger`**

```apex
trigger AccountEnrichmentTrigger on Account (after insert, after update) {
    AccountEnrichmentTriggerHandler.handle(Trigger.new, Trigger.oldMap);
}
```

**`force-app/main/default/classes/AccountEnrichmentJobTest.cls`**

```apex
@IsTest
private class AccountEnrichmentJobTest {

    private class InsightsMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setHeader('Content-Type', 'application/json');
            String url = req.getEndpoint();
            if (url.contains('missing.example')) {
                res.setStatusCode(404);
                res.setBody('{}');
            } else if (url.contains('flaky.example')) {
                res.setStatusCode(503);
                res.setBody('{}');
            } else {
                res.setStatusCode(200);
                res.setBody('{"name":"Acme","industry":"Machinery",'
                    + '"employees":250,"revenue":1200000.5}');
            }
            return res;
        }
    }

    private static List<Account> makeAccounts(Integer n, String websiteTemplate) {
        List<Account> accounts = new List<Account>();
        for (Integer i = 0; i < n; i++) {
            accounts.add(new Account(Name = 'Acct ' + i, Website = websiteTemplate));
        }
        return accounts;
    }

    @IsTest
    static void bulkInsertEnrichesOneChunkAndLeavesTheRest() {
        Test.setMock(HttpCalloutMock.class, new InsightsMock());
        Test.startTest();
        insert makeAccounts(200, 'https://www.acme.example/about');
        Test.stopTest();

        // Chaining is disabled in tests, so exactly one chunk was processed
        System.assertEquals(AccountEnrichmentJob.CHUNK_SIZE,
            [SELECT COUNT() FROM Account WHERE Enrichment_Status__c = 'Enriched']);
        System.assertEquals(200 - AccountEnrichmentJob.CHUNK_SIZE,
            [SELECT COUNT() FROM Account WHERE Enrichment_Status__c = null]);
        Account sample = [
            SELECT Enriched_Industry__c, Enriched_Employees__c
            FROM Account WHERE Enrichment_Status__c = 'Enriched' LIMIT 1
        ];
        System.assertEquals('Machinery', sample.Enriched_Industry__c);
        System.assertEquals(250, sample.Enriched_Employees__c);
    }

    @IsTest
    static void unknownCompanyIsMarkedFailedWithoutRetry() {
        Test.setMock(HttpCalloutMock.class, new InsightsMock());
        Test.startTest();
        insert makeAccounts(1, 'missing.example');
        Test.stopTest();

        Account a = [SELECT Enrichment_Status__c, Enrichment_Error__c FROM Account];
        System.assertEquals('Failed', a.Enrichment_Status__c);
        System.assertEquals('HTTP 404', a.Enrichment_Error__c);
    }

    @IsTest
    static void rateLimitedAccountStaysPendingForRetry() {
        Test.setMock(HttpCalloutMock.class, new InsightsMock());
        Test.startTest();
        insert makeAccounts(1, 'flaky.example');
        Test.stopTest();

        Account a = [SELECT Enrichment_Status__c, Enrichment_Attempts__c FROM Account];
        System.assertEquals('Pending', a.Enrichment_Status__c);
        System.assertEquals(1, a.Enrichment_Attempts__c);
    }

    @IsTest
    static void accountWithoutUsableWebsiteFails() {
        Account a = new Account(Name = 'No site');
        insert a;
        Test.setMock(HttpCalloutMock.class, new InsightsMock());
        Test.startTest();
        AccountEnrichmentJob.enqueue(new List<Id>{ a.Id }, 1, 0);
        Test.stopTest();

        System.assertEquals('Failed',
            [SELECT Enrichment_Status__c FROM Account WHERE Id = :a.Id].Enrichment_Status__c);
    }

    @IsTest
    static void domainParsing() {
        System.assertEquals('acme.example',
            AccountEnrichmentJob.domainOf('HTTPS://www.Acme.example/path?x=1'));
        System.assertEquals('acme.example', AccountEnrichmentJob.domainOf('acme.example'));
        System.assertEquals(null, AccountEnrichmentJob.domainOf('   '));
        System.assertEquals(null, AccountEnrichmentJob.domainOf(null));
    }

    @IsTest
    static void finalizerGiveUpPathMarksAccountsFailed() {
        Account pending = new Account(Name = 'P', Enrichment_Status__c = 'Pending');
        Account done = new Account(Name = 'D', Enrichment_Status__c = 'Enriched');
        insert new List<Account>{ pending, done };

        AccountEnrichmentFinalizer.markFailed(new List<Id>{ pending.Id, done.Id }, 'boom');

        System.assertEquals('Failed',
            [SELECT Enrichment_Status__c FROM Account WHERE Id = :pending.Id].Enrichment_Status__c);
        System.assertEquals('Enriched',
            [SELECT Enrichment_Status__c FROM Account WHERE Id = :done.Id].Enrichment_Status__c);
    }
}
```

**`scripts/deploy-and-run.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names AccountEnrichmentJobTest --target-org dev \
  --result-format human --wait 10

# Smoke test: create one account and let the trigger queue the job
cat > /tmp/smoke.apex <<'APEX'
insert new Account(Name = 'Smoke test', Website = 'https://www.example.com');
APEX
sf apex run --file /tmp/smoke.apex --target-org dev
sf data query --query "SELECT Status, JobItemsProcessed FROM AsyncApexJob \
  WHERE ApexClass.Name = 'AccountEnrichmentJob' ORDER BY CreatedDate DESC LIMIT 3" \
  --target-org dev
```

The `AsyncOptions` and `QueueableDuplicateSignature` classes are newer than the basic queueable API. If your org rejects them, check that your org's API version is current in the class meta file and read the Queueable section of the Apex Developer Guide for the exact names.

## What happens behind the scenes

Take a rep who imports 200 accounts with websites.

1. **The insert transaction.** The after-insert trigger collects 200 ids and calls `enqueue` once. That is one `System.enqueueJob` out of the 50 allowed. The job is serialized with its 200-id list and the attempt number. The user's save finishes without waiting for any HTTP call.
2. **Duplicate check.** The signature is built from the first id, the size and the attempt. If the same ids were queued a moment earlier and the job has not started, the platform refuses the second enqueue with a duplicate exception, and our code swallows it.
3. **Job starts.** Seconds later a worker deserializes the job and calls `execute` in a new transaction with async limits. The first line attaches the finalizer. That registration is what protects the rest of the method.
4. **Chunk.** 20 ids are queried. Twenty callouts run one after another. Each goes through the Named Credential, which adds the `X-Api-Key` header, and each counts toward the 100-callout limit for the transaction. The 10-second per-request timeout is far under the overall 120-second callout cap.
5. **One DML.** After the last callout, one `Database.update` writes up to 20 rows. Doing DML first would have caused the "uncommitted work pending" error on the next callout.
6. **Chain.** The remaining 180 ids are enqueued as a child job. Transient failures (503, 429) ride along. If only retries are left, the child waits two minutes through `MinimumQueueableDelayInMinutes`.
7. **Finalizer.** When `execute` returns, the finalizer runs in its own transaction. It sees `SUCCESS` and does nothing. If `execute` had thrown (for instance a `LimitException`, which `catch` cannot handle), the job's own changes roll back, and the finalizer sees `UNHANDLED_EXCEPTION`, then re-enqueues with a five minute delay or, after the third attempt, marks the accounts Failed.

In debug logs look for `CALLOUT_REQUEST` and `CALLOUT_RESPONSE` lines per account, one `DML_BEGIN` with `Rows:20`, and the final `LIMIT_USAGE_FOR_NS` block showing Number of callouts: 20. In Setup, Apex Jobs, you will see a chain of `AccountEnrichmentJob` rows, 10 for 200 accounts (200 divided by 20).

## Test it and verify

1. **Prove the credential works.** In Anonymous Apex:
   ```apex
   // Anonymous Apex
   CompanyInsightsClient.Result r = CompanyInsightsClient.lookup('example.com');
   System.debug(r.success + ' ' + r.message + ' ' + r.insight);
   ```
   Expected: `true null Insight:[...]`. An authorization error means step 4 of the setup (principal access) is missing.
2. **Run the unit tests** with `sf apex run test --class-names AccountEnrichmentJobTest --target-org dev --result-format human --wait 10`. Expected: six passing tests.
3. **Insert 50 accounts through the UI or Data Loader** with websites. Open Setup, Apex Jobs and watch the chain. After a minute, `SELECT COUNT() FROM Account WHERE Enrichment_Status__c = 'Enriched'` should approach 50.
4. **Check a failure.** Create an account with the website `nothing-here.invalid` and confirm the status becomes Failed with `HTTP 404` (or a callout message).
5. **Check duplicate protection.** In one Anonymous Apex block call `AccountEnrichmentJob.enqueue(ids, 1, 0)` twice with the same ids. The second call returns `null`.

## Common mistakes and fixes

1. **"You have uncommitted work pending" on a callout.** Cause: DML before a callout in the same transaction. Fix: callouts first, one DML at the end.
2. **Callout is not allowed from a queueable.** Cause: the class does not implement `Database.AllowsCallouts`. Fix: add it next to `Queueable`.
3. **"Too many queueable jobs added to the queue: 51".** Cause: `System.enqueueJob` inside a loop. Fix: collect ids and enqueue one job.
4. **Chain stops silently or errors in a Developer Edition org.** Cause: chain depth is capped in Developer Edition and trial orgs. Fix: test chain length in a sandbox, and always include a stop condition.
5. **Exception in a chained test.** Cause: queueables cannot chain from inside a test. Fix: guard the chain with `Test.isRunningTest()` and assert what one run did.
6. **Stale data.** The job holds ids, not records, but a constructor that stores full sObjects uses their old field values when it runs later. Fix: pass ids and re-query inside `execute`.
7. **Finalizer never fires.** Cause: `System.attachFinalizer` was called after the risky code, or not at all. Attach it as the first statement in `execute`, and only once.
8. **Retry storms.** Cause: retrying 429s immediately. Fix: use `MinimumQueueableDelayInMinutes` so the external service can recover.
9. **Secrets in code.** Cause: the API key hard coded or in a custom setting. Fix: use the Named Credential and External Credential.

## Key takeaways

- Queueable is the default for one-off async work. It accepts rich data, returns a Id and can chain.
- Add `Database.AllowsCallouts` for HTTP, and always order work as callouts first, DML last.
- Chain in small chunks. One child per execution, so the chain is a loop with a stop condition.
- Attach a Finalizer first thing in `execute` to catch crashes that `try/catch` cannot, such as limit exceptions.
- Use delays for retries and duplicate signatures to avoid piling up identical jobs. Confirm the exact API in the current Apex Developer Guide.
- Keep entry points bulk safe: one job per trigger batch, not one per record.

## Where to go next

- [Future methods complete guide](/articles/future-methods-complete-guide/)
- [Batch Apex complete guide](/articles/batch-apex-complete-guide/)
- [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/)
- [Apex async advanced patterns](/articles/apex-async-advanced-patterns/)
- [REST callouts with Named Credentials](/articles/rest-callouts-named-credentials/)
- [Integration reliability and idempotency](/articles/integration-reliability-idempotency/)
