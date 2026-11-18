---
title: "Outbound Callouts: Named and External Credentials, Retries and Testing"
description: "Call external APIs from Apex safely: credentials model, a reusable client, a tested retry policy, Queueable finalizers and dead-letter records."
category: salesforce-development
tags: [Integration, Apex, REST, Named Credentials, Advanced]
publishedAt: 2026-11-09
updatedAt: 2026-11-14
cover: /images/covers/outbound-callouts-advanced.jpg
sources:
  - title: "Apex Developer Guide: Callouts"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_callouts.htm"
  - title: "Agentforce in Slack custom actions (Named/External Credential example)"
    url: "https://docs.slack.dev/ai/customizing-agentforce-agents-with-custom-slack-actions"
---

This article extends the basic callout article. There you made one call with a Named Credential. Here you build the parts a real integration needs: a reusable client, a retry policy you can unit test, a Queueable job with a **finalizer** that records anything that slipped through, and a dead-letter record humans can act on.

## The business scenario

Lumen Retail (a fictional chain) pushes every Closed Won Opportunity to its ERP as a sales order. The ERP is slow at month end, returns `429` when overloaded, and is restarted every Sunday at 02:00. The integration must retry temporary failures with growing delays, give up on permanent ones, never lose an order silently, and never block the sales rep's save.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create the **External Credential** `ERP_Auth` (how to authenticate, and who the principals are), then the **Named Credential** `ERP_API` (the base URL) that uses it. Setup, Named Credentials, External Credentials tab (screens differ slightly by release; follow current Salesforce Help). Use a different base URL in the sandbox and in production: the code never changes.
3. Choose the principal type. A **Named Principal** shares one identity for every call, which suits system-to-system pushes like this one. A **per-user principal** keeps credentials scoped to each user, which suits cases where the external system must know who is calling.
4. Grant principal access: in a permission set, enable the External Credential Principal for the users or integration user whose Apex makes the call, and assign it. Verify: a test callout in anonymous Apex succeeds for that user.
5. Create a custom object `Integration_Error__c` with text fields `Source__c` and `Error__c`, a long text field `Payload__c`, a number `Attempts__c` and a text `Status__c`. This is the dead-letter store; the full object is defined in the reliability article.
6. Install the Salesforce CLI and log in: `sf org login web --alias dev`.

### In the external system

7. In the ERP, create an API client for Salesforce with permission to create sales orders. Verify: a `curl` request with its credentials returns `201`.
8. Confirm the ERP's rate limit and its duplicate handling. Ask whether it accepts an idempotency key header for `POST /orders`; the code below sends one.
9. For practice, use the stand-in server in the verify section.

## How it works

| Piece | Role |
|---|---|
| External Credential | Authentication protocol and principals |
| Named Credential | Base URL, linked to an External Credential; code uses `callout:<Name>` |
| Permission set | Grants a user access to a principal |
| `ErpClient` | One place that builds requests and classifies responses |
| `RetryPolicy` | Pure logic: should I retry, and how long should I wait |
| `ErpPushJob` | Queueable with `Database.AllowsCallouts`; does the call outside the user's save |
| Finalizer | Runs after the job even if it crashed; last chance to record the failure |

Retry guidance:

| Response | Retry? |
|---|---|
| Timeout, network error, `5xx`, `429` | Yes, with a growing delay and a maximum |
| `400`-level validation errors | No: fix the request |
| `401` or `403` | No automatic retry loop: for OAuth credentials the platform manages token refresh, so a persistent 401 means a configuration problem |

## Basic example

A callout wrapped in one method, with the status classified.

```apex
public with sharing class SimpleErpCall {
    public static Boolean ping() {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ERP_API/health');
        req.setMethod('GET');
        req.setTimeout(10000);
        HttpResponse res = new Http().send(req);
        return res.getStatusCode() == 200;
    }
}
```

```apex
// Anonymous Apex
System.debug('ERP reachable: ' + SimpleErpCall.ping());
```

