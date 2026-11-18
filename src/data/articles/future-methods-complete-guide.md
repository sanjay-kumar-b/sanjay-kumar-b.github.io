---
title: "Future Methods Complete Guide: When @future Still Makes Sense"
description: "How @future methods work, their limits, callouts, the mixed DML workaround and when to migrate to Queueable, using a partner onboarding build."
category: salesforce-development
tags: [Future, Apex, Async, Mixed DML]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/future-methods-complete-guide.jpg
sources:
  - title: "Future Methods (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_invoking_future_methods.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
  - title: "sObjects That Cannot Be Used Together in DML Operations (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_dml_non_mix_sobjects.htm"
  - title: "Queueable Apex (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_queueing_jobs.htm"
---

A **future method** is a static Apex method marked `@future`. When your code calls it, Salesforce does not run it now. It records the call and runs the method later, in its own transaction, when resources are free. Your original transaction carries on and finishes without waiting.

Future methods are the oldest async tool in Apex. They solve two classic problems: making a callout from a context that cannot (like a trigger), and doing DML on setup objects (users, permission set assignments) next to DML on normal records. They are also limited. They take only simple parameters, return nothing, run in no guaranteed order and cannot be chained. For new code, Queueable Apex is usually better.

You still need to understand `@future`. Plenty of production orgs contain it, and a migration is safer when you know exactly what the old code guaranteed. This article builds a partner-onboarding flow that uses future methods the way a real legacy org would, shows where they hurt, and then migrates it to Queueable.

## The business scenario

Orbit Field Services (a fictional equipment-repair company) onboards partner technicians. Each request is a `Partner_Onboarding__c` record linked to the partner's Salesforce user. When a manager changes the status to **Approved**:

1. The partner's user gets a permission set (for example `Partner_Portal_Access`). That is DML on a setup object.
2. The technician is registered in a legacy badge system with an HTTPS call. The call returns a badge Id, saved on the onboarding record with status **Provisioned**.
3. If anything fails, the record ends as **Failed** with a message.
4. Approving 200 records in a data load must not break any limits.
5. An admin can switch from the legacy future path to the Queueable path with a setting, so the migration is gradual and reversible.

The status update in the trigger and the permission set assignment cannot share a transaction. The callout cannot run in the trigger at all. Both are why future methods exist.

## Before you start: setup

Use a Developer Edition or scratch org. Labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In the external system

1. **Get access to the badge system.** Ask the legacy system's owner for a test environment and an API key. The code posts JSON to `/api/badges` and expects `{"badgeId": "B-1001"}`. Verify: `curl -X POST -H "X-Api-Key: $KEY" -H "Content-Type: application/json" -d '{"email":"a@example.com","name":"Test"}' https://badges.orbit-legacy.example/api/badges` returns a badge Id.
2. **Ask about idempotency and network rules.** We send an `Idempotency-Key` header so a retried call does not create a second badge; confirm the system honours it. If it restricts by IP, give its owner the Salesforce IP ranges from the official documentation, or place a gateway in front. Verify: a call from your org succeeds.

### In Salesforce

1. **Create the custom object `Partner_Onboarding__c`.** Fields: `Partner_User__c` (Lookup to User), `Permission_Set_Name__c` (Text 80, the permission set API name), `Status__c` (Picklist: Requested, Approved, Provisioned, Failed), `Badge_Id__c` (Text 40), `Provisioning_Error__c` (Text 255). Verify: it shows in the App Launcher.
2. **Create the permission set to hand out.** Setup, Permission Sets, New, with API name `Partner_Portal_Access`. Why: the job assigns it by name. Verify: it appears in the list.
3. **Create the External Credential and Named Credential.** Setup, Security, Named Credentials. External Credential `Legacy_Badge_EC` with the Custom protocol, a principal, and a parameter `ApiKey`. Named Credential `Legacy_Badge_System` with the legacy URL, and a custom header `X-Api-Key` set to `{!$Credential.Legacy_Badge_EC.ApiKey}`. Verify: it saves. See [REST callouts with Named Credentials](/articles/rest-callouts-named-credentials/) for detail.
4. **Grant principal access.** In the permission set of the users who approve records, enable the external credential principal. Verify: the callout in "Test it and verify" works.
5. **Give the running user the right to assign permission sets.** The user whose action triggers the future needs the "Assign Permission Sets" system permission. Verify: that user can assign a permission set manually.
6. **Create the custom metadata type `Provisioning_Setting__mdt`** with a checkbox `Use_Queueable__c`, and one record named `Default` (unchecked). Verify: Manage Records shows the row.

