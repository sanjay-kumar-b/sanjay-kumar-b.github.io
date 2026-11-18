---
title: "Record-Triggered Flow Best Practices for Admins"
description: "Before vs after save, tight entry conditions, bulk safety and fault paths, shown with two real Flows on Opportunity and an Apex bulk test."
category: salesforce-administration
tags: [Flows, Automation, Best Practices]
publishedAt: 2026-10-28
updatedAt: 2026-11-15
cover: /images/covers/record-triggered-flow-best-practices.jpg
sources:
  - title: "Salesforce Flow (Salesforce Help)"
    url: "https://help.salesforce.com/s/products/platform"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
---

Record-triggered Flows run when a record is created, updated or deleted. They are powerful, and they are easy to build in ways that cause slow saves and surprises. This article gives you seven habits, then applies them to two real Flows on Opportunity, with a bulk test that proves they hold up under a data load.

## The business scenario

Larkspur Services (a fictional consultancy) wants two automations on Opportunity. First, whenever the stage changes, stamp the date and time in a field so reports can measure how long deals sit in each stage. Second, when a deal enters the **Negotiation** stage, create a follow-up Task for the owner due in three days. Both must work when sales operations imports 200 opportunities at once, and a failure must leave a trace instead of a vague error.

## Before you start: setup

### In Salesforce

1. Create a Date/Time field `Last_Stage_Change__c` on Opportunity.
2. Create the `Integration_Error__c` object from the reliability article, or any custom object where Flow faults can be logged. It needs text fields `Source__c` and `Error__c`.
3. Make sure users who edit Opportunities can edit the new field and create Tasks. Flows run in system context by default, but know which context you choose.
4. Work in a sandbox. Open **Setup > Flows** and keep an inventory of existing automation on Opportunity (triggers, Flows, validation rules) before adding more.
5. Use **Setup > Process Automation Settings** and **Flow debug** to test before activating.

### In the external system

None. These Flows only touch Salesforce records.

## How it works

**1. Choose the right timing.**

- **Before save** updates fields on the triggering record without a separate DML. It is the fastest option for setting values.
- **After save** creates or updates related records, sends emails, calls actions or subflows.

Use before-save whenever you only change the record that fired the Flow.

**2. Set tight entry conditions.** Run only when needed. Choose "only when a record is updated to meet the condition requirements" so the Flow does not fire on every save. Fewer runs mean fewer limit hits and fewer loops.

**3. Think in bulk.** A data load can trigger the Flow for many records in one transaction. Never put Get Records, Create or Update elements inside a loop. Collect records into a collection variable and perform one operation after the loop.

**4. Add fault paths.** Connect every element that can fail (DML, callouts, actions) to a fault path. Log the error and show a meaningful message or notify an admin.

**5. Avoid loops between automations.** If a Flow updates an object that has other automation updating it back, you can create recursion. Use entry conditions that detect real changes.

**6. Name and document everything.** Use `Get_Open_Cases`, not `Get_Records_1`, and add descriptions.

**7. Test before activating.** Test with a single record and with a bulk load in a sandbox, use Flow debug, and test as a typical user, not only as an admin.

## Basic example

A before-save Flow that stamps a field is the simplest useful case. In Flow Builder: **New Flow > Record-Triggered Flow**, object Opportunity, trigger **A record is updated**, condition `StageName` **Is Changed** equals True, and optimise for **Fast Field Updates**. Add one **Assignment** that sets `$Record.Last_Stage_Change__c` to `$Flow.CurrentDateTime`. There is no Update Records element: before-save changes are saved with the record.

## Advanced end-to-end example