Expected: `ERP reachable: true`. If you see a permission error, step 4 (principal access) is missing.

## Advanced end-to-end example

### The client

**`force-app/main/default/classes/ErpApiException.cls`**

```apex
public class ErpApiException extends Exception {
    public Integer status;       // null for network errors
    public Boolean retryable;

    public ErpApiException(String message, Integer status, Boolean retryable) {
        this(message);
        this.status = status;
        this.retryable = retryable;
    }
}
```

**`force-app/main/default/classes/ErpClient.cls`**

```apex
public with sharing class ErpClient {

    public static HttpResponse send(String method, String path, String body, String idempotencyKey) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ERP_API' + path);   // never a hard-coded host
        req.setMethod(method);
        req.setHeader('Content-Type', 'application/json');
        if (idempotencyKey != null) {
            req.setHeader('Idempotency-Key', idempotencyKey);
        }
        req.setTimeout(30000);                        // the 120 s limit is per transaction
        if (body != null) {
            req.setBody(body);
        }

        HttpResponse res;
        try {
            res = new Http().send(req);
        } catch (CalloutException e) {
            throw new ErpApiException('Network error: ' + e.getMessage(), null, true);
        }

        Integer s = res.getStatusCode();
        if (s >= 200 && s < 300) {
            return res;
        }
        // Log the status and a request id, never secrets or personal data.
        throw new ErpApiException('HTTP ' + s, s, s == 429 || s >= 500);
    }
}
```

### Retry policy (pure logic, easy to test)

**`force-app/main/default/classes/RetryPolicy.cls`**

```apex
public class RetryPolicy {

    public static final Integer MAX_ATTEMPTS = 4;
    // Minutes to wait before attempt 2, 3, 4: grows quickly so an outage is not hammered.
    private static final List<Integer> BACKOFF_MINUTES = new List<Integer>{ 1, 5, 30 };

    public static Boolean shouldRetry(ErpApiException e, Integer attemptJustFinished) {
        return e.retryable == true && attemptJustFinished < MAX_ATTEMPTS;
    }

    // jitter is passed in (0 to 1) so tests can control it; production passes Math.random().
    public static Integer delayMinutes(Integer attemptJustFinished, Decimal jitter) {
        Integer index = Math.min(attemptJustFinished - 1, BACKOFF_MINUTES.size() - 1);
        Integer base = BACKOFF_MINUTES[index];
        // Add up to 20% random spread so many failed jobs do not retry at the same second.
        Integer extra = (Integer) Math.floor(base * 0.2 * jitter);
        // The platform allows delays of up to 10 minutes on enqueue; larger waits need the scheduler.
        return Math.min(base + extra, 10);
    }
}
```

### Failure recorder (the dead letter)

**`force-app/main/default/classes/FailureRecorder.cls`**

```apex
public with sharing class FailureRecorder {

    public static void record(String source, String payload, String error, Integer attempts) {
        insert new Integration_Error__c(
            Source__c = source,
            Payload__c = payload,
            Error__c = error == null ? null : error.left(255),
            Attempts__c = attempts,
            Status__c = 'Needs review'
        );
    }
}
```

### The job and its finalizer

**`force-app/main/default/classes/ErpOrderPayload.cls`**

```apex
public class ErpOrderPayload {
    public String opportunityId;
    public String customer;
    public Decimal amount;
}
```

**`force-app/main/default/classes/ErpPushJob.cls`**