### On your machine

Install the Salesforce CLI and authorize an org with `sf org login web --alias dev`. Use an SFDX project so the file paths below match.

## How it works

Rules for a future method:

1. It must be `static` and return `void`.
2. Parameters must be primitives or collections of primitives, never sObjects. Pass Ids and query again, which also gives you fresh data.
3. Add `callout=true` to allow HTTP callouts.
4. A transaction can call at most 50 future methods. Check `Limits.getFutureCalls()` against `Limits.getLimitFutureCalls()`.
5. You cannot call a future method from another future method or from a batch job. `System.isFuture()` and `System.isBatch()` tell you where you are.
6. There is no job Id, no ordering guarantee, and calls run in their own transactions with asynchronous limits.

| Problem | Why a future method helps |
|---|---|
| Callout from a trigger | The future runs after the trigger's transaction commits, where callouts are allowed. |
| **Mixed DML** | Salesforce blocks setup-object DML (User, PermissionSetAssignment and others) and normal-record DML in the same transaction. A future gives the setup DML its own transaction. |
| Slow work | The user's save returns at once. |

**Mixed DML** means mixing a setup object and a non-setup object in one transaction. The platform raises `MIXED_DML_OPERATION`. The official list of affected sObjects is in the Apex Developer Guide.

```text
Trigger transaction                     Future transactions (later, any order)
-------------------                     --------------------------------------
update Partner_Onboarding__c  --commit--> assignPermissionSets()  setup DML only
call future A, call future B             registerBadges()          callout, then DML
```

Because the two futures are independent, B cannot know whether A succeeded, and B may run first. That flaw is real, and we will fix it with Queueable.

## Basic example

A future method that stamps accounts after a save, and the loop mistake everyone makes.

```apex
public class AccountStampFuture {
    @future
    public static void stamp(Set<Id> accountIds) {
        // Re-query: the data may have changed since the call
        List<Account> accounts = [SELECT Id FROM Account WHERE Id IN :accountIds];
        for (Account a : accounts) {
            a.Description = 'Stamped ' + Datetime.now().format();
        }
        update accounts;
    }
}
```

```apex
public class StampCallers {
    // BAD: a future call per record. A transaction allows 50, so 51 accounts fail.
    public static void badStampEach(List<Account> accounts) {
        for (Account a : accounts) {
            AccountStampFuture.stamp(new Set<Id>{ a.Id });
        }
    }

    // FIXED: one call with all ids
    public static void stampAll(List<Account> accounts) {
        Set<Id> ids = new Map<Id, Account>(accounts).keySet();
        if (!ids.isEmpty()) {
            AccountStampFuture.stamp(ids);
        }
    }
}
```

Run it:

```apex
// Anonymous Apex
List<Account> accounts = [SELECT Id FROM Account LIMIT 5];
StampCallers.stampAll(accounts);
System.debug('Future calls so far: ' + Limits.getFutureCalls());
```

Expected result: the debug line shows `1`. A few seconds later each account has a description that begins with "Stamped".

## Advanced end-to-end example

First the legacy version, with futures. Then the Queueable replacement. Both share one service so you can compare them.

**`force-app/main/default/classes/LegacyBadgeClient.cls`**

