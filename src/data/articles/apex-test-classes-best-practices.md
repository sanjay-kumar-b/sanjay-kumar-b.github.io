---
title: "Writing Apex Tests That Actually Catch Bugs"
description: "Go beyond 75% coverage: data factories, bulk tests, callout mocks, the Stub API, permission tests and limit checks, built on a real case-escalation flow."
category: salesforce-development
tags: [Apex, Testing, Mocking]
publishedAt: 2026-10-23
updatedAt: 2026-11-14
cover: /images/covers/apex-test-classes-best-practices.jpg
sources:
  - title: "Testing Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_testing.htm"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

To deploy Apex to production, Salesforce requires at least **75% overall code coverage** and every test that runs must pass. Coverage is a floor, not a goal. A test with no assertions can reach 100% and prove nothing. A good test fails when the behavior breaks.

This article builds one realistic feature and then tests it properly: a data factory, unit tests that never touch the database, a 200-record bulk test with a limit check, mocks for an HTTP callout, a hand-made stub for a dependency, and a test that proves a user without access is blocked. You can reuse each pattern in any project.

## The business scenario

Northwind Support (a fictional software company) has a rule: when a new Case is created for a customer whose Account has Rating `Hot`, the Case must be set to Priority `High` and Status `Escalated`, and the on-call engineer must be paged through an external paging service. Paging is a callout, so it must happen asynchronously after the Case is saved.

The pieces under test:

- A **before insert** trigger step that changes Priority and Status (pure logic plus one query).
- An **after insert** step that hands the escalated Case ids to a Queueable job.
- A **Queueable job** that makes the HTTP callout.
- A **gateway interface** so the callout can be replaced in tests.

## Before you start: setup

### In Salesforce

1. Use a scratch org or a Developer sandbox. Never develop tests in production. Verify: `sf org list` shows the org and its alias.
2. Make sure Cases are enabled and the standard Case fields `Priority` (values include High, Medium, Low) and `Status` (value `Escalated` exists in the default Case status list) are available. Verify: create a Case in the UI and open the Status picklist.
3. Create a Named Credential called `Pager_API` pointing at the paging service. The Apex below calls `callout:Pager_API/v1/pages`, so the name must match exactly. In Setup, search for Named Credentials and add the External Credential and principal your org requires (labels can differ slightly by release; follow the Named Credentials page in the Salesforce help). Verify: the Named Credential saves without errors. You do not need it for the unit tests, because tests use mocks, but you need it for the manual test at the end.
4. Make sure the profile `Minimum Access - Salesforce` exists. The permission test uses it to create a user with no object access. Verify: Setup, Profiles, find the name. If your org does not have it, create a clone of a minimal profile and change the name in the test.
5. Install the Salesforce CLI (`sf`) and log in: `sf org login web --alias dev`.

### In the external system

6. The paging service needs one endpoint that accepts `POST /v1/pages` with a JSON array and answers `202 Accepted`. For local practice you can run the tiny Node server shown in the verify section. It stands in for the real service so you can see the callout leave Salesforce.
7. Decide how the service authenticates (API key or OAuth) and put that secret into the External Credential, never into code.

## How it works

Apex tests are ordinary Apex classes marked `@IsTest`. When tests run, the platform follows these rules:

| Rule | What it means for you |
|---|---|
| Each test method runs in its own transaction | All DML is rolled back at the end; tests cannot leave data behind |
| Org data is hidden by default | Create all data in the test (unless you use `@SeeAllData=true`, which you should avoid) |
| `@TestSetup` runs once per class | Records it inserts are restored fresh for every test method |
| `Test.startTest()` and `Test.stopTest()` | Code between them gets its own fresh set of governor limits, and queued async work runs at `stopTest()` |
| Real HTTP callouts are blocked | Register a mock with `Test.setMock` |
| Setup and non-setup DML cannot mix | Inserting a User and an Account in one transaction fails with `MIXED_DML_OPERATION` unless you wrap the setup part in `System.runAs` |

