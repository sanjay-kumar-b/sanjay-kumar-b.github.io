---
title: "Calling External APIs from Apex with Named Credentials"
description: "Make REST callouts from Apex without hard-coded secrets: Named Credentials, a typed client, error mapping, delayed retries and mock-based tests."
category: salesforce-development
tags: [Integration, Apex, REST, Named Credentials]
publishedAt: 2026-10-24
updatedAt: 2026-11-14
cover: /images/covers/rest-callouts-named-credentials.jpg
sources:
  - title: "Named Credentials (Salesforce Help)"
    url: "https://help.salesforce.com/s/products/platform"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Never put an API key or password in Apex code, a custom label or a custom setting. Use a **Named Credential**: Salesforce stores the endpoint and the authentication, and your code refers to it by name. That keeps secrets out of source control, lets admins rotate keys without a deployment, and lets you point the same code at a sandbox API in a sandbox and the real API in production.

This article builds a complete integration: a typed client, a service that never calls out inside a trigger, error mapping, a delayed retry, and tests for success, rate limiting and server errors.

## The business scenario

Crestline Lending (a fictional lender) must run an external credit check whenever a new business Account is created. The credit service is a REST API: `POST /v1/checks` with the company's name and tax id returns a score and a decision. The call can take several seconds, sometimes returns `429 Too Many Requests`, and sometimes returns `503`. Sales reps must be able to save the Account instantly; the score appears a few seconds later.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create two custom fields on Account: `Credit_Score__c` (Number, 3, 0) and `Credit_Check_Status__c` (Text, 40). Verify: both show on the Account object in Setup, Object Manager.
3. Create an **External Credential** for the credit service, with an authentication protocol that matches the vendor (for a simple API key use the custom protocol with a header parameter; for OAuth use the matching OAuth protocol). Add a **principal** and its secret value. In Setup, search for Named Credentials and open the External Credentials tab (labels and screens change between releases, so follow the current Salesforce Help).
4. Create a **Named Credential** named `Credit_API` that points at the vendor's base URL and uses that External Credential. Verify: it saves, and the URL has no trailing path beyond the API root.
5. **Grant access to the principal.** Create or edit a permission set and, under External Credential Principal Access, enable the principal; assign that permission set to every user (and the integration user) whose Apex will call the API. This is the step most people forget: without it the callout fails with a permission error even though the credential exists. Verify: assign it to yourself and the anonymous Apex test below returns a response.
6. If your org enforces it, make sure the callout endpoint is allowed (a Named Credential covers this; a Remote Site Setting is only needed for raw URLs).

### In the external system

7. Create an API client or key in the credit vendor's dashboard. Use a sandbox or test key first. Verify: a `curl` call with the key returns `200`.
8. Check the vendor's rate limit and the response codes it uses for "slow down" (often `429`) so the code can treat them as retryable.
9. For practice without a vendor, run the stand-in server in the verify section on a machine Salesforce can reach.

## How it works

`callout:Credit_API/v1/checks` is a special endpoint. The `callout:` prefix tells the platform to look up the Named Credential, resolve the real URL, and add the authentication for you. Your code never sees the secret.

Rules that shape the design:

| Rule | Consequence |
|---|---|
| No callout after uncommitted DML in the same transaction | Do the callout first, or put it in a Queueable with `Database.AllowsCallouts` |
| Callouts are not allowed directly in triggers | Hand off to async Apex |
| 100 callouts per transaction, 120 seconds total time | Set a timeout on every request and batch calls |
| A callout can fail in ways a normal method cannot | Always check the status code and catch `CalloutException` |

## Basic example

A single GET callout with a timeout and a status check. Run it in anonymous Apex after step 5.

```apex
public with sharing class WeatherClient {
    public static String getForecast(String city) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Weather_API/forecast?city=' + EncodingUtil.urlEncode(city, 'UTF-8'));
        req.setMethod('GET');
        req.setTimeout(20000); // milliseconds

        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() == 200) {
            return res.getBody();
        }
        throw new CalloutException('Weather API returned ' + res.getStatusCode());
    }
}
```

```apex
// Anonymous Apex
System.debug(WeatherClient.getForecast('Pune'));
```