```apex
/**
 * HTTP client for the legacy badge system. Returns a result object so callers
 * can mark individual records failed without throwing.
 */
public with sharing class LegacyBadgeClient {

    public class Result {
        public Boolean success = false;
        public String badgeId;
        public String message;
    }

    private class BadgeResponse {
        public String badgeId;
    }

    public static Result register(String email, String fullName, String idempotencyKey) {
        Result res = new Result();
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Legacy_Badge_System/api/badges');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Idempotency-Key', idempotencyKey);
        req.setTimeout(15000);
        req.setBody(JSON.serialize(new Map<String, String>{
            'email' => email,
            'name' => fullName
        }));

        try {
            HttpResponse resp = new Http().send(req);
            Integer code = resp.getStatusCode();
            if (code == 200 || code == 201) {
                BadgeResponse parsed = (BadgeResponse) JSON.deserialize(
                    resp.getBody(), BadgeResponse.class);
                if (String.isBlank(parsed.badgeId)) {
                    res.message = 'Response had no badgeId';
                } else {
                    res.success = true;
                    res.badgeId = parsed.badgeId;
                }
            } else {
                res.message = 'HTTP ' + code;
            }
        } catch (CalloutException e) {
            res.message = 'Callout failed: ' + e.getMessage();
        } catch (JSONException e) {
            res.message = 'Bad response: ' + e.getMessage();
        }
        return res;
    }
}
```

**`force-app/main/default/classes/PartnerProvisioningService.cls`**

```apex
/**
 * Shared logic for both the future path and the Queueable path.
 * assignPermissionSets: setup-object DML ONLY. registerBadges: callouts, then
 * non-setup DML. The two must never run in the same transaction.
 */
public with sharing class PartnerProvisioningService {

    /** Returns a map of onboarding id to error message for records that failed. */
    public static Map<Id, String> assignPermissionSets(Set<Id> onboardingIds) {
        Map<Id, String> errors = new Map<Id, String>();
        List<Partner_Onboarding__c> recs = [
            SELECT Id, Partner_User__c, Permission_Set_Name__c
            FROM Partner_Onboarding__c
            WHERE Id IN :onboardingIds AND Status__c = 'Approved'
            WITH USER_MODE
        ];

        Set<String> names = new Set<String>();
        Set<Id> userIds = new Set<Id>();
        for (Partner_Onboarding__c r : recs) {
            names.add(r.Permission_Set_Name__c);
            userIds.add(r.Partner_User__c);
        }

        // Setup objects are read without USER_MODE: they are not governed by FLS
        Map<String, Id> psIdByName = new Map<String, Id>();
        for (PermissionSet ps : [SELECT Id, Name FROM PermissionSet WHERE Name IN :names]) {
            psIdByName.put(ps.Name, ps.Id);
        }
        Set<String> existing = new Set<String>();
        for (PermissionSetAssignment a : [
            SELECT AssigneeId, PermissionSetId FROM PermissionSetAssignment
            WHERE AssigneeId IN :userIds AND PermissionSetId IN :psIdByName.values()
        ]) {
            existing.add(a.AssigneeId + '|' + a.PermissionSetId);
        }

        List<PermissionSetAssignment> toInsert = new List<PermissionSetAssignment>();
        List<Id> owners = new List<Id>();
        for (Partner_Onboarding__c r : recs) {
            Id psId = psIdByName.get(r.Permission_Set_Name__c);
            if (r.Partner_User__c == null) {
                errors.put(r.Id, 'No partner user');
            } else if (psId == null) {
                errors.put(r.Id, 'Permission set not found: ' + r.Permission_Set_Name__c);
            } else if (existing.add(r.Partner_User__c + '|' + psId)) {
                // add() returns false when already present, so duplicates are skipped
                toInsert.add(new PermissionSetAssignment(
                    AssigneeId = r.Partner_User__c, PermissionSetId = psId));
                owners.add(r.Id);
            }
        }

        if (!toInsert.isEmpty()) {
            List<Database.SaveResult> results = Database.insert(toInsert, false);
            for (Integer i = 0; i < results.size(); i++) {
                if (!results[i].isSuccess()) {
                    errors.put(owners[i], results[i].getErrors()[0].getMessage());
                }
            }
        }
        return errors;
    }

    /** Callouts for every record first, then one DML statement. */
    public static void registerBadges(List<Id> onboardingIds, Map<Id, String> priorErrors) {
        List<Partner_Onboarding__c> recs = [
            SELECT Id, Partner_User__r.Email, Partner_User__r.Name
            FROM Partner_Onboarding__c
            WHERE Id IN :onboardingIds AND Status__c = 'Approved'
            WITH USER_MODE
        ];
        for (Partner_Onboarding__c r : recs) {
            if (priorErrors.containsKey(r.Id)) {
                fail(r, priorErrors.get(r.Id));
                continue;
            }
            LegacyBadgeClient.Result res = LegacyBadgeClient.register(
                r.Partner_User__r.Email, r.Partner_User__r.Name, String.valueOf(r.Id));
            if (res.success) {
                r.Status__c = 'Provisioned';
                r.Badge_Id__c = res.badgeId;
                r.Provisioning_Error__c = null;
            } else {
                fail(r, res.message);
            }
        }
        // Moving off Approved means the trigger does not fire the flow again
        Database.update(recs, false);
    }

    private static void fail(Partner_Onboarding__c r, String message) {
        r.Status__c = 'Failed';
        r.Provisioning_Error__c = String.isBlank(message)
            ? 'Unknown error' : message.abbreviate(255);
    }
}
```