The three kinds of test you will write:

- **Unit tests** call a method with in-memory objects and assert on the result. They are fast and need no database.
- **Integration tests** insert real records so triggers and the Queueable run. They use a mock for the callout.
- **Security tests** run the code as a specific user with `System.runAs` and prove access rules hold.

The assertion class `Assert` (`Assert.areEqual`, `Assert.isTrue`, `Assert.fail` and others) is the current way to assert; `System.assertEquals` still works.

## Basic example

A minimal but real test. It needs no database and no setup. It checks one rule: a Case for a hot account is escalated, and a Case for a cold account is untouched.

The class under test (shortened to the one method used here, the full version comes later):

**`force-app/main/default/classes/PriorityRule.cls`**

```apex
public with sharing class PriorityRule {
    public static final String HIGH = 'High';
    public static final String ESCALATED = 'Escalated';

    // Returns true when the case was changed.
    public static Boolean apply(Case c, String accountRating) {
        if (accountRating != 'Hot' || c.Priority == HIGH) {
            return false;
        }
        c.Priority = HIGH;
        c.Status = ESCALATED;
        return true;
    }
}
```

**`force-app/main/default/classes/PriorityRuleTest.cls`**

```apex
@IsTest
private class PriorityRuleTest {

    @IsTest
    static void hotAccountEscalatesTheCase() {
        Case c = new Case(Subject = 'Login fails', Priority = 'Low');

        Boolean changed = PriorityRule.apply(c, 'Hot');

        Assert.isTrue(changed, 'A hot account should change the case');
        Assert.areEqual('High', c.Priority, 'Priority should be High');
        Assert.areEqual('Escalated', c.Status, 'Status should be Escalated');
    }

    @IsTest
    static void coldAccountLeavesTheCaseAlone() {
        Case c = new Case(Subject = 'Billing question', Priority = 'Low');

        Boolean changed = PriorityRule.apply(c, 'Cold');

        Assert.isFalse(changed, 'A cold account should not change the case');
        Assert.areEqual('Low', c.Priority, 'Priority should stay Low');
        Assert.isNull(c.Status, 'Status should not be set by the rule');
    }
}
```

Run it from the project folder:

```bash
sf apex run test --class-names PriorityRuleTest --result-format human --code-coverage --wait 10 --target-org dev
```

Expected result: 2 tests passed, `PriorityRule` covered 100%. Notice the test passes even if nobody inserts a record. Logic that depends on no database should be tested without one.

## Advanced end-to-end example

Now the full feature with its tests. File paths are relative to your SFDX project.

### The code under test

**`force-app/main/default/classes/PageRequest.cls`**

```apex
// The JSON body sent to the paging service (one object per case).
public class PageRequest {
    public String caseNumber;
    public String subject;
    public String severity;

    public PageRequest(String caseNumber, String subject, String severity) {
        this.caseNumber = caseNumber;
        this.subject = subject;
        this.severity = severity;
    }
}
```

**`force-app/main/default/classes/PagerException.cls`**

```apex
// Thrown when the paging service reports a temporary failure (HTTP 5xx).
public class PagerException extends Exception {
}
```

**`force-app/main/default/classes/PagerGateway.cls`**

```apex
// The seam between our logic and the outside world.
// Production uses PagerClient; tests swap in a stub or a callout mock.
public interface PagerGateway {
    Boolean sendPages(List<PageRequest> requests);
}
```

**`force-app/main/default/classes/PagerClient.cls`**

