---
title: "Flow vs Apex: How to Decide Which One to Build"
description: "A practical decision framework for Flow and Apex, with a lead-scoring example built both ways: a Flow that calls a bulk-safe invocable Apex action."
category: salesforce-administration
tags: [Flows, Apex, Architecture]
publishedAt: 2026-10-27
updatedAt: 2026-11-15
cover: /images/covers/flow-vs-apex.jpg
featured: true
sources:
  - title: "Salesforce Flow (Salesforce Help)"
    url: "https://help.salesforce.com/s/products/platform"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
---

Salesforce has announced end of support for Workflow Rules and Process Builder and points declarative automation to **Flow**. Check Salesforce Help for the current status. The real question today is when Flow is enough and when you need Apex, and the best answer is often both: Flow owns the process, Apex does the one hard step. This article gives you a decision method and a complete example of the combination.

## The business scenario

Orchard Software (a fictional company) wants every new Lead to get a score from 0 to 100. The score depends on company size, industry, whether the email is a free mail domain, and how many past leads from the same company converted. An admin wants to own the process (who gets notified, what happens to hot leads), but the scoring formula needs a query and some arithmetic that would make a Flow messy. The score must be correct when 200 leads are imported at once.

## Before you start: setup

### In Salesforce

1. Create custom fields on Lead: `Score__c` (number, 3 digits, 0 decimals) and `Score_Reason__c` (text 255).
2. Create a custom metadata type `Scoring_Rule__mdt` with fields `Industry__c` (text) and `Points__c` (number), and add a few records such as Energy with 20 points. This avoids hard-coded values.
3. Create a permission set that grants edit on the two Lead fields and access to the Apex class `LeadScoreAction`. Assign it to the users or automation context that need it.
4. Do the work in a sandbox or scratch org. Flows are deployed as metadata, so you can build in Flow Builder and retrieve the XML afterwards.

### In the external system

Nothing is required. If you later score from an external service, add a Named Credential and call it from the same Apex action, as described in the callouts articles.

## How it works

Start with Flow when:

- The logic is "if this, then that" with a handful of conditions.
- An admin should be able to maintain it.
- You need a guided user interface (screen flow).
- You are creating, updating or finding records without complex calculations.
- You need scheduled actions, approvals or email alerts.

Choose Apex when:

- You must process very large or complex data sets, using Batch or Queueable.
- The logic involves complex algorithms, recursion or heavy collections.
- You need precise control over transactions, savepoints or error handling.
- You are building a reusable service called from Flows, LWC and APIs.
- Performance under high volume is critical and measured.

**Rule of thumb:** build with Flow first. Move to Apex when you can name a concrete limit, performance need or maintainability reason, and document why.

A combined pattern gets the best of both. The Flow decides *when* and *what next*, and an **invocable Apex action** does the calculation. An invocable method receives a list, so one Flow interview for 200 records calls Apex once with 200 requests, not 200 times.

## Basic example

The smallest invocable method takes a list and returns a list in the same order:

```apex
public with sharing class ScoreCalculator {
    @InvocableMethod(label='Calculate Score')
    public static List<Decimal> calc(List<Id> leadIds) {
        List<Decimal> out = new List<Decimal>();
        for (Id leadId : leadIds) {
            out.add(42);
        }
        return out;
    }
}
```

In Flow Builder it appears as an action called "Calculate Score". Its fixed answer of 42 makes it a good first test of the plumbing. The advanced example replaces it with real logic and request and response objects, which are easier to extend.

## Advanced end-to-end example

**force-app/main/default/classes/LeadScoreAction.cls**