Expected: the API's JSON in the debug log. `EncodingUtil.urlEncode` matters: a city name with a space or `&` would otherwise break the URL.

## Advanced end-to-end example

### Metadata for the fields

**`force-app/main/default/objects/Account/fields/Credit_Score__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Credit_Score__c</fullName>
    <externalId>false</externalId>
    <label>Credit Score</label>
    <precision>3</precision>
    <required>false</required>
    <scale>0</scale>
    <trackTrending>false</trackTrending>
    <type>Number</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Credit_Check_Status__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Credit_Check_Status__c</fullName>
    <externalId>false</externalId>
    <label>Credit Check Status</label>
    <length>40</length>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

### Typed models and exception

**`force-app/main/default/classes/CreditCheckModels.cls`**

```apex
public class CreditCheckModels {

    public class Request {
        public String companyName;
        public String taxId;
        public String reference;
    }

    public class Response {
        public String checkId;
        public Integer score;
        public String decision;   // APPROVE, REVIEW, DECLINE
    }
}
```

**`force-app/main/default/classes/CreditApiException.cls`**

```apex
public class CreditApiException extends Exception {
    public Integer statusCode;
    public Boolean retryable;

    public CreditApiException(String message, Integer statusCode, Boolean retryable) {
        this(message);
        this.statusCode = statusCode;
        this.retryable = retryable;
    }
}
```

### The client

**`force-app/main/default/classes/CreditApiClient.cls`**

```apex
public with sharing class CreditApiClient {

    private static final String ENDPOINT = 'callout:Credit_API/v1/checks';

    public CreditCheckModels.Response check(CreditCheckModels.Request body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint(ENDPOINT);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Accept', 'application/json');
        req.setHeader('Idempotency-Key', body.reference);  // safe to repeat on retry
        req.setTimeout(20000);
        req.setBody(JSON.serialize(body));

        HttpResponse res;
        try {
            res = new Http().send(req);
        } catch (CalloutException e) {
            // Network error or timeout: worth retrying.
            throw new CreditApiException('Network error: ' + e.getMessage(), null, true);
        }

        Integer code = res.getStatusCode();
        if (code >= 200 && code < 300) {
            return parse(res.getBody());
        }
        // 429 and 5xx are temporary; 4xx means our request is wrong, so retrying cannot help.
        Boolean retryable = (code == 429 || code >= 500);
        throw new CreditApiException('Credit API returned HTTP ' + code, code, retryable);
    }

    @TestVisible
    private static CreditCheckModels.Response parse(String json) {
        try {
            // Unknown extra fields in the response are ignored by deserialize.
            CreditCheckModels.Response r = (CreditCheckModels.Response) JSON.deserialize(
                json, CreditCheckModels.Response.class
            );
            if (r == null || r.score == null || String.isBlank(r.decision)) {
                throw new CreditApiException('Response missing score or decision', 200, false);
            }
            return r;
        } catch (JSONException e) {
            throw new CreditApiException('Unreadable response: ' + e.getMessage(), 200, false);
        }
    }
}
```

### Service, job and trigger

**`force-app/main/default/classes/CreditCheckJob.cls`**

```apex
public with sharing class CreditCheckJob implements Queueable, Database.AllowsCallouts {

    private static final Integer MAX_ATTEMPTS = 3;

    // Tests replace this to avoid real HTTP when they want a pure unit test.
    @TestVisible
    private static CreditApiClient client = new CreditApiClient();

    private final Id accountId;
    private final Integer attempt;

    public CreditCheckJob(Id accountId, Integer attempt) {
        this.accountId = accountId;
        this.attempt = attempt;
    }

    public void execute(QueueableContext context) {
        Account acc = [
            SELECT Id, Name, AccountNumber FROM Account WHERE Id = :accountId LIMIT 1
        ];

        CreditCheckModels.Request req = new CreditCheckModels.Request();
        req.companyName = acc.Name;
        req.taxId = acc.AccountNumber;
        req.reference = acc.Id;

        try {
            CreditCheckModels.Response res = client.check(req);
            acc.Credit_Score__c = res.score;
            acc.Credit_Check_Status__c = res.decision;
            update acc;
        } catch (CreditApiException e) {
            handleFailure(acc, e);
        }
    }

    private void handleFailure(Account acc, CreditApiException e) {
        if (e.retryable == true && attempt < MAX_ATTEMPTS) {
            // Wait before the next try: minutes, not milliseconds.
            AsyncOptions options = new AsyncOptions();
            options.MinimumQueueableDelayInMinutes = 5 * attempt;
            System.enqueueJob(new CreditCheckJob(acc.Id, attempt + 1), options);
            acc.Credit_Check_Status__c = 'Retrying (' + attempt + ')';
        } else {
            acc.Credit_Check_Status__c = 'Failed: ' + (e.statusCode == null ? 'network' : String.valueOf(e.statusCode));
        }
        update acc;
    }
}
```

**`force-app/main/default/classes/CreditCheckService.cls`**

```apex
public with sharing class CreditCheckService {
    // Called from the trigger: only queues work, never calls out.
    public static void requestChecks(List<Account> accounts) {
        for (Account a : accounts) {
            if (a.AccountNumber != null) {   // only accounts that have a tax id to check
                System.enqueueJob(new CreditCheckJob(a.Id, 1));
            }
        }
    }
}
```

Enqueuing inside a loop costs one `enqueueJob` call per account, and a transaction may enqueue only 50. For bulk loads, queue one job that takes a list of ids. The scenario here is a single-record UI create, so the simple form keeps the example readable; the bulk-safe form is shown next.

**`force-app/main/default/triggers/AccountCreditCheckTrigger.trigger`**

```apex
trigger AccountCreditCheckTrigger on Account (after insert) {
    // Bulk-safe: at most 50 accounts per transaction go to individual jobs;
    // beyond that the nightly batch picks up accounts with no status.
    List<Account> batch = new List<Account>();
    for (Account a : Trigger.new) {
        if (batch.size() < Limits.getLimitQueueableJobs() - Limits.getQueueableJobs()) {
            batch.add(a);
        }
    }
    CreditCheckService.requestChecks(batch);
}
```

### Tests

**`force-app/main/default/classes/CreditApiMock.cls`**

```apex
@IsTest
public class CreditApiMock implements HttpCalloutMock {