```apex
public with sharing class PagerClient implements PagerGateway {

    // Returns true when the service accepted the pages, false when it rejected them
    // (a 4xx response will not succeed on retry). Throws on 5xx so callers can retry.
    public Boolean sendPages(List<PageRequest> requests) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Pager_API/v1/pages');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(20000);
        req.setBody(JSON.serialize(requests));

        HttpResponse res = new Http().send(req);
        Integer status = res.getStatusCode();

        if (status >= 200 && status < 300) {
            return true;
        }
        if (status >= 500) {
            throw new PagerException('Pager service unavailable: HTTP ' + status);
        }
        return false;
    }
}
```

**`force-app/main/default/classes/CaseEscalationService.cls`**

```apex
public with sharing class CaseEscalationService {

    // Tests replace this with a stub. Production keeps the real client.
    @TestVisible
    private static PagerGateway gateway = new PagerClient();

    // Before insert: escalate cases that belong to hot accounts.
    public static void prioritise(List<Case> cases) {
        if (cases == null || cases.isEmpty()) {
            return;
        }

        Set<Id> accountIds = new Set<Id>();
        for (Case c : cases) {
            if (c.AccountId != null) {
                accountIds.add(c.AccountId);
            }
        }
        if (accountIds.isEmpty()) {
            return;
        }

        // One query for the whole batch, in user mode so FLS and sharing are respected.
        Map<Id, Account> accounts = new Map<Id, Account>(
            [SELECT Id, Rating FROM Account WHERE Id IN :accountIds WITH USER_MODE]
        );

        for (Case c : cases) {
            Account a = accounts.get(c.AccountId);
            if (a != null) {
                PriorityRule.apply(c, a.Rating);
            }
        }
    }

    // After insert: hand escalated cases to the async job (no callouts in triggers).
    public static void pageEscalated(List<Case> cases) {
        Set<Id> ids = new Set<Id>();
        for (Case c : cases) {
            if (c.Priority == PriorityRule.HIGH && c.Status == PriorityRule.ESCALATED) {
                ids.add(c.Id);
            }
        }
        if (!ids.isEmpty()) {
            System.enqueueJob(new CaseEscalationJob(ids));
        }
    }

    public static Boolean deliver(List<PageRequest> requests) {
        return gateway.sendPages(requests);
    }
}
```

**`force-app/main/default/classes/CaseEscalationJob.cls`**

```apex
public with sharing class CaseEscalationJob implements Queueable, Database.AllowsCallouts {

    private final Set<Id> caseIds;

    public CaseEscalationJob(Set<Id> caseIds) {
        this.caseIds = caseIds;
    }

    public void execute(QueueableContext context) {
        List<PageRequest> requests = new List<PageRequest>();
        for (Case c : [
            SELECT CaseNumber, Subject, Priority
            FROM Case
            WHERE Id IN :caseIds
            WITH USER_MODE
        ]) {
            requests.add(new PageRequest(c.CaseNumber, c.Subject, c.Priority));
        }
        if (!requests.isEmpty()) {
            CaseEscalationService.deliver(requests);
        }
    }
}
```

**`force-app/main/default/triggers/CaseEscalationTrigger.trigger`**

```apex
trigger CaseEscalationTrigger on Case (before insert, after insert) {
    if (Trigger.isBefore) {
        CaseEscalationService.prioritise(Trigger.new);
    } else {
        CaseEscalationService.pageEscalated(Trigger.new);
    }
}
```

### Test helpers

Helpers are marked `@IsTest` so they do not count against your org's code size, but they are `public` so other test classes can use them.

**`force-app/main/default/classes/TestDataFactory.cls`**