```apex
public with sharing class LeadScoreAction {

    public class Request {
        @InvocableVariable(label='Lead Id' required=true)
        public Id leadId;
    }

    public class Result {
        @InvocableVariable(label='Score')
        public Integer score;
        @InvocableVariable(label='Reason')
        public String reason;
    }

    private static final Set<String> FREE_MAIL = new Set<String>{ 'gmail.com', 'yahoo.com', 'outlook.com' };

    @InvocableMethod(label='Calculate Lead Score' description='Scores leads in bulk')
    public static List<Result> calculate(List<Request> requests) {
        Set<Id> ids = new Set<Id>();
        for (Request r : requests) {
            ids.add(r.leadId);
        }

        Map<Id, Lead> leads = new Map<Id, Lead>([
            SELECT Id, Industry, Email, NumberOfEmployees, Company
            FROM Lead WHERE Id IN :ids
        ]);

        Map<String, Decimal> industryPoints = new Map<String, Decimal>();
        for (Scoring_Rule__mdt rule : [SELECT Industry__c, Points__c FROM Scoring_Rule__mdt]) {
            industryPoints.put(rule.Industry__c, rule.Points__c);
        }

        List<Result> results = new List<Result>();
        for (Request r : requests) {
            results.add(score(leads.get(r.leadId), industryPoints));
        }
        return results;
    }

    @TestVisible
    private static Result score(Lead lead, Map<String, Decimal> industryPoints) {
        Result res = new Result();
        if (lead == null) {
            res.score = 0;
            res.reason = 'Lead not found';
            return res;
        }
        Integer total = 10;
        List<String> why = new List<String>{ 'base 10' };

        if (lead.NumberOfEmployees != null && lead.NumberOfEmployees >= 500) {
            total += 30;
            why.add('large company +30');
        } else if (lead.NumberOfEmployees != null && lead.NumberOfEmployees >= 50) {
            total += 15;
            why.add('mid-size company +15');
        }

        if (lead.Industry != null && industryPoints.containsKey(lead.Industry)) {
            Integer pts = Integer.valueOf(industryPoints.get(lead.Industry));
            total += pts;
            why.add(lead.Industry + ' +' + pts);
        }

        if (lead.Email != null && FREE_MAIL.contains(lead.Email.substringAfter('@').toLowerCase())) {
            total -= 15;
            why.add('free mail -15');
        }

        res.score = Math.max(0, Math.min(100, total));
        res.reason = String.join(why, ', ').left(255);
        return res;
    }
}
```

**force-app/main/default/classes/LeadScoreActionTest.cls**

```apex
@IsTest
private class LeadScoreActionTest {

    @IsTest
    static void largeEnergyCompanyScoresHigh() {
        Lead l = new Lead(LastName = 'Rao', Company = 'Wind Co', Industry = 'Energy',
                          NumberOfEmployees = 800, Email = 'rao@windco.com');
        LeadScoreAction.Result r = LeadScoreAction.score(l, new Map<String, Decimal>{ 'Energy' => 20 });
        System.assertEquals(60, r.score);
        System.assert(r.reason.contains('Energy +20'));
    }

    @IsTest
    static void freeMailIsPenalisedAndScoreNeverNegative() {
        Lead l = new Lead(LastName = 'A', Company = 'Z', Email = 'a@gmail.com');
        LeadScoreAction.Result r = LeadScoreAction.score(l, new Map<String, Decimal>());
        System.assertEquals(0, r.score);
    }

    @IsTest
    static void scoreIsCappedAtOneHundred() {
        Lead l = new Lead(LastName = 'A', Company = 'Z', Industry = 'Energy', NumberOfEmployees = 900);
        LeadScoreAction.Result r = LeadScoreAction.score(l, new Map<String, Decimal>{ 'Energy' => 500 });
        System.assertEquals(100, r.score);
    }

    @IsTest
    static void twoHundredLeadsUseOneQueryForLeads() {
        List<Lead> leads = new List<Lead>();
        for (Integer i = 0; i < 200; i++) {
            leads.add(new Lead(LastName = 'L' + i, Company = 'C' + i, NumberOfEmployees = 100));
        }
        insert leads;
        List<LeadScoreAction.Request> reqs = new List<LeadScoreAction.Request>();
        for (Lead l : leads) {
            LeadScoreAction.Request r = new LeadScoreAction.Request();
            r.leadId = l.Id;
            reqs.add(r);
        }
        Test.startTest();
        List<LeadScoreAction.Result> out = LeadScoreAction.calculate(reqs);
        Test.stopTest();
        System.assertEquals(200, out.size());
        System.assertEquals(25, out[0].score);
        System.assert(Limits.getQueries() <= 3, 'Bulk safe: queries used ' + Limits.getQueries());
    }

    @IsTest
    static void missingLeadScoresZero() {
        LeadScoreAction.Result r = LeadScoreAction.score(null, new Map<String, Decimal>());
        System.assertEquals(0, r.score);
    }
}
```