**`force-app/main/default/classes/PartnerProvisioningFuture.cls`** (the legacy path)

```apex
/**
 * Legacy path. Two independent futures: no ordering, no shared result,
 * no chaining. Kept so the migration can be switched on and off.
 */
public with sharing class PartnerProvisioningFuture {

    // Setup-object DML only, so it is safe in its own transaction
    @future
    public static void assignPermissionSets(Set<Id> onboardingIds) {
        Map<Id, String> errors = PartnerProvisioningService.assignPermissionSets(onboardingIds);
        // Writing the errors back to Partner_Onboarding__c here would be mixed DML.
        // All we can do is log. This is the first weakness of the future design.
        for (Id recId : errors.keySet()) {
            System.debug(LoggingLevel.ERROR, 'Permission failure ' + recId + ': ' + errors.get(recId));
        }
    }

    @future(callout=true)
    public static void registerBadges(Set<Id> onboardingIds) {
        // It cannot see what assignPermissionSets did: second weakness
        PartnerProvisioningService.registerBadges(
            new List<Id>(onboardingIds), new Map<Id, String>());
    }
}
```

**`force-app/main/default/classes/PermissionAssignJob.cls`** (the Queueable replacement, step 1)

```apex
/**
 * Step 1: setup DML only. Then it hands its result to step 2 through the
 * constructor, which a future method cannot do.
 */
public with sharing class PermissionAssignJob implements Queueable {
    private final List<Id> onboardingIds;

    public PermissionAssignJob(List<Id> onboardingIds) {
        this.onboardingIds = onboardingIds;
    }

    public void execute(QueueableContext ctx) {
        Map<Id, String> errors = PartnerProvisioningService.assignPermissionSets(
            new Set<Id>(onboardingIds));
        // Queueables may not chain inside a test, so the test runs step 2 itself
        if (!Test.isRunningTest()) {
            System.enqueueJob(new BadgeRegistrationJob(onboardingIds, errors));
        }
    }
}
```

**`force-app/main/default/classes/BadgeRegistrationJob.cls`**