```apex
@IsTest
public with sharing class TestDataFactory {

    // Inserted accounts, so tests can rely on real Ids.
    public static List<Account> accounts(Integer count, String rating) {
        List<Account> result = new List<Account>();
        for (Integer i = 0; i < count; i++) {
            result.add(new Account(Name = 'Test Account ' + i, Rating = rating));
        }
        insert result;
        return result;
    }

    // Built but NOT inserted: the test decides when DML happens,
    // so it can wrap the insert in Test.startTest/stopTest.
    public static List<Case> cases(Id accountId, Integer count) {
        List<Case> result = new List<Case>();
        for (Integer i = 0; i < count; i++) {
            result.add(new Case(
                AccountId = accountId,
                Subject = 'Test case ' + i,
                Priority = 'Low',
                Origin = 'Web'
            ));
        }
        return result;
    }

    // A user with a given profile. Inserting a User is "setup" DML, so run it
    // inside System.runAs to avoid MIXED_DML_OPERATION with regular records.
    public static User user(String profileName) {
        Profile p = [SELECT Id FROM Profile WHERE Name = :profileName LIMIT 1];
        String unique = String.valueOf(System.currentTimeMillis());
        User u = new User(
            Alias = 'tst' + unique.right(4),
            Email = 'tester' + unique + '@example.test',
            EmailEncodingKey = 'UTF-8',
            LastName = 'Tester',
            LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US',
            ProfileId = p.Id,
            TimeZoneSidKey = 'America/Los_Angeles',
            Username = 'tester' + unique + '@example.test'
        );
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert u;
        }
        return u;
    }
}
```

### Test doubles: a callout mock and a stub

**`force-app/main/default/classes/PagerCalloutMock.cls`**

```apex
// Fakes the paging service at the HTTP level. Used with Test.setMock.
@IsTest
public class PagerCalloutMock implements HttpCalloutMock {

    public static Integer calls = 0;
    public static HttpRequest lastRequest;

    private final Integer statusCode;

    public PagerCalloutMock(Integer statusCode) {
        this.statusCode = statusCode;
    }

    public HttpResponse respond(HttpRequest req) {
        calls++;
        lastRequest = req;
        HttpResponse res = new HttpResponse();
        res.setStatusCode(statusCode);
        res.setHeader('Content-Type', 'application/json');
        res.setBody('{"accepted": true}');
        return res;
    }
}
```

**`force-app/main/default/classes/PagerGatewayStub.cls`**

```apex
// Fakes the PagerGateway interface with the Stub API: records every call.
@IsTest
public class PagerGatewayStub implements System.StubProvider {

    public List<List<PageRequest>> received = new List<List<PageRequest>>();

    public Object handleMethodCall(
        Object stubbedObject,
        String stubbedMethodName,
        Type returnType,
        List<Type> listOfParamTypes,
        List<String> listOfParamNames,
        List<Object> listOfArgs
    ) {
        if (stubbedMethodName == 'sendPages') {
            received.add((List<PageRequest>) listOfArgs[0]);
            return true;
        }
        return null;
    }

    public PagerGateway asGateway() {
        return (PagerGateway) Test.createStub(PagerGateway.class, this);
    }
}
```

### The tests

**`force-app/main/default/classes/CaseEscalationServiceTest.cls`**