```apex
public with sharing class ErpPushJob implements Queueable, Database.AllowsCallouts {

    private final List<Id> opportunityIds;
    private final Integer attempt;

    public ErpPushJob(List<Id> opportunityIds, Integer attempt) {
        this.opportunityIds = opportunityIds;
        this.attempt = attempt;
    }

    public void execute(QueueableContext context) {
        // Safety net for anything we do not catch below (limit errors, null pointers).
        System.attachFinalizer(new ErpPushFinalizer(opportunityIds, attempt));

        List<ErpOrderPayload> payload = new List<ErpOrderPayload>();
        for (Opportunity o : [
            SELECT Id, Name, Amount FROM Opportunity WHERE Id IN :opportunityIds WITH USER_MODE
        ]) {
            ErpOrderPayload p = new ErpOrderPayload();
            p.opportunityId = o.Id;
            p.customer = o.Name;
            p.amount = o.Amount;
            payload.add(p);
        }
        if (payload.isEmpty()) {
            return;
        }

        try {
            ErpClient.send('POST', '/orders', JSON.serialize(payload), String.valueOf(opportunityIds[0]));
        } catch (ErpApiException e) {
            if (RetryPolicy.shouldRetry(e, attempt)) {
                AsyncOptions options = new AsyncOptions();
                options.MinimumQueueableDelayInMinutes = RetryPolicy.delayMinutes(attempt, Math.random());
                System.enqueueJob(new ErpPushJob(opportunityIds, attempt + 1), options);
            } else {
                FailureRecorder.record('ErpPushJob', JSON.serialize(payload), e.getMessage(), attempt);
            }
        }
    }
}
```

**`force-app/main/default/classes/ErpPushFinalizer.cls`**

```apex
// Runs after ErpPushJob finishes, whether it succeeded or crashed.
public class ErpPushFinalizer implements Finalizer {

    private final List<Id> opportunityIds;
    private final Integer attempt;

    public ErpPushFinalizer(List<Id> opportunityIds, Integer attempt) {
        this.opportunityIds = opportunityIds;
        this.attempt = attempt;
    }

    public void execute(FinalizerContext context) {
        if (context.getResult() == ParentJobResult.SUCCESS) {
            return;
        }
        // The job crashed with an unhandled exception: keep the evidence.
        Exception ex = context.getException();
        FailureRecorder.record(
            'ErpPushJob (unhandled)',
            JSON.serialize(opportunityIds),
            ex == null ? 'Unknown error' : ex.getTypeName() + ': ' + ex.getMessage(),
            attempt
        );
    }
}
```

**`force-app/main/default/triggers/OpportunityErpTrigger.trigger`**

```apex
trigger OpportunityErpTrigger on Opportunity (after update) {
    List<Id> won = new List<Id>();
    for (Opportunity o : Trigger.new) {
        if (o.IsWon && !Trigger.oldMap.get(o.Id).IsWon) {
            won.add(o.Id);
        }
    }
    if (!won.isEmpty()) {
        System.enqueueJob(new ErpPushJob(won, 1));   // callouts never run in the trigger itself
    }
}
```

### Tests

**`force-app/main/default/classes/SequenceMock.cls`**

```apex
// Returns the configured status codes in order, then repeats the last one.
@IsTest
public class SequenceMock implements HttpCalloutMock {

    public static Integer calls = 0;
    public static HttpRequest lastRequest;
    private final List<Integer> statuses;

    public SequenceMock(List<Integer> statuses) {
        this.statuses = statuses;
        calls = 0;
    }

    public HttpResponse respond(HttpRequest req) {
        lastRequest = req;
        Integer code = statuses[Math.min(calls, statuses.size() - 1)];
        calls++;
        HttpResponse res = new HttpResponse();
        res.setStatusCode(code);
        res.setBody('{}');
        return res;
    }
}
```

**`force-app/main/default/classes/ErpIntegrationTest.cls`**