```apex
/**
 * Step 2: callouts, then non-setup DML. Handles 50 records per run
 * (50 callouts, below the limit of 100) and chains the remainder.
 */
public with sharing class BadgeRegistrationJob implements Queueable, Database.AllowsCallouts {
    public static final Integer CHUNK_SIZE = 50;

    private final List<Id> onboardingIds;
    private final Map<Id, String> priorErrors;

    public BadgeRegistrationJob(List<Id> onboardingIds, Map<Id, String> priorErrors) {
        this.onboardingIds = onboardingIds;
        this.priorErrors = priorErrors;
    }

    public void execute(QueueableContext ctx) {
        List<Id> chunk = new List<Id>();
        List<Id> remainder = new List<Id>();
        for (Integer i = 0; i < onboardingIds.size(); i++) {
            if (i < CHUNK_SIZE) {
                chunk.add(onboardingIds[i]);
            } else {
                remainder.add(onboardingIds[i]);
            }
        }
        PartnerProvisioningService.registerBadges(chunk, priorErrors);

        if (!remainder.isEmpty() && !Test.isRunningTest()) {
            System.enqueueJob(new BadgeRegistrationJob(remainder, priorErrors));
        }
    }
}
```

**`force-app/main/default/classes/PartnerOnboardingHandler.cls`**

```apex
public with sharing class PartnerOnboardingHandler {

    @TestVisible private static Boolean forceQueueable;
    private static final Integer FUTURE_GROUP_SIZE = 50;

    public static void afterUpdate(
        List<Partner_Onboarding__c> newRecords, Map<Id, Partner_Onboarding__c> oldMap
    ) {
        List<Id> approved = new List<Id>();
        for (Partner_Onboarding__c r : newRecords) {
            if (r.Status__c == 'Approved' && oldMap.get(r.Id).Status__c != 'Approved') {
                approved.add(r.Id);
            }
        }
        if (approved.isEmpty()) {
            return;
        }

        Integer groups = (Integer) Math.ceil(approved.size() / (Decimal) FUTURE_GROUP_SIZE);
        Boolean futureBudgetOk =
            Limits.getFutureCalls() + 1 + groups <= Limits.getLimitFutureCalls();

        // A future method cannot be called from a future or a batch, and a big load
        // can exhaust the 50-call budget. Queueable has neither problem.
        // Verify in your org that your calling context may enqueue a Queueable.
        if (useQueueable() || System.isFuture() || System.isBatch() || !futureBudgetOk) {
            System.enqueueJob(new PermissionAssignJob(approved));
            return;
        }

        PartnerProvisioningFuture.assignPermissionSets(new Set<Id>(approved));
        for (Integer start = 0; start < approved.size(); start += FUTURE_GROUP_SIZE) {
            Integer stop = Math.min(start + FUTURE_GROUP_SIZE, approved.size());
            PartnerProvisioningFuture.registerBadges(new Set<Id>(slice(approved, start, stop)));
        }
    }

    private static Boolean useQueueable() {
        if (forceQueueable != null) {
            return forceQueueable;
        }
        Provisioning_Setting__mdt setting = Provisioning_Setting__mdt.getInstance('Default');
        return setting != null && setting.Use_Queueable__c == true;
    }

    private static List<Id> slice(List<Id> source, Integer fromIdx, Integer toIdx) {
        List<Id> part = new List<Id>();
        for (Integer i = fromIdx; i < toIdx; i++) {
            part.add(source[i]);
        }
        return part;
    }
}
```

**`force-app/main/default/triggers/PartnerOnboardingTrigger.trigger`**

```apex
trigger PartnerOnboardingTrigger on Partner_Onboarding__c (after update) {
    PartnerOnboardingHandler.afterUpdate(Trigger.new, Trigger.oldMap);
}
```

**`force-app/main/default/classes/MixedDmlDemo.cls`** (the problem, on purpose)

```apex
public with sharing class MixedDmlDemo {
    // BAD: a normal record and a setup object in one transaction.
    // This throws MIXED_DML_OPERATION. The fix is the async split above.
    public static void sameTransaction(Id onboardingId, Id userId, Id permSetId) {
        update new Partner_Onboarding__c(Id = onboardingId, Status__c = 'Provisioned');
        insert new PermissionSetAssignment(AssigneeId = userId, PermissionSetId = permSetId);
    }
}
```