```apex
@IsTest
private class CaseEscalationServiceTest {

    @TestSetup
    static void setup() {
        // Runs once; every test method starts with these two accounts.
        insert new List<Account>{
            new Account(Name = 'Hot Customer', Rating = 'Hot'),
            new Account(Name = 'Cold Customer', Rating = 'Cold')
        };
    }

    private static Account byName(String name) {
        return [SELECT Id FROM Account WHERE Name = :name LIMIT 1];
    }

    // ---- Unit tests: in-memory cases, one query for accounts ----

    @IsTest
    static void prioritiseEscalatesOnlyHotAccountCases() {
        Case hot = new Case(AccountId = byName('Hot Customer').Id, Priority = 'Low');
        Case cold = new Case(AccountId = byName('Cold Customer').Id, Priority = 'Low');
        Case noAccount = new Case(Priority = 'Low');

        CaseEscalationService.prioritise(new List<Case>{ hot, cold, noAccount });

        Assert.areEqual('High', hot.Priority, 'Hot account case is escalated');
        Assert.areEqual('Escalated', hot.Status, 'Hot account case status');
        Assert.areEqual('Low', cold.Priority, 'Cold account case is unchanged');
        Assert.areEqual('Low', noAccount.Priority, 'Case without account is unchanged');
    }

    @IsTest
    static void prioritiseIgnoresNullAndEmptyLists() {
        CaseEscalationService.prioritise(null);
        CaseEscalationService.prioritise(new List<Case>());
        Assert.isTrue(true, 'No exception for null or empty input');
    }

    // ---- Integration test: real trigger, real Queueable, stubbed gateway ----

    @IsTest
    static void insertingCasesPagesOncePerBatch() {
        PagerGatewayStub stub = new PagerGatewayStub();
        CaseEscalationService.gateway = stub.asGateway();

        List<Case> cases = TestDataFactory.cases(byName('Hot Customer').Id, 3);

        Test.startTest();
        insert cases;
        Test.stopTest(); // the Queueable runs here

        Assert.areEqual(1, stub.received.size(), 'One gateway call for the whole batch');
        Assert.areEqual(3, stub.received[0].size(), 'All three cases were paged');
        Assert.areEqual('High', stub.received[0][0].severity, 'Severity sent to the pager');
    }

    @IsTest
    static void coldAccountCasesAreNeverPaged() {
        PagerGatewayStub stub = new PagerGatewayStub();
        CaseEscalationService.gateway = stub.asGateway();

        Test.startTest();
        insert TestDataFactory.cases(byName('Cold Customer').Id, 5);
        Test.stopTest();

        Assert.areEqual(0, stub.received.size(), 'No page for cold accounts');
    }

    // ---- Bulk test: 200 records, plus a limits check ----

    @IsTest
    static void bulkInsertOf200CasesStaysWithinLimits() {
        PagerGatewayStub stub = new PagerGatewayStub();
        CaseEscalationService.gateway = stub.asGateway();
        List<Case> cases = TestDataFactory.cases(byName('Hot Customer').Id, 200);

        Integer queriesBefore = Limits.getQueries();
        Test.startTest();
        insert cases;
        Integer queriesUsed = Limits.getQueries() - queriesBefore;
        Test.stopTest();

        // The trigger needs one account query. Allow a little room for other automation.
        Assert.isTrue(queriesUsed <= 5, 'Too many queries for 200 cases: ' + queriesUsed);
        Assert.areEqual(
            200,
            [SELECT COUNT() FROM Case WHERE Priority = 'High' AND Status = 'Escalated'],
            'All 200 cases should be escalated'
        );
        Assert.areEqual(200, stub.received[0].size(), 'All 200 cases paged in one call');
    }

    // ---- Security test: a user with no access cannot read accounts ----

    @IsTest
    static void userWithoutAccountAccessIsBlocked() {
        User noAccess = TestDataFactory.user('Minimum Access - Salesforce');
        Case c = new Case(AccountId = byName('Hot Customer').Id, Priority = 'Low');

        Boolean blocked = false;
        System.runAs(noAccess) {
            try {
                CaseEscalationService.prioritise(new List<Case>{ c });
            } catch (QueryException e) {
                blocked = true;
            }
        }

        Assert.isTrue(blocked, 'USER_MODE query must fail for a user without Account access');
        Assert.areEqual('Low', c.Priority, 'The case must not be escalated');
    }
}
```

**`force-app/main/default/classes/PagerClientTest.cls`**