**force-app/main/default/flows/Opp_Stamp_Stage_Change.flow-meta.xml** (before save)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Opp Stamp Stage Change</label>
    <description>Before save: records when the stage last changed.</description>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <assignments>
        <name>Set_Stamp</name>
        <label>Set Stamp</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <assignmentItems>
            <assignToReference>$Record.Last_Stage_Change__c</assignToReference>
            <operator>Assign</operator>
            <value>
                <elementReference>$Flow.CurrentDateTime</elementReference>
            </value>
        </assignmentItems>
    </assignments>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Set_Stamp</targetReference>
        </connector>
        <doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>
        <filterLogic>and</filterLogic>
        <filters>
            <field>StageName</field>
            <operator>IsChanged</operator>
            <value>
                <booleanValue>true</booleanValue>
            </value>
        </filters>
        <object>Opportunity</object>
        <recordTriggerType>Update</recordTriggerType>
        <triggerType>RecordBeforeSave</triggerType>
    </start>
</Flow>
```

**force-app/main/default/flows/Opp_Negotiation_Follow_Up.flow-meta.xml** (after save, with a fault path)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Opp Negotiation Follow Up</label>
    <description>After save: creates one follow-up Task when a deal enters Negotiation. Faults are logged.</description>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <formulas>
        <name>DueDate</name>
        <dataType>Date</dataType>
        <expression>{!$Flow.CurrentDate} + 3</expression>
    </formulas>
    <recordCreates>
        <name>Create_Follow_Up_Task</name>
        <label>Create Follow Up Task</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <faultConnector>
            <targetReference>Log_Fault</targetReference>
        </faultConnector>
        <inputAssignments>
            <field>ActivityDate</field>
            <value>
                <elementReference>DueDate</elementReference>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>OwnerId</field>
            <value>
                <elementReference>$Record.OwnerId</elementReference>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>Subject</field>
            <value>
                <stringValue>Follow up: negotiation started</stringValue>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>WhatId</field>
            <value>
                <elementReference>$Record.Id</elementReference>
            </value>
        </inputAssignments>
        <object>Task</object>
    </recordCreates>
    <recordCreates>
        <name>Log_Fault</name>
        <label>Log Fault</label>
        <locationX>440</locationX>
        <locationY>395</locationY>
        <inputAssignments>
            <field>Error__c</field>
            <value>
                <elementReference>$Flow.FaultMessage</elementReference>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>Source__c</field>
            <value>
                <stringValue>flow:Opp_Negotiation_Follow_Up</stringValue>
            </value>
        </inputAssignments>
        <object>Integration_Error__c</object>
    </recordCreates>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Create_Follow_Up_Task</targetReference>
        </connector>
        <doesRequireRecordChangedToMeetCriteria>true</doesRequireRecordChangedToMeetCriteria>
        <filterLogic>and</filterLogic>
        <filters>
            <field>StageName</field>
            <operator>EqualTo</operator>
            <value>
                <stringValue>Negotiation</stringValue>
            </value>
        </filters>
        <object>Opportunity</object>
        <recordTriggerType>CreateAndUpdate</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
</Flow>
```

Both Flows are saved as Draft so you can open them in Flow Builder, check them, and activate them yourself. If either fails to deploy, rebuild it in Flow Builder with the same elements; the logic matters more than the XML.

**force-app/main/default/classes/OpportunityFlowBulkTest.cls** (run after activating both Flows)

```apex
@IsTest
private class OpportunityFlowBulkTest {

    private static List<Opportunity> makeOpps(Integer count, String stage) {
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < count; i++) {
            opps.add(new Opportunity(
                Name = 'Deal ' + i, StageName = stage, CloseDate = Date.today().addDays(30)
            ));
        }
        return opps;
    }

    @IsTest
    static void stageChangeIsStampedForTwoHundredRecords() {
        List<Opportunity> opps = makeOpps(200, 'Prospecting');
        insert opps;
        for (Opportunity o : opps) {
            o.StageName = 'Qualification';
        }
        Test.startTest();
        update opps;
        Test.stopTest();
        System.assertEquals(200, [SELECT COUNT() FROM Opportunity WHERE Last_Stage_Change__c != null]);
    }

    @IsTest
    static void negotiationCreatesOneTaskPerDeal() {
        List<Opportunity> opps = makeOpps(200, 'Prospecting');
        insert opps;
        for (Opportunity o : opps) {
            o.StageName = 'Negotiation';
        }
        Test.startTest();
        update opps;
        Test.stopTest();
        System.assertEquals(200, [SELECT COUNT() FROM Task WHERE Subject = 'Follow up: negotiation started']);
    }

    @IsTest
    static void unrelatedEditDoesNotCreateTasks() {
        List<Opportunity> opps = makeOpps(5, 'Negotiation');
        insert opps;
        Integer before = [SELECT COUNT() FROM Task];
        for (Opportunity o : opps) {
            o.Description = 'Notes only';
        }
        update opps;
        System.assertEquals(before, [SELECT COUNT() FROM Task], 'Entry condition stops reruns');
    }
}
```