```apex
@IsTest
private class ErpIntegrationTest {

    // ---- RetryPolicy: pure unit tests, no database, no callouts ----

    @IsTest
    static void backoffGrowsAndIsCappedByThePlatformDelay() {
        Assert.areEqual(1, RetryPolicy.delayMinutes(1, 0), 'First retry waits 1 minute');
        Assert.areEqual(5, RetryPolicy.delayMinutes(2, 0), 'Second retry waits 5 minutes');
        Assert.areEqual(10, RetryPolicy.delayMinutes(3, 0), '30 minutes is capped at 10 on enqueue');
        Assert.isTrue(RetryPolicy.delayMinutes(2, 1) >= 5, 'Jitter only adds time');
    }

    @IsTest
    static void onlyTemporaryErrorsAreRetried() {
        Assert.isTrue(RetryPolicy.shouldRetry(new ErpApiException('x', 503, true), 1), '503 retries');
        Assert.isFalse(RetryPolicy.shouldRetry(new ErpApiException('x', 400, false), 1), '400 does not');
        Assert.isFalse(RetryPolicy.shouldRetry(new ErpApiException('x', 503, true), RetryPolicy.MAX_ATTEMPTS),
            'The last attempt does not retry');
    }

    // ---- Client: classification of responses ----

    @IsTest
    static void clientClassifiesResponses() {
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 201, 429, 400, 500 }));

        HttpResponse ok = ErpClient.send('POST', '/orders', '{}', 'k1');
        Assert.areEqual(201, ok.getStatusCode(), 'Success returned');
        Assert.areEqual('k1', SequenceMock.lastRequest.getHeader('Idempotency-Key'), 'Key sent');

        for (Integer expected : new List<Integer>{ 429, 400, 500 }) {
            try {
                ErpClient.send('POST', '/orders', '{}', null);
                Assert.fail('Expected an exception for ' + expected);
            } catch (ErpApiException e) {
                Assert.areEqual(expected, e.status, 'Status kept');
                Assert.areEqual(expected != 400, e.retryable, 'Retryable only for 429 and 5xx');
            }
        }
    }

    // ---- End to end through the trigger and Queueable ----

    private static Opportunity wonOpportunity() {
        Account a = new Account(Name = 'ERP Test Co');
        insert a;
        Opportunity o = new Opportunity(
            Name = 'Order 1', AccountId = a.Id, Amount = 250,
            StageName = 'Prospecting', CloseDate = Date.today().addDays(5)
        );
        insert o;
        return o;
    }

    @IsTest
    static void closingAnOpportunityPostsOneOrder() {
        Opportunity o = wonOpportunity();
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 201 }));

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.stopTest();

        Assert.areEqual(1, SequenceMock.calls, 'One callout');
        Assert.areEqual(0, [SELECT COUNT() FROM Integration_Error__c], 'No errors recorded');
    }

    @IsTest
    static void permanentFailureLandsInTheDeadLetterStore() {
        Opportunity o = wonOpportunity();
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 400 }));

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.stopTest();

        Integration_Error__c err = [SELECT Source__c, Error__c, Attempts__c, Status__c FROM Integration_Error__c];
        Assert.areEqual('ErpPushJob', err.Source__c, 'Source recorded');
        Assert.areEqual('HTTP 400', err.Error__c, 'Error recorded');
        Assert.areEqual(1, err.Attempts__c, 'No retries for a 400');
        Assert.areEqual('Needs review', err.Status__c, 'A human must look at it');
    }

    @IsTest
    static void temporaryFailureSchedulesADelayedRetryAndNoError() {
        Opportunity o = wonOpportunity();
        Test.setMock(HttpCalloutMock.class, new SequenceMock(new List<Integer>{ 503 }));

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.stopTest();

        Assert.areEqual(0, [SELECT COUNT() FROM Integration_Error__c], 'Not a dead letter yet');
        Assert.isTrue(
            [SELECT COUNT() FROM AsyncApexJob WHERE ApexClass.Name = 'ErpPushJob'] >= 2,
            'The first job and its delayed retry exist'
        );
    }

    @IsTest
    static void failureRecorderTruncatesLongErrors() {
        FailureRecorder.record('test', '{}', 'x'.repeat(400), 2);
        Integration_Error__c err = [SELECT Error__c FROM Integration_Error__c];
        Assert.areEqual(255, err.Error__c.length(), 'Error text fits the field');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names ErpIntegrationTest --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

1. The trigger collects newly won Opportunity ids and enqueues one `ErpPushJob`. Triggers cannot call out, and the callout would also be blocked by the uncommitted DML of the save, so the job runs after the transaction commits.
2. When the job starts, it attaches a finalizer first. The finalizer is the platform's guarantee that some code runs after the job ends, even if the job hit a limit or an unhandled exception that normal `try/catch` cannot catch.
3. `ErpClient.send` resolves `callout:ERP_API`: the platform finds the Named Credential, swaps in the base URL, asks the External Credential for the authentication data, and adds it to the request. The secret never appears in your code or in debug logs.
4. A `503` throws a retryable `ErpApiException`. The job asks `RetryPolicy` for the delay and enqueues a new job with `MinimumQueueableDelayInMinutes`. That is an enqueue delay, not a sleep, so no worker is blocked. A queueable can enqueue only one child job, which is exactly one retry.
5. A `400` is not retryable, so `FailureRecorder` writes a dead-letter row and the job ends normally. The finalizer sees `SUCCESS` and does nothing.
6. If the job crashes instead (say a null pointer), the finalizer sees an unhandled exception and records it. Nothing disappears without a trace.
7. In debug logs you see `CALLOUT_REQUEST` and `CALLOUT_RESPONSE` for each attempt, and a separate log for the finalizer.

## Test it and verify

1. Run the test class. Expected: 7 tests pass.
2. Run this stand-in ERP and expose it to your org with a tunnel; point `ERP_API` at it:

```javascript
// erp-flaky.js  (node erp-flaky.js)
const http = require('http');
let n = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    n += 1;
    console.log(n, req.method, req.url, req.headers['idempotency-key'], body.slice(0, 80));
    const status = n % 3 === 1 ? 503 : 201;   // first call fails, second succeeds, ...
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end('{}');
  });
}).listen(8080, () => console.log('flaky ERP on :8080'));
```

3. Close an Opportunity. Expected: the server prints a first call (503). Setup, Apex Jobs shows a second `ErpPushJob` scheduled about a minute later; when it runs the server prints a second call (201) with the same `Idempotency-Key`.
4. Stop the server and close another Opportunity. After the attempts are used, an `Integration_Error__c` row appears with `Needs review`.

## Common mistakes and fixes

- **Symptom: callouts work for you but fail for the integration user.** Cause: no principal access in the user's permission set. Fix: assign the permission set that enables the External Credential Principal.
- **Symptom: `Callout from triggers are currently not supported`.** Cause: a callout in a trigger. Fix: enqueue a Queueable.
- **Symptom: retries all happen at the same moment after an outage.** Cause: fixed delays. Fix: exponential delays with jitter, as `RetryPolicy` does.
- **Symptom: `Too many queueable jobs added to the queue: 2`.** Cause: a job enqueued two children. Fix: enqueue at most one job from a running Queueable; chain, don't fan out.
- **Symptom: duplicate orders in the ERP after a retry.** Cause: the first request succeeded but the response was lost. Fix: send an idempotency key and let the ERP dedupe, or upsert on an external ID.
- **Symptom: the sandbox pushes orders to the production ERP.** Cause: a hard-coded host. Fix: use the Named Credential only; set a different base URL per environment.
- **Symptom: secrets or customer data in debug logs.** Cause: logging request bodies. Fix: log ids, status codes and durations only.
- **Symptom: orders disappear when a job crashes.** Cause: no finalizer and no dead-letter store. Fix: attach a finalizer and record failures.

## Key takeaways

- External Credential decides how to authenticate; Named Credential decides where to call; a permission set decides who may.
- Wrap callouts in one client that classifies responses as retryable or permanent.
- Keep retry logic in a pure class so it can be unit tested, and retry with a delay, a cap and jitter.
- Use a finalizer and a dead-letter record so failures are never silent.
- From Flow, External Services (an imported OpenAPI spec) exposes the same API as actions that use the same Named Credential.

## Where to go next

- [Calling external APIs with Named Credentials](/articles/rest-callouts-named-credentials/)
- [Reliable integrations: idempotency, retries and ordering](/articles/integration-reliability-idempotency/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
- [Apex async advanced patterns](/articles/apex-async-advanced-patterns/)