**`force-app/main/default/customMetadata/Provisioning_Setting.Default.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
                xmlns:xsd="http://www.w3.org/2001/XMLSchema"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Use_Queueable__c</field>
        <value xsi:type="xsd:boolean">false</value>
    </values>
</CustomMetadata>
```

**`force-app/main/default/classes/PartnerProvisioningTest.cls`**

```apex
@IsTest
private class PartnerProvisioningTest {

    private class BadgeMock implements HttpCalloutMock {
        public Integer status = 200;
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(status);
            res.setHeader('Content-Type', 'application/json');
            res.setBody('{"badgeId":"B-1001"}');
            return res;
        }
    }

    // Setup objects must be created in a different transaction from normal records
    @TestSetup
    static void makeUserAndPermissionSet() {
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
            insert new User(
                Alias = 'partn', Email = 'partner@example.com', EmailEncodingKey = 'UTF-8',
                LastName = 'Partner', LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
                ProfileId = p.Id, TimeZoneSidKey = 'America/Los_Angeles',
                Username = 'partner.' + System.currentTimeMillis() + '@example.com');
            insert new PermissionSet(Name = 'Partner_Portal_Access', Label = 'Partner Portal Access');
        }
    }

    private static List<Partner_Onboarding__c> makeRequests(Integer n, String psName) {
        User u = [SELECT Id FROM User WHERE Alias = 'partn' LIMIT 1];
        List<Partner_Onboarding__c> recs = new List<Partner_Onboarding__c>();
        for (Integer i = 0; i < n; i++) {
            recs.add(new Partner_Onboarding__c(
                Partner_User__c = u.Id, Permission_Set_Name__c = psName, Status__c = 'Requested'));
        }
        insert recs;
        return recs;
    }

    private static void approve(List<Partner_Onboarding__c> recs) {
        for (Partner_Onboarding__c r : recs) {
            r.Status__c = 'Approved';
        }
        update recs;
    }

    @IsTest
    static void futurePathProvisionsTwoHundredRecords() {
        List<Partner_Onboarding__c> recs = makeRequests(200, 'Partner_Portal_Access');
        Test.setMock(HttpCalloutMock.class, new BadgeMock());
        PartnerOnboardingHandler.forceQueueable = false;

        Test.startTest();
        approve(recs);
        Test.stopTest();

        System.assertEquals(200, [SELECT COUNT() FROM Partner_Onboarding__c
                                  WHERE Status__c = 'Provisioned' AND Badge_Id__c = 'B-1001']);
        // One user, one permission set: duplicates were skipped
        System.assertEquals(1, [SELECT COUNT() FROM PermissionSetAssignment
                                WHERE PermissionSet.Name = 'Partner_Portal_Access'
                                AND Assignee.Alias = 'partn']);
    }

    @IsTest
    static void queueablePathAssignsPermissionSet() {
        List<Partner_Onboarding__c> recs = makeRequests(3, 'Partner_Portal_Access');
        PartnerOnboardingHandler.forceQueueable = true;

        Test.startTest();
        approve(recs);
        Test.stopTest();

        System.assertEquals(1, [SELECT COUNT() FROM PermissionSetAssignment
                                WHERE PermissionSet.Name = 'Partner_Portal_Access'
                                AND Assignee.Alias = 'partn']);
    }

    @IsTest
    static void badgeJobRegistersBadges() {
        List<Partner_Onboarding__c> recs = makeRequests(3, 'Partner_Portal_Access');
        approve(recs); // no async handler side effects matter: we run step 2 directly
        List<Id> ids = new List<Id>(new Map<Id, Partner_Onboarding__c>(recs).keySet());
        Test.setMock(HttpCalloutMock.class, new BadgeMock());

        Test.startTest();
        System.enqueueJob(new BadgeRegistrationJob(ids, new Map<Id, String>()));
        Test.stopTest();

        System.assertEquals(3, [SELECT COUNT() FROM Partner_Onboarding__c
                                WHERE Status__c = 'Provisioned']);
    }

    @IsTest
    static void priorPermissionErrorMarksRecordFailedWithoutCallout() {
        List<Partner_Onboarding__c> recs = makeRequests(1, 'Does_Not_Exist');
        PartnerOnboardingHandler.forceQueueable = true;
        approve(recs);
        Test.setMock(HttpCalloutMock.class, new BadgeMock());

        Test.startTest();
        System.enqueueJob(new BadgeRegistrationJob(
            new List<Id>{ recs[0].Id },
            new Map<Id, String>{ recs[0].Id => 'Permission set not found: Does_Not_Exist' }));
        Test.stopTest();

        Partner_Onboarding__c r = [SELECT Status__c, Provisioning_Error__c
                                   FROM Partner_Onboarding__c WHERE Id = :recs[0].Id];
        System.assertEquals('Failed', r.Status__c);
        System.assert(r.Provisioning_Error__c.contains('Permission set not found'));
    }

    @IsTest
    static void legacySystemErrorMarksRecordFailed() {
        List<Partner_Onboarding__c> recs = makeRequests(1, 'Partner_Portal_Access');
        BadgeMock mock = new BadgeMock();
        mock.status = 500;
        Test.setMock(HttpCalloutMock.class, mock);
        PartnerOnboardingHandler.forceQueueable = false;

        Test.startTest();
        approve(recs);
        Test.stopTest();

        Partner_Onboarding__c r = [SELECT Status__c, Provisioning_Error__c
                                   FROM Partner_Onboarding__c WHERE Id = :recs[0].Id];
        System.assertEquals('Failed', r.Status__c);
        System.assertEquals('HTTP 500', r.Provisioning_Error__c);
    }

    @IsTest
    static void mixedDmlInOneTransactionThrows() {
        List<Partner_Onboarding__c> recs = makeRequests(1, 'Partner_Portal_Access');
        User u = [SELECT Id FROM User WHERE Alias = 'partn' LIMIT 1];
        PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Partner_Portal_Access'];
        try {
            MixedDmlDemo.sameTransaction(recs[0].Id, u.Id, ps.Id);
            System.assert(false, 'Expected a mixed DML exception');
        } catch (DmlException e) {
            System.assert(e.getMessage().contains('MIXED_DML_OPERATION'), e.getMessage());
        }
    }
}
```

