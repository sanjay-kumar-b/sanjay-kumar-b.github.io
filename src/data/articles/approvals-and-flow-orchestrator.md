---
title: "Approval Processes and Flow Orchestrator: Multi-Step Approvals with Apex and Tests"
description: "Build approvals the Salesforce way: approval processes, submitting and deciding in Apex, and Flow Orchestrator stages for multi-team workflows, with tests."
category: salesforce-administration
tags: [Approvals, Flow Orchestrator, Apex, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce Help: Approvals"
    url: "https://help.salesforce.com/s/articleView?id=sf.approvals_overview.htm"
  - title: "Salesforce Help: Flow Orchestrator"
    url: "https://help.salesforce.com/s/articleView?id=sf.orchestrator_overview.htm"
---

Business processes often need a person to say yes before work continues. Salesforce has two tools for this: **approval processes** for a decision on one record, and **Flow Orchestrator** for work that moves through several stages and teams. This article explains both, shows how to drive approvals from Apex, and tests the logic around them.

> The approval process XML below follows the metadata structure but is easiest to create in Setup and retrieve with the CLI. Confirm element names against your org. The Apex and its tests rely on that process being deployed and active.

## The business scenario

Juniper Consulting lets sales reps give discounts on opportunities. Up to 10 percent needs no approval. From 10 to 20 percent the rep's **manager** must approve. Above 20 percent the **finance director** must approve as well. Reps need a button to submit, managers need to approve from email or Salesforce, nobody should edit a record while it is locked in approval, and the audit trail must show who decided and when. Later the company wants a larger onboarding journey (legal review, finance setup, provisioning) that spans teams, which is a job for Orchestrator.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox with the Salesforce CLI and VS Code connected.
2. **Create fields on Opportunity:** `Discount_Percent__c` (Percent 5,2) and `Approval_Status__c` (Picklist: Draft, Pending, Approved, Rejected; default Draft).
3. **Set up the role hierarchy or manager field.** The approval below sends to the submitter's **manager**, so each user needs a Manager set on the user record (Setup, Users).
4. **Enable email approval and Chatter/Slack notifications** if you want approvers to respond outside Salesforce. Check **Setup, Approval Settings**.
5. **Create the approval process** (Setup, Approval Processes, Create New, then Jump Start or Standard): object Opportunity, entry criteria `Discount_Percent__c > 10`, first step approver "Manager", record editability "Administrators only", and a final step for finance when `Discount_Percent__c > 20`. Name it `Discount_Approval`.
6. **Create a queue or public group** for finance approvers, so the step does not point at one person who may be on leave.
7. **Test users:** at least a rep, a manager and a finance director, each with the right permission set.
8. For orchestration, make sure **Flow Orchestrator** is available in your edition and your user can create flows.

### In the external system

If approvals must be visible elsewhere (a Slack channel, a finance system), send a **platform event** when the status changes and let the other system subscribe, instead of polling. Agree the payload (record id, status, approver, time) in advance.

## How it works

An **approval process** defines: which records enter (entry criteria), who may submit, a series of **steps** (each with approvers and rules for what happens if criteria differ or approvers do not respond), and **actions** on submission, approval and rejection (field updates, emails, tasks). While a record is in approval it can be **locked**.

The data behind it is stored in standard objects: `ProcessInstance` (one per submission), `ProcessInstanceStep` (each decision) and `ProcessInstanceWorkitem` (a pending item waiting for an approver). Apex uses two request classes: `Approval.ProcessSubmitRequest` to submit and `Approval.ProcessWorkitemRequest` to approve, reject or reassign.

**Flow Orchestrator** coordinates work across **stages** (a stage groups steps), where each step is either **interactive** (a screen flow assigned to a user or queue) or **background** (an autolaunched flow that runs automatically). Steps in a stage can run in parallel or in order; a stage's exit criteria decide when the next stage starts. Choose it when a process crosses teams and you need to see where it is stuck.

Rule of thumb: **one decision on one record** is an approval process. **A journey of several tasks and decisions** is Orchestrator.

## Basic example

Submit a record for approval and approve it, in the smallest form:

```apex
// Submit
Approval.ProcessSubmitRequest submit = new Approval.ProcessSubmitRequest();
submit.setObjectId(opportunityId);
submit.setProcessDefinitionNameOrId('Discount_Approval');
submit.setSkipEntryCriteria(false);
Approval.ProcessResult result = Approval.process(submit);
System.debug(result.isSuccess() + ' ' + result.getInstanceStatus());

// Approve the pending work item
ProcessInstanceWorkitem item = [
    SELECT Id FROM ProcessInstanceWorkitem
    WHERE ProcessInstance.TargetObjectId = :opportunityId
    LIMIT 1
];
Approval.ProcessWorkitemRequest decision = new Approval.ProcessWorkitemRequest();
decision.setWorkitemId(item.Id);
decision.setAction('Approve');
decision.setComments('Looks fine.');
Approval.process(decision);
```

## Advanced end-to-end example

We keep the **routing rule** in plain Apex (so it is testable with no org setup), wrap submission and decisions in a service, and prove the whole path with users and a manager.

**force-app/main/default/classes/DiscountRouting.cls**

```apex
public with sharing class DiscountRouting {

    public enum Route { NONE, MANAGER, MANAGER_AND_FINANCE }

    public static final Decimal AUTO_LIMIT = 10;
    public static final Decimal MANAGER_LIMIT = 20;

    public static Route routeFor(Decimal percent) {
        if (percent == null || percent < 0 || percent > 100) {
            throw new IllegalArgumentException('Discount must be between 0 and 100.');
        }
        if (percent <= AUTO_LIMIT) {
            return Route.NONE;
        }
        return percent <= MANAGER_LIMIT ? Route.MANAGER : Route.MANAGER_AND_FINANCE;
    }
}
```

**force-app/main/default/classes/DiscountApprovalService.cls**

```apex
public with sharing class DiscountApprovalService {

    public class ApprovalException extends Exception {}

    public static final String PROCESS_NAME = 'Discount_Approval';

    // Submits the opportunity if its discount needs approval.
    public static String submit(Id opportunityId, String comments) {
        Opportunity opp = [
            SELECT Id, Discount_Percent__c, Approval_Status__c
            FROM Opportunity WHERE Id = :opportunityId WITH USER_MODE
        ];
        if (opp.Approval_Status__c == 'Pending') {
            throw new ApprovalException('This opportunity is already waiting for approval.');
        }
        if (DiscountRouting.routeFor(opp.Discount_Percent__c) == DiscountRouting.Route.NONE) {
            opp.Approval_Status__c = 'Approved';
            update as user opp;
            return 'Auto-approved';
        }

        opp.Approval_Status__c = 'Pending';
        update as user opp;

        Approval.ProcessSubmitRequest request = new Approval.ProcessSubmitRequest();
        request.setObjectId(opp.Id);
        request.setProcessDefinitionNameOrId(PROCESS_NAME);
        request.setSkipEntryCriteria(false);
        request.setComments(comments);
        Approval.ProcessResult result = Approval.process(request);
        if (!result.isSuccess()) {
            throw new ApprovalException('Submission failed.');
        }
        return result.getInstanceStatus();
    }

    public static List<ProcessInstanceWorkitem> pendingItems(Id opportunityId) {
        return [
            SELECT Id, ActorId
            FROM ProcessInstanceWorkitem
            WHERE ProcessInstance.TargetObjectId = :opportunityId
              AND ProcessInstance.Status = 'Pending'
        ];
    }

    public static void decide(Id opportunityId, Boolean approve, String comments) {
        List<ProcessInstanceWorkitem> items = pendingItems(opportunityId);
        if (items.isEmpty()) {
            throw new ApprovalException('Nothing is waiting for a decision on this record.');
        }
        Approval.ProcessWorkitemRequest request = new Approval.ProcessWorkitemRequest();
        request.setWorkitemId(items[0].Id);
        request.setAction(approve ? 'Approve' : 'Reject');
        request.setComments(comments);
        Approval.process(request);

        Opportunity opp = [SELECT Id, Approval_Status__c FROM Opportunity WHERE Id = :opportunityId];
        List<ProcessInstanceWorkitem> remaining = pendingItems(opportunityId);
        if (!approve) {
            opp.Approval_Status__c = 'Rejected';
        } else if (remaining.isEmpty()) {
            opp.Approval_Status__c = 'Approved';
        }
        update opp;
    }
}
```

**force-app/main/default/classes/DiscountApprovalTest.cls**

```apex
@IsTest
private class DiscountApprovalTest {

    private static User makeUser(String alias, Id managerId) {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        return new User(
            Alias = alias, Email = alias + '@example.com', EmailEncodingKey = 'UTF-8',
            LastName = alias, LanguageLocaleKey = 'en_US', LocaleSidKey = 'en_US',
            ProfileId = p.Id, TimeZoneSidKey = 'Asia/Kolkata', ManagerId = managerId,
            Username = alias + System.currentTimeMillis() + '@example.com'
        );
    }

    @IsTest
    static void routingFollowsTheThresholds() {
        System.assertEquals(DiscountRouting.Route.NONE, DiscountRouting.routeFor(10));
        System.assertEquals(DiscountRouting.Route.MANAGER, DiscountRouting.routeFor(10.01));
        System.assertEquals(DiscountRouting.Route.MANAGER, DiscountRouting.routeFor(20));
        System.assertEquals(DiscountRouting.Route.MANAGER_AND_FINANCE, DiscountRouting.routeFor(25));
    }

    @IsTest
    static void routingRejectsImpossibleValues() {
        for (Decimal bad : new List<Decimal>{ -1, 101, null }) {
            try {
                DiscountRouting.routeFor(bad);
                System.assert(false, 'Expected an exception for ' + bad);
            } catch (IllegalArgumentException e) {
                System.assert(e.getMessage().contains('between 0 and 100'));
            }
        }
    }

    @IsTest
    static void smallDiscountsAreApprovedAutomatically() {
        Opportunity opp = new Opportunity(Name = 'Small', StageName = 'Prospecting',
            CloseDate = Date.today().addDays(10), Discount_Percent__c = 5);
        insert opp;
        System.assertEquals('Auto-approved', DiscountApprovalService.submit(opp.Id, 'x'));
        System.assertEquals('Approved', [SELECT Approval_Status__c FROM Opportunity WHERE Id = :opp.Id].Approval_Status__c);
    }

    @IsTest
    static void managerApprovalEndToEnd() {
        User manager = makeUser('mgr', null);
        insert manager;
        User rep = makeUser('rep', manager.Id);
        insert rep;

        Opportunity opp;
        System.runAs(rep) {
            opp = new Opportunity(Name = 'Mid', StageName = 'Prospecting',
                CloseDate = Date.today().addDays(10), Discount_Percent__c = 15);
            insert opp;
            DiscountApprovalService.submit(opp.Id, 'Please approve');
        }
        System.assertEquals('Pending', [SELECT Approval_Status__c FROM Opportunity WHERE Id = :opp.Id].Approval_Status__c);
        System.assertEquals(1, DiscountApprovalService.pendingItems(opp.Id).size());

        System.runAs(manager) {
            DiscountApprovalService.decide(opp.Id, true, 'OK');
        }
        System.assertEquals('Approved', [SELECT Approval_Status__c FROM Opportunity WHERE Id = :opp.Id].Approval_Status__c);
    }

    @IsTest
    static void rejectionSetsTheStatus() {
        User manager = makeUser('mgr2', null);
        insert manager;
        User rep = makeUser('rep2', manager.Id);
        insert rep;
        Opportunity opp;
        System.runAs(rep) {
            opp = new Opportunity(Name = 'Mid', StageName = 'Prospecting',
                CloseDate = Date.today().addDays(10), Discount_Percent__c = 15);
            insert opp;
            DiscountApprovalService.submit(opp.Id, 'Please approve');
        }
        System.runAs(manager) {
            DiscountApprovalService.decide(opp.Id, false, 'Too generous');
        }
        System.assertEquals('Rejected', [SELECT Approval_Status__c FROM Opportunity WHERE Id = :opp.Id].Approval_Status__c);
    }

    @IsTest
    static void decidingWithNothingPendingFails() {
        Opportunity opp = new Opportunity(Name = 'None', StageName = 'Prospecting',
            CloseDate = Date.today().addDays(10), Discount_Percent__c = 5);
        insert opp;
        try {
            DiscountApprovalService.decide(opp.Id, true, '');
            System.assert(false, 'Expected an exception');
        } catch (DiscountApprovalService.ApprovalException e) {
            System.assert(e.getMessage().contains('Nothing is waiting'));
        }
    }
}
```

**force-app/main/default/approvalProcesses/Opportunity.Discount_Approval.approvalProcess-meta.xml** (retrieve the real one from Setup; this shows the shape)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ApprovalProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <allowRecall>true</allowRecall>
    <allowedSubmitters>
        <type>owner</type>
    </allowedSubmitters>
    <approvalPageFields>
        <field>Name</field>
        <field>Owner</field>
        <field>Amount</field>
        <field>Discount_Percent__c</field>
    </approvalPageFields>
    <approvalStep>
        <allowDelegate>false</allowDelegate>
        <assignedApprover>
            <approver>
                <name>Manager</name>
                <type>relatedUserField</type>
            </approver>
            <whenMultipleApprovers>FirstResponse</whenMultipleApprovers>
        </assignedApprover>
        <label>Manager approval</label>
        <name>Manager_approval</name>
    </approvalStep>
    <description>Discounts above 10 percent need the submitter's manager.</description>
    <emailTemplate></emailTemplate>
    <enableMobileDeviceAccess>false</enableMobileDeviceAccess>
    <entryCriteria>
        <formula>Discount_Percent__c &gt; 10</formula>
    </entryCriteria>
    <label>Discount Approval</label>
    <processOrder>1</processOrder>
    <recordEditability>AdminOnly</recordEditability>
    <showApprovalHistory>true</showApprovalHistory>
</ApprovalProcess>
```

For the **onboarding journey**, build an orchestration in Flow Builder (**New Flow, Orchestration**) with this outline, and keep each step's logic in a small autolaunched or screen flow:

```yaml
orchestration: Customer Onboarding
stages:
  - name: Legal review
    steps:
      - {name: Contract check, type: interactive, assignee: Legal queue, flow: Review_Contract}
  - name: Finance setup
    runs: after Legal review
    steps:
      - {name: Create billing account, type: background, flow: Create_Billing_Account}
      - {name: Approve credit limit, type: interactive, assignee: Finance directors, flow: Approve_Credit}
  - name: Provisioning
    runs: after Finance setup
    steps:
      - {name: Create workspace, type: background, flow: Provision_Workspace}
      - {name: Welcome call, type: interactive, assignee: Opportunity owner, flow: Schedule_Welcome}
```

That outline is a planning aid, not deployable metadata: Orchestrator is designed visually, then retrieved.

Deploy and test:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names DiscountApprovalTest --result-format human --wait 10 --target-org dev
```

## What happens behind the scenes

When `Approval.process` receives a submit request, the platform checks the entry criteria, creates a `ProcessInstance` for the record, and creates a `ProcessInstanceWorkitem` for each approver of the first step. If the process is set to lock records, the record becomes read-only to everyone but administrators and approvers. The submitter sees the status in the Approval History related list.

When an approver acts, the platform records a `ProcessInstanceStep` with the decision and comments, removes the work item, and either moves to the next step (creating new work items), or finishes the process and runs the final approval or rejection actions, then unlocks the record. In `DiscountApprovalService.decide` the extra status update reads whether work items remain, because approval of the first step of a multi-step process should not mark the record Approved yet.

Using `System.runAs` in the test matters: the platform checks that the user acting on a work item is the assigned approver. Setting `ManagerId` on the rep makes the manager the approver for the "Manager" related-user step. The tests do not run in system context for the decision, so they prove the real permission behaviour.

Orchestrator works differently: it is a flow that the platform keeps alive for days or weeks. Each interactive step creates an assignment shown in the assignee's **Work Guide** (or a Flow task), and the orchestration records which step each run is at. Because every step is its own flow, you can change one step without touching the others, and the orchestration run gives you a single place to see where a journey is blocked.

## Test it and verify

1. Run the five tests and confirm they pass.
2. In the org, set the discount to 5, then 15, then 25 on test opportunities and submit each. Confirm that only 15 and 25 appear in the approver's list of items to approve.
3. Approve as the manager and open **Approval History** to see the step, approver and comments.
4. Reject one and confirm that `Approval_Status__c` is Rejected and the record can be edited again.
5. Try editing a pending opportunity as the rep and confirm that the lock blocks the change.
6. Build the orchestration in a sandbox with dummy flows, start a run, and watch it advance stage by stage.

## Common mistakes and fixes

- **No approver for the step.** If the manager field is empty the submission fails; check users first.
- **Testing without `runAs`.** The decision must come from the approver, not from the admin running tests.
- **Hard-coding approvers.** Use manager fields, queues or public groups, so people can change jobs.
- **Forgetting multi-step status.** Approving step one is not final approval.
- **Editing locked records in code.** Updates from a user without permission fail; plan for it.
- **Using Orchestrator for a single yes or no.** An approval process is simpler.
- **Building a giant flow instead of stages.** Use stages and small step flows for clarity.

## Key takeaways

- An approval process handles a decision on one record; Orchestrator handles multi-team journeys.
- Apex submits with `ProcessSubmitRequest` and decides with `ProcessWorkitemRequest`.
- Keep routing rules in plain Apex so you can test them.
- Test with real users using `System.runAs`.
- Use queues and manager fields, not named people.

## Where to go next

- Read [Flow types: screen, scheduled and autolaunched](/articles/flow-types-screen-scheduled-autolaunched/) for the flows used as steps.
- Read [Apex test classes best practices](/articles/apex-test-classes-best-practices/) for creating users and data.
- Read [The Salesforce sharing model explained](/articles/sharing-model-explained/) for who can see locked records.