    public static Integer calls = 0;
    public static HttpRequest lastRequest;

    private final Integer status;
    private final String body;

    public CreditApiMock(Integer status, String body) {
        this.status = status;
        this.body = body;
    }

    public HttpResponse respond(HttpRequest req) {
        calls++;
        lastRequest = req;
        HttpResponse res = new HttpResponse();
        res.setStatusCode(status);
        res.setHeader('Content-Type', 'application/json');
        res.setBody(body);
        return res;
    }
}
```

**`force-app/main/default/classes/CreditApiClientTest.cls`**

```apex
@IsTest
private class CreditApiClientTest {

    private static CreditCheckModels.Request request() {
        CreditCheckModels.Request r = new CreditCheckModels.Request();
        r.companyName = 'Acme Ltd';
        r.taxId = 'TAX-123';
        r.reference = 'ref-1';
        return r;
    }

    @IsTest
    static void successParsesScoreAndDecision() {
        CreditApiMock.calls = 0;
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200,
            '{"checkId":"c1","score":712,"decision":"APPROVE","unknownField":"ignored"}'));

        CreditCheckModels.Response res = new CreditApiClient().check(request());

        Assert.areEqual(712, res.score, 'Score parsed');
        Assert.areEqual('APPROVE', res.decision, 'Decision parsed');
        Assert.areEqual('callout:Credit_API/v1/checks', CreditApiMock.lastRequest.getEndpoint(), 'Endpoint');
        Assert.areEqual('ref-1', CreditApiMock.lastRequest.getHeader('Idempotency-Key'), 'Idempotency key');
        Assert.isTrue(CreditApiMock.lastRequest.getBody().contains('"companyName":"Acme Ltd"'), 'Body');
    }

    @IsTest
    static void rateLimitIsRetryable() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(429, '{}'));
        try {
            new CreditApiClient().check(request());
            Assert.fail('Expected CreditApiException');
        } catch (CreditApiException e) {
            Assert.areEqual(429, e.statusCode, 'Status code kept');
            Assert.isTrue(e.retryable, '429 should be retried');
        }
    }

    @IsTest
    static void badRequestIsNotRetryable() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(400, '{"error":"bad tax id"}'));
        try {
            new CreditApiClient().check(request());
            Assert.fail('Expected CreditApiException');
        } catch (CreditApiException e) {
            Assert.isFalse(e.retryable, '400 cannot be fixed by retrying');
        }
    }

    @IsTest
    static void malformedJsonIsReportedNotThrownRaw() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200, '{not json'));
        try {
            new CreditApiClient().check(request());
            Assert.fail('Expected CreditApiException');
        } catch (CreditApiException e) {
            Assert.isTrue(e.getMessage().contains('Unreadable'), e.getMessage());
        }
    }

    @IsTest
    static void missingScoreIsRejected() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200, '{"decision":"APPROVE"}'));
        try {
            new CreditApiClient().check(request());
            Assert.fail('Expected CreditApiException');
        } catch (CreditApiException e) {
            Assert.isTrue(e.getMessage().contains('missing'), e.getMessage());
        }
    }
}
```

**`force-app/main/default/classes/CreditCheckJobTest.cls`**

```apex
@IsTest
private class CreditCheckJobTest {