**`scripts/deploy-and-run.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names PartnerProvisioningTest --target-org dev \
  --result-format human --wait 10
```

## What happens behind the scenes

Approve 200 onboarding records with the legacy path switched on.

1. **Trigger transaction.** The `after update` handler finds 200 approved ids. It checks the future budget: 1 permission future plus 4 badge groups of 50 is 5 calls, well under 50. It calls `assignPermissionSets` once and `registerBadges` four times. None of these runs yet. Each call only stores its arguments, and the user's save commits.
2. **Queue.** Five future requests are queued. No order is promised. The permission future and a badge future can run at the same moment on different workers.
3. **Permission future.** It queries the 200 records, the permission set and existing assignments (3 SOQL queries), then inserts at most one `PermissionSetAssignment` because all 200 rows point to the same user. That is the only DML, and it is setup DML, so no mixed DML error is possible. Any error can only be logged.
4. **Badge futures.** Each takes 50 ids, runs one query, makes 50 callouts through the Named Credential and then one `Database.update` of 50 rows. The 50 callouts are half of the 100-callout limit. The `Idempotency-Key` header is the record Id, so a platform retry cannot make a second badge.
5. **Trigger again.** The update changes Status from Approved to Provisioned, so the trigger sees "not newly approved" and does nothing. That guard is the recursion stop.
6. **Queueable mode.** With `Use_Queueable__c` on, the handler enqueues one `PermissionAssignJob`. It does setup DML, then enqueues `BadgeRegistrationJob` with the error map. That job processes 50 records, chains the next 50, and so on. Failures from step 1 reach step 2, which futures cannot do, and a job Id exists for monitoring.