```apex
@IsTest
private class PagerClientTest {

    private static List<PageRequest> oneRequest() {
        return new List<PageRequest>{ new PageRequest('00001001', 'Login fails', 'High') };
    }

    @IsTest
    static void acceptedResponseReturnsTrue() {
        PagerCalloutMock.calls = 0;
        Test.setMock(HttpCalloutMock.class, new PagerCalloutMock(202));

        Test.startTest();
        Boolean ok = new PagerClient().sendPages(oneRequest());
        Test.stopTest();

        Assert.isTrue(ok, '202 means accepted');
        Assert.areEqual(1, PagerCalloutMock.calls, 'Exactly one callout');
        Assert.areEqual('POST', PagerCalloutMock.lastRequest.getMethod(), 'HTTP method');
        Assert.areEqual(
            'callout:Pager_API/v1/pages',
            PagerCalloutMock.lastRequest.getEndpoint(),
            'Named credential endpoint'
        );
        Assert.isTrue(
            PagerCalloutMock.lastRequest.getBody().contains('"caseNumber":"00001001"'),
            'JSON body carries the case number'
        );
    }

    @IsTest
    static void clientErrorReturnsFalse() {
        Test.setMock(HttpCalloutMock.class, new PagerCalloutMock(400));
        Assert.isFalse(new PagerClient().sendPages(oneRequest()), '400 is a permanent failure');
    }

    @IsTest
    static void serverErrorThrowsSoCallersCanRetry() {
        Test.setMock(HttpCalloutMock.class, new PagerCalloutMock(503));
        try {
            new PagerClient().sendPages(oneRequest());
            Assert.fail('A 503 must throw PagerException');
        } catch (PagerException e) {
            Assert.isTrue(e.getMessage().contains('503'), 'Message names the status');
        }
    }
}
```

**`force-app/main/default/classes/CaseEscalationEndToEndTest.cls`**

```apex
// No stub here: the real PagerClient runs, with only the HTTP layer mocked.
@IsTest
private class CaseEscalationEndToEndTest {

    @IsTest
    static void hotCaseTriggersOneCalloutToThePager() {
        Account hot = new Account(Name = 'Hot Customer', Rating = 'Hot');
        insert hot;
        PagerCalloutMock.calls = 0;
        Test.setMock(HttpCalloutMock.class, new PagerCalloutMock(202));

        Test.startTest();
        insert new Case(AccountId = hot.Id, Subject = 'Outage', Priority = 'Low', Origin = 'Phone');
        Test.stopTest();

        Assert.areEqual(1, PagerCalloutMock.calls, 'The Queueable should call the pager once');
        Assert.isTrue(
            PagerCalloutMock.lastRequest.getBody().contains('"severity":"High"'),
            'The page carries the escalated severity'
        );
    }
}
```

### Run everything

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test \
  --tests CaseEscalationServiceTest \
  --tests PagerClientTest \
  --tests CaseEscalationEndToEndTest \
  --tests PriorityRuleTest \
  --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

Follow `insertingCasesPagesOncePerBatch` through the platform:

1. The test method starts a transaction. `@TestSetup` data is already restored, so both accounts exist.
2. `CaseEscalationService.gateway = stub.asGateway()` sets a static variable. The variable lives for this test's transaction, which is why every test must set its own double.
3. `Test.startTest()` resets governor limits. Everything between `startTest` and `stopTest` counts as the code under test; the data you built before it does not eat into that budget.
4. `insert cases` fires the trigger. The before-insert step runs one SOQL query for the three Cases' accounts and rewrites Priority and Status in memory. The after-insert step enqueues the Queueable. In a test the job does not run yet; the platform holds it.
5. `Test.stopTest()` makes the platform run all queued async jobs synchronously, right there. The job queries the Cases and calls `deliver`, which uses the stub instead of the network. A callout inside a test with no mock registered would throw an error, which is the platform's way of stopping tests from reaching real systems.
6. After `stopTest`, the assertions read the stub's recorded calls. At the end of the method the whole transaction is rolled back, so the Cases and accounts disappear.

Limits used in the bulk test: the 200 Cases are processed in one trigger invocation (the platform hands triggers up to 200 records at a time), so the trigger uses a single SOQL query regardless of record count. That is exactly what the `queriesUsed <= 5` assertion defends. If someone later adds a query inside a `for` loop, 200 Cases would use 200 queries, the test would fail, and the bug would never reach production. In a debug log for this test you would see `CODE_UNIT_STARTED` for the trigger, one `SOQL_EXECUTE_BEGIN`, and later a separate unit for the Queueable.