**force-app/main/default/flows/Lead_Score_On_Create.flow-meta.xml** (an after-save record-triggered Flow; if it fails to deploy, rebuild it in Flow Builder with the same elements)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Lead Score On Create</label>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <description>Calls LeadScoreAction and stores the score on the new Lead.</description>
    <actionCalls>
        <name>Calculate_Score</name>
        <label>Calculate Score</label>
        <locationX>176</locationX>
        <locationY>323</locationY>
        <actionName>LeadScoreAction</actionName>
        <actionType>apex</actionType>
        <connector>
            <targetReference>Save_Score</targetReference>
        </connector>
        <flowTransactionModel>CurrentTransaction</flowTransactionModel>
        <inputParameters>
            <name>leadId</name>
            <value>
                <elementReference>$Record.Id</elementReference>
            </value>
        </inputParameters>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </actionCalls>
    <recordUpdates>
        <name>Save_Score</name>
        <label>Save Score</label>
        <locationX>176</locationX>
        <locationY>431</locationY>
        <inputAssignments>
            <field>Score__c</field>
            <value>
                <elementReference>Calculate_Score.score</elementReference>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>Score_Reason__c</field>
            <value>
                <elementReference>Calculate_Score.reason</elementReference>
            </value>
        </inputAssignments>
        <inputReference>$Record</inputReference>
    </recordUpdates>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Calculate_Score</targetReference>
        </connector>
        <object>Lead</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
</Flow>
```

The flow is saved as **Draft** on purpose, so you review it before activating. Add a fault connector from **Calculate Score** to a step that logs or notifies, then activate in a sandbox.

## What happens behind the scenes

When a Lead is inserted, Salesforce runs before-save automation, saves the record, then runs after-save automation including this flow, all in one transaction. The flow engine batches the interviews for all 200 records of a data load and calls the invocable method **once** with 200 requests. That is why the method takes a list and does its queries outside any loop. The returned list must be in the same order as the input, because the engine pairs the nth result with the nth interview.

The Update Records step then runs as one DML for the batch. All governor limits (queries, DML rows, CPU) are shared across triggers, flows and validation rules that fire in the same transaction. That is why layered automation is the main hazard: ten small automations can add up to a limit error that none of them would cause alone.

## Who maintains what

A good split keeps each tool where its owner is comfortable. The admin owns the Flow: the entry condition ("when a Lead is created"), what happens next (notify a queue when the score is above 80), and any changes to the process. The developer owns the Apex action and its tests, and publishes it with a clear label and description so it appears in Flow Builder as a building block. Scoring weights live in custom metadata, so the business can change points for an industry without a deployment.

Document the boundary in the Flow description: "Scoring formula lives in LeadScoreAction; change weights in Scoring Rule custom metadata." One sentence like that saves a future maintainer an afternoon. When someone later proposes moving everything into Apex, or everything into Flow, you will have the reasons written down.

## Test it and verify

1. Deploy the fields, custom metadata, class and flow to a sandbox, then run `LeadScoreActionTest`.
2. Open the flow in Flow Builder, review it, and activate.
3. Create a Lead with 800 employees in Energy and confirm the score and reason fields fill in.
4. Import 200 leads with the Data Import Wizard and confirm none fail with a limit error.
5. Temporarily rename the Apex class and confirm your fault path (once you add it) shows a useful message.

## Common mistakes and fixes

- **Layered automation without an inventory.** Triggers, Flows and validation rules share one transaction. List the automation per object.
- **Several Flows for the same object and timing.** Order is unpredictable. Prefer one Flow per object per timing, with clear entry conditions.
- **Hard-coded Ids and values.** Use custom metadata, as the scoring rules do.
- **Invocable methods that handle one record.** They run once per record and burn limits. Accept and return lists.
- **No fault handling.** Add fault paths in Flow and try-catch in Apex.
- **Choosing Apex too early.** Without a named reason, you have taken on code that an admin cannot maintain.

## Key takeaways

- Build with Flow first, and move to Apex for a named limit, performance or maintainability reason.
- Let Flow own the process and call an invocable Apex action for the hard calculation.
- Invocable methods take and return lists, in the same order.
- All automation on an object shares one transaction and its limits.
- Keep an inventory of automation per object.

## Where to go next

- Read [Record-triggered Flow best practices](/articles/record-triggered-flow-best-practices/) for timing, entry conditions and fault paths.
- Read [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/) for the limits these tools share.
- Read [Apex trigger handler pattern](/articles/trigger-handler-pattern/) if you decide the logic belongs in a trigger.