In the debug log, future runs appear as separate log entries with the operation name of the method, each with its own `LIMIT_USAGE_FOR_NS`. In Setup, Apex Jobs lists both future and queueable executions. Look for `CALLOUT_REQUEST` with the endpoint `callout:Legacy_Badge_System`.

## Test it and verify

1. **Run the tests:** `sf apex run test --class-names PartnerProvisioningTest --target-org dev --result-format human --wait 10`. Expected: six passing tests, including the one that proves `MIXED_DML_OPERATION`.
2. **Check the credential.** Anonymous Apex:
   ```apex
   // Anonymous Apex
   LegacyBadgeClient.Result r = LegacyBadgeClient.register(
       'a@example.com', 'Test Person', 'manual-test-1');
   System.debug(r.success + ' ' + r.badgeId + ' ' + r.message);
   ```
   Expected: `true B-... null`. An authorization error means the principal access in setup step 4 is missing.
3. **Legacy path in the UI.** Create a `Partner_Onboarding__c` with a real partner user and permission set name, then change Status to Approved. Wait a few seconds and refresh: Status is Provisioned and Badge_Id__c has a value. Check the user's Permission Set Assignments.
4. **Queueable path.** Set `Use_Queueable__c` to true in Custom Metadata, approve another record and compare: Setup, Apex Jobs now shows `PermissionAssignJob` then `BadgeRegistrationJob`.
5. **Failure path.** Set `Permission_Set_Name__c` to a name that does not exist and approve it on the Queueable path. Expected: Failed with "Permission set not found".

## Common mistakes and fixes

1. **`MIXED_DML_OPERATION`.** Cause: setup and normal DML in one transaction. Fix: move the setup DML into a future or queueable. In tests, create setup records inside `System.runAs` or in `@TestSetup`.
2. **"Invalid parameter type" at compile time.** Cause: an sObject or custom class passed to `@future`. Fix: pass a `Set<Id>` and query inside.
3. **Too many future calls: 51.** Cause: a future call in a loop. Fix: one call with a collection, grouped if the callout limit needs it.
4. **"Future method cannot be called from a future or batch method".** Cause: a trigger running inside one of those contexts. Fix: check `System.isFuture()` and `System.isBatch()` and use another path, or migrate to Queueable.
5. **Callout is not allowed.** Cause: missing `callout=true`. Fix: `@future(callout=true)`.
6. **Assuming order.** Cause: calling two futures and expecting the first to finish first. Fix: put dependent steps in one chain of queueables.
7. **Test asserts run before the future did.** Cause: assertions outside the `Test.startTest()`/`Test.stopTest()` pair. Fix: assert after `stopTest()`, which runs queued async work.
8. **Lost errors.** Cause: a future that fails has no caller to tell. Fix: write failures to a record (outside the mixed DML context), publish an event, or use a Queueable with a Finalizer.

## Key takeaways

- A future method is a static void method that runs later in its own transaction, with only primitive parameters.
- It is still the simplest fix for mixed DML and for a callout that must leave a trigger, but it gives no job Id, no ordering and no chaining.
- Pass Ids, query again inside, and call it once per transaction with a collection. The limit is 50 calls per transaction.
- Dependent steps and shared results need Queueable. Use a setting to migrate gradually.
- Treat future code in an existing org as a migration candidate, but keep its tests when you move it.

## Where to go next

- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)
- [Batch vs Queueable vs Future](/articles/batch-vs-queueable-vs-future/)
- [Batch Apex complete guide](/articles/batch-apex-complete-guide/)
- [Apex async advanced patterns](/articles/apex-async-advanced-patterns/)
- [Outbound callouts, advanced](/articles/outbound-callouts-advanced/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