A `System.runAs` block switches the running user's permissions and sharing but not the time or limits. It does not enforce login hours or IP ranges.

## Test it and verify

1. Deploy and run the commands above. Expected: all tests pass, and each class shows coverage. Use `--code-coverage` to see the percentage per class.
2. Break the code on purpose to confirm the tests can fail. In `PriorityRule`, change `'Hot'` to `'Warm'` and rerun. `prioritiseEscalatesOnlyHotAccountCases` and the integration tests must fail. Change it back.
3. Move the account query into the `for` loop of `prioritise` and rerun the bulk test. It must fail with `Too many queries`. Revert.
4. Manual check of the real callout. Run this tiny stand-in for the paging service on a machine Salesforce can reach (use a public tunnel for a scratch org), and point the Named Credential at it:

```javascript
// pager-mock.js  (node pager-mock.js)
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    console.log(req.method, req.url, body);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end('{"accepted":true}');
  });
}).listen(8080, () => console.log('pager mock on :8080'));
```

5. In the org, run this anonymous Apex and watch the Node console print the JSON array:

```apex
// Anonymous Apex
Account a = new Account(Name = 'Manual Hot Test', Rating = 'Hot');
insert a;
insert new Case(AccountId = a.Id, Subject = 'Manual escalation test', Priority = 'Low', Origin = 'Web');
```

Expected: the Case is High and Escalated, the Queueable shows Completed in Setup, Apex Jobs, and the Node server prints one line with `"severity":"High"`.

## Common mistakes and fixes

- **Symptom: `MIXED_DML_OPERATION` when creating a test user.** Cause: a User (setup object) and an Account (non-setup object) are inserted in the same transaction. Fix: insert the user inside `System.runAs(new User(Id = UserInfo.getUserId()))`, as `TestDataFactory.user` does.
- **Symptom: `You have uncommitted work pending` or a callout error in a test.** Cause: DML before a callout in the same transaction, or no mock registered. Fix: call `Test.setMock` first and put the work that makes the callout inside `Test.startTest()`/`stopTest()`, or move the callout to a Queueable.
- **Symptom: tests pass alone but fail together.** Cause: static variables (the mock call counter, the gateway) keep values from another test method. Fix: reset statics at the start of each test, as the examples reset `PagerCalloutMock.calls`.
- **Symptom: 100% coverage but a bug shipped.** Cause: a test with no assertions. Fix: assert the outcome (field values, record counts, calls made), and mutate the code once in a while to see the test fail.
- **Symptom: tests fail in a new org.** Cause: `@SeeAllData=true` or hard-coded Ids and names that exist only in one org. Fix: build every record in the test and look up Ids at run time.
- **Symptom: the async job did not run.** Cause: the assertion is before `Test.stopTest()`. Fix: always assert after `stopTest()` for queued, batch, future and scheduled work.
- **Symptom: `System.StubProvider` returns `null` and the code breaks.** Cause: the stub's method name did not match. Fix: compare `stubbedMethodName` exactly and return a value of the right type for each method.
- **Symptom: a validation rule or flow in the org breaks your test data.** Cause: factory records do not satisfy required fields. Fix: keep required values in the factory so one change fixes every test.

## Key takeaways

- Coverage of 75% is a deployment rule; assertions are what make a test valuable.
- Create your own data, build records in a factory, and let the test decide when DML happens.
- Put every outside dependency behind an interface so you can use the Stub API, and use `HttpCalloutMock` to test the real HTTP code.
- Always include a bulk test with a limit assertion, a negative test and a security test.
- Assert async results after `Test.stopTest()`.

## Where to go next

- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Trigger handler pattern](/articles/trigger-handler-pattern/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