To keep the automation inventory honest, list the active Flows from the command line with the Salesforce CLI instead of clicking through Setup:

```bash
sf data query --target-org mysandbox --query \
  "SELECT ApiName, Label, ProcessType, TriggerType, TriggerObjectOrEventLabel FROM FlowDefinitionView WHERE IsActive = true ORDER BY TriggerObjectOrEventLabel"
```

Paste the result into your team wiki and update it whenever a Flow is added. Field names on this view can change between releases, so if the query errors, run it in the Developer Console query editor and adjust.

## What happens behind the scenes

Salesforce runs automation in a fixed order for each save: before-save flows and triggers, validation, the save itself, after-save triggers and flows, then later steps. A before-save flow changes the record's field values in memory before it is written, which is why it needs no DML and is the cheapest option. An after-save flow runs once the record exists and has an Id, so it can create related records that point back to it.

The platform groups the records of a transaction. With 200 opportunities, the flow engine bundles the interviews so that the Create Records element runs as one DML of up to 200 Tasks, not 200 DMLs. This bulkification works only when the Flow does not use Get, Create or Update inside a loop, because those elements would then run once per iteration and add up against the limits.

The setting **Is Changed** with "only when a record is updated to meet the criteria" makes the platform compare the old and new values. Without it, an unrelated edit to a Negotiation deal would create another Task every time, which is exactly what the third test guards against.

## Test it and verify

1. Deploy the field, the logging object, the two Flows and the test class. Open each Flow and **Activate** it in the sandbox.
2. Run `OpportunityFlowBulkTest` and confirm all three tests pass.
3. Edit an Opportunity's stage by hand. Confirm `Last_Stage_Change__c` updates and a Task appears only on the move into Negotiation.
4. Use Flow debug on one record and step through each branch.
5. Revoke Task create access for a test user, if the Flow runs in user context, and confirm an `Integration_Error__c` row appears instead of a generic error.
6. Load 200 records from CSV and watch for limit errors.

## Common mistakes and fixes

- **After-save for a same-record update.** It costs an extra DML. Use before-save.
- **Broad entry conditions.** The Flow runs on every save and creates duplicates. Use Is Changed conditions.
- **Get Records or Update inside a loop.** One data load hits the limit. Collect into a collection and operate once.
- **No fault path.** Users see "An unhandled fault has occurred". Log and notify instead.
- **Two automations updating each other.** They loop. Keep an inventory and detect real change.
- **Default element names.** `Get_Records_1` explains nothing. Use descriptive names.

## Key takeaways

- Before save for same-record field updates, after save for related records and actions.
- Tight entry conditions with Is Changed prevent reruns.
- Keep queries and DML out of loops.
- Every risky element gets a fault path.
- Test with one record, with 200, and as a normal user, in a sandbox.

## Where to go next

- Read [Flow vs Apex](/articles/flow-vs-apex/) to decide when a Flow is not enough.
- Read [Bulkify Apex triggers](/articles/bulkify-apex-triggers/) for the same ideas in code.
- Read [Validation rule patterns](/articles/validation-rule-patterns/) for the rules that run alongside your Flows.