    @IsTest
    static void newAccountGetsAScoreAfterTheJobRuns() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200,
            '{"checkId":"c1","score":640,"decision":"REVIEW"}'));

        Test.startTest();
        insert new Account(Name = 'Scored Co', AccountNumber = 'TAX-9');
        Test.stopTest();   // the Queueable runs here

        Account a = [SELECT Credit_Score__c, Credit_Check_Status__c FROM Account LIMIT 1];
        Assert.areEqual(640, a.Credit_Score__c, 'Score saved');
        Assert.areEqual('REVIEW', a.Credit_Check_Status__c, 'Decision saved');
    }

    @IsTest
    static void accountWithoutTaxIdIsSkipped() {
        CreditApiMock.calls = 0;
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200, '{}'));

        Test.startTest();
        insert new Account(Name = 'No Tax Id Co');
        Test.stopTest();

        Assert.areEqual(0, CreditApiMock.calls, 'No callout without a tax id');
    }

    @IsTest
    static void temporaryFailureSchedulesARetry() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(503, '{}'));

        Test.startTest();
        insert new Account(Name = 'Retry Co', AccountNumber = 'TAX-5');
        Test.stopTest();

        Account a = [SELECT Credit_Check_Status__c FROM Account LIMIT 1];
        Assert.isTrue(a.Credit_Check_Status__c.startsWith('Retrying'), a.Credit_Check_Status__c);
    }

    @IsTest
    static void permanentFailureIsRecordedWithoutRetry() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(400, '{}'));

        Test.startTest();
        insert new Account(Name = 'Bad Co', AccountNumber = 'TAX-7');
        Test.stopTest();

        Account a = [SELECT Credit_Check_Status__c FROM Account LIMIT 1];
        Assert.areEqual('Failed: 400', a.Credit_Check_Status__c, 'Status shows the HTTP code');
    }

    @IsTest
    static void bulkInsertOf60AccountsStaysWithinTheQueueableLimit() {
        Test.setMock(HttpCalloutMock.class, new CreditApiMock(200,
            '{"checkId":"c","score":700,"decision":"APPROVE"}'));
        List<Account> accounts = new List<Account>();
        for (Integer i = 0; i < 60; i++) {
            accounts.add(new Account(Name = 'Bulk ' + i, AccountNumber = 'T' + i));
        }

        Test.startTest();
        insert accounts;     // must not throw "Too many queueable jobs"
        Test.stopTest();

        Assert.areEqual(60, [SELECT COUNT() FROM Account WHERE Name LIKE 'Bulk %'], 'All accounts saved');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --tests CreditApiClientTest --tests CreditCheckJobTest --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

1. The rep saves an Account. The `after insert` trigger collects the new accounts and calls `requestChecks`. The trigger checks how many Queueable slots are left (`Limits.getLimitQueueableJobs() - Limits.getQueueableJobs()`) so that a 200-record import cannot throw "Too many queueable jobs". Accounts beyond the budget are left without a status and are picked up later by a scheduled batch.
2. The transaction commits. The rep's save is finished, with no wait for the external service.
3. The platform runs `CreditCheckJob` in its own transaction. The callout uses `callout:Credit_API`: the platform finds the Named Credential, replaces the prefix with the real base URL, asks the External Credential for the token or header, and adds it to the request. If the running user lacks principal access, the callout fails here.
4. The client sets a 20-second timeout, because the 120-second limit is cumulative for the whole transaction. A timeout surfaces as a `CalloutException`, which the client turns into a retryable `CreditApiException`.
5. The `Idempotency-Key` header holds the Account id, so if the job retries after the first request actually succeeded, the vendor can recognise the repeat.
6. On a retryable failure the job re-enqueues itself with `MinimumQueueableDelayInMinutes` (5 minutes, then 10), instead of hammering the API; after three attempts it records `Failed` and stops. A debug log for the job shows one `CALLOUT_REQUEST` and one `CALLOUT_RESPONSE` per attempt.
7. In tests, `Test.setMock` replaces the HTTP layer for the whole test, and `Test.stopTest()` runs the queued job synchronously.

## Test it and verify

1. Run the two test classes. Expected: 10 tests pass.
2. Run this stand-in credit API on a machine Salesforce can reach (use a tunnel for a scratch org) and point `Credit_API` at it:

```javascript
// credit-mock.js  (node credit-mock.js)
const http = require('http');
let hits = 0;
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    hits += 1;
    console.log(req.method, req.url, req.headers['idempotency-key'], body);
    if (hits % 3 === 0) {              // every third call is rate limited
      res.writeHead(429).end('{}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ checkId: 'c' + hits, score: 600 + hits, decision: 'APPROVE' }));
  });
}).listen(8080, () => console.log('credit mock on :8080'));
```

3. Create an Account with an Account Number. Expected: the mock prints one `POST /v1/checks` line and, a few seconds later, the Account shows a Credit Score and Status `APPROVE`.
4. Create three Accounts in a row. The third call returns `429`; the Account's status shows `Retrying (1)`, and a Queueable appears in Setup, Apex Jobs, with a delayed start.
5. Remove the principal access from your permission set and try again. Expected: the status shows a failure and the debug log shows the permission error, which proves the access step in the setup.

## Common mistakes and fixes

- **Symptom: `You have uncommitted work pending. Please commit or rollback before calling out`.** Cause: DML before the callout in the same transaction. Fix: callout first, or move the callout to a Queueable.
- **Symptom: callout fails for some users only.** Cause: the user's permission set lacks External Credential Principal Access. Fix: grant it to every user or integration user whose Apex calls the API.
- **Symptom: `Callout from triggers are currently not supported`.** Cause: a callout directly in a trigger. Fix: enqueue a job and make the callout there.
- **Symptom: the endpoint includes the secret in the URL.** Cause: a key in the query string. Fix: send it in a header through the External Credential.
- **Symptom: a retry creates a duplicate record at the vendor.** Cause: the first request succeeded but the response was lost. Fix: send an idempotency key and make the vendor dedupe on it.
- **Symptom: the queue fills with retries after an outage.** Cause: immediate retries. Fix: delay retries with `MinimumQueueableDelayInMinutes`, cap the attempts, and mark failures clearly.
- **Symptom: `System.JSONException: Unexpected character`.** Cause: the vendor returned HTML or an error page. Fix: check the status code and content type before parsing, and report a clear error.
- **Symptom: tests fail with "Methods defined as TestMethod do not support Web service callouts".** Cause: no mock registered. Fix: call `Test.setMock` before the code that calls out.
- **Symptom: special characters break the URL.** Cause: unencoded query values. Fix: `EncodingUtil.urlEncode(value, 'UTF-8')`.

## Key takeaways

- Use a Named Credential and External Credential; never hard-code secrets, and grant principal access through permission sets.
- Do callouts in async Apex, never directly in a trigger, and never after uncommitted DML.
- Set a timeout, check the status code, and separate retryable errors (429, 5xx, network) from permanent ones (4xx).
- Deserialize into typed classes and validate the result.
- Retry with a delay and a cap, send an idempotency key, and test every branch with mocks.

## Where to go next

- [Outbound callouts: advanced patterns](/articles/outbound-callouts-advanced/)
- [Integration reliability and idempotency](/articles/integration-reliability-idempotency/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
- [Writing Apex tests that actually catch bugs](/articles/apex-test-classes-best-practices/)
