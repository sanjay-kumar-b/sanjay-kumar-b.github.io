---
title: "Advanced Apex Triggers: Order of Execution, Recursion, Bypass and Async Handoff"
description: "Go deeper on triggers: the save order, recursion and re-entrancy, mixed DML, async handoff, platform events and partial-success DML in an order-to-cash build."
category: salesforce-development
tags: [Apex, Triggers, Advanced, Architecture]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/apex-triggers-advanced.jpg
sources:
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm"
  - title: "Trigger Context Variables (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_triggers_context_variables.htm"
  - title: "sObjects That Cannot Be Used Together in DML Operations (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_dml_non_mix_sobjects.htm"
  - title: "Subscribe to Platform Events with Apex Triggers (Platform Events Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/platform_events_subscribe_apex.htm"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

A basic trigger reads `Trigger.new`, changes a field and finishes. A production trigger lives in a crowded transaction. Flows run before and after it. Roll-up summary fields update parent records behind its back. Its own updates fire the same trigger again. Some DML is forbidden next to other DML, callouts are forbidden outright, and one bad record can sink a whole batch unless you handle it.

This article covers those hard parts. It assumes you can already write a bulk-safe trigger and use a handler class; if not, read [Apex triggers from scratch](/articles/apex-triggers-from-scratch/) and [Trigger handler pattern](/articles/trigger-handler-pattern/) first. Here we build a full order-to-cash flow and use it to explain the save order, re-entrancy, mixed DML, async handoff, platform events and partial-success DML.

## The business scenario

Brightforge Components (a fictional industrial manufacturer) takes orders from distributors. Three custom objects model the flow:

- **Sales Order** (`Sales_Order__c`): one per customer order, with a status of Draft, Approved, Shipped, Invoiced or Invoice_Failed.
- **Sales Order Item** (`Sales_Order_Item__c`): one per product line, child of the order in a master-detail relationship. A roll-up summary on the order adds up the line totals.
- **Invoice** (`Invoice__c`): created when an order ships, then sent to the finance team's ERP system.

The rules:

1. An item's line total is quantity times unit price, less any discount.
2. An order cannot ship unless its total is above zero.
3. Approving an order of 100,000 or more flags it for finance review and gives its owner a permission set that opens the invoice records.
4. Shipping an order creates its invoice. If the Account has no billing email, only that one invoice fails. The other orders in the same load still get theirs.
5. Each new invoice is pushed to the ERP over HTTPS. Triggers cannot call out, so this must happen asynchronously.
6. Every invoice failure raises a platform event. A subscriber opens a Case for finance operations.
7. An admin can switch each object's automation off without a deployment.

Each rule maps to a hard topic. Rule 2 needs the roll-up value to be current. Rule 3 hits mixed DML. Rule 4 needs `allOrNone=false`. Rule 5 needs an async handoff. Rule 6 uses event triggers.

## Before you start: setup

You need a Developer Edition org or scratch org, not production. Menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In Salesforce

1. **Create the custom objects and fields.** Setup, Object Manager, Create, Custom Object. Why: the code references them by API name. Verify: each object shows in the App Launcher's All Items.

   | Object | Field (API name) | Type |
   |---|---|---|
   | Sales_Order__c | Account__c | Lookup(Account) |
   | Sales_Order__c | Status__c | Picklist: Draft, Approved, Shipped, Invoiced, Invoice_Failed |
   | Sales_Order__c | Needs_Finance_Review__c | Checkbox |
   | Sales_Order__c | Total_Amount__c | Roll-up Summary, SUM of Line_Total__c |
   | Sales_Order_Item__c | Sales_Order__c | Master-Detail(Sales Order) |
   | Sales_Order_Item__c | Quantity__c, Unit_Price__c, Line_Total__c | Number, Currency, Currency |
   | Invoice__c | Sales_Order__c | Lookup(Sales Order) |
   | Invoice__c | Invoice_Key__c | Text(30), External ID, Unique |
   | Invoice__c | Amount__c | Currency |
   | Invoice__c | Status__c | Picklist: Pending (default), Sent, Failed |
   | Invoice__c | Bill_To_Email__c | Email, **Required** |
   | Invoice__c | Failure_Reason__c | Text(255) |

   Create the roll-up after the item object exists. Add a custom Email field `Billing_Email__c` to Account too.
2. **Create the platform event `Invoice_Failure__e`.** Setup, Platform Events, New. Add Text fields `Order_Id__c` (18) and `Reason__c` (255). Set Publish Behavior to **Publish Immediately**. Why: the failure event must leave even if the publishing transaction rolls back. Verify: the event appears under Platform Events.
3. **Create the Custom Metadata Type `Automation_Switch__mdt`** with a checkbox `Is_Disabled__c`. Add two records named `Sales_Order` and `Invoice`. Why: admins flip these to pause a trigger. Verify: `SELECT DeveloperName, Is_Disabled__c FROM Automation_Switch__mdt` returns two rows.
4. **Create the permission set `Large_Order_Reviewer`** (API name exact) with read access to Invoice. Why: the Queueable assigns it. Verify: it shows in Permission Sets.
5. **Create the Named Credential for the ERP.** Setup, Named Credentials, External Credentials tab: create `Brightforge_ERP_Auth` with a principal holding an API key parameter, and a custom header `X-Api-Key` that reads it. Then create a Named Credential `Brightforge_ERP` with the ERP base URL. Grant the principal to your user through a permission set. Why: Apex runs the callout as the user who enqueued the job, so that user needs principal access. Never put the key in Apex. Verify: Setup shows both records and your permission set lists the external credential principal.
6. **Add the optional flow** (see the Flow coexistence section later): a before-save record-triggered flow on Sales Order.

### In the external system

1. **Get an ERP sandbox endpoint and key.** Create an API key in the ERP's developer console, with write scope for invoices only. Why: least privilege. Verify: a `curl` with the key to the sandbox returns 200.
2. **No endpoint yet?** Any HTTPS service that accepts a POST and returns 200 works for this exercise. Unit tests use a mock and never call it.

### On your machine

Install Salesforce CLI (`sf`) and VS Code with the Salesforce extensions. Verify: `sf --version` prints a version, and `sf org login web` connects your org.

## How it works

The platform saves a record in a fixed sequence. In outline (the full numbered list is in the Apex Developer Guide):

1. Load the original record, apply the new values, run request-level validation.
2. Run **before-save flows**.
3. Run **before triggers**.
4. Run system validation again, then your validation rules, then duplicate rules.
5. Save to the database. This is not a commit.
6. Run **after triggers**.
7. Run assignment, auto-response, workflow and escalation rules, then Process Builder and **after-save flows**.
8. Recalculate **roll-up summary fields** on the parent.
9. Run criteria-based sharing, **commit**, then post-commit work: emails and enqueued async jobs.

Three consequences drive everything below.

**Before triggers can edit records, after triggers cannot.** In a before trigger, changes to `Trigger.new` are saved for free, with no DML. In an after trigger the records are read-only. To change the same record from an after trigger you issue DML on a new instance, which fires the triggers again. That is re-entrancy.

**Flows and triggers share one transaction and one set of limits.** A before-save flow runs first, so your before trigger sees the flow's field values. An after-save flow that updates the record runs after your after trigger and can re-fire it.

**Workflow field updates and roll-ups re-fire triggers.** If a workflow field update changes the record, before and after update triggers run one more time, only once more. When a roll-up changes a parent, the parent's triggers run too. During a recursive save the platform skips some later steps (assignment rules through roll-up recalculation, per the docs).

### Trigger context subtleties

| Variable | Insert | Update | Delete |
|---|---|---|---|
| `Trigger.new` | yes | yes | null |
| `Trigger.old` and `oldMap` | null | yes | yes |
| `Trigger.newMap` | after only | yes | null |
| Edit `Trigger.new` directly | before only | before only | not allowed |

In a before insert trigger the records have no Id yet, so there is no `newMap`. A roll-up field on a record already in the database is readable in `Trigger.new`, but it holds the value from the last save. Compare against `oldMap` to find real changes, as the code does.

Two more limits to remember. A trigger processes up to 200 records per chunk, but platform event and Change Data Capture triggers receive up to 2,000. A Queueable chain is not allowed to flood: a synchronous transaction may enqueue up to 50 jobs, and an asynchronous one only 1.

### Partial-success DML and retries

`Database.insert(records, false)` (the `allOrNone` flag) lets good records save while bad ones return errors in the result list, in the same order as the input. The catch, from the order-of-execution docs: when a partial-success save drops failed records, the platform re-runs the save for the survivors, so triggers can fire again in the same transaction and static variables are not reset. Never put a static guard in a before trigger that does non-idempotent work. Our guard lives only in after logic.

## Basic example

The smallest useful advanced trigger guards one transition and hands slow work off. This runs on Sales Order.

```apex
trigger SalesOrderTrigger on Sales_Order__c (before insert, before update, after update) {
    if (Trigger.isBefore) {
        for (Sales_Order__c o : Trigger.new) {
            // Before trigger: edit the record directly, no DML needed.
            Boolean changed = Trigger.isInsert
                || o.Status__c != Trigger.oldMap.get(o.Id).Status__c;
            if (changed && o.Status__c == 'Shipped'
                && (o.Total_Amount__c == null || o.Total_Amount__c <= 0)) {
                o.addError('An order needs at least one priced item before it ships.');
            }
        }
    }
}
```

Expected result: moving an empty order to Shipped shows the error on the record page, and a data load row fails with that message while other rows succeed (with partial success on). The advanced example moves this logic into a handler and adds the rest.

## Advanced end-to-end example

The files below form one deployable project. Triggers stay one line long. The handler does the routing. Services own DML, and one small selector owns the query.

**`force-app/main/default/triggers/SalesOrderTrigger.trigger`**

```apex
trigger SalesOrderTrigger on Sales_Order__c (before insert, before update, after update) {
    SalesOrderTriggerHandler.run();
}
```

**`force-app/main/default/triggers/SalesOrderItemTrigger.trigger`**

```apex
trigger SalesOrderItemTrigger on Sales_Order_Item__c (before insert, before update) {
    for (Sales_Order_Item__c item : Trigger.new) {
        Decimal qty = item.Quantity__c == null ? 0 : item.Quantity__c;
        Decimal price = item.Unit_Price__c == null ? 0 : item.Unit_Price__c;
        item.Line_Total__c = qty * price; // saved with the record, no DML
    }
}
```

**`force-app/main/default/triggers/InvoiceTrigger.trigger`**

```apex
trigger InvoiceTrigger on Invoice__c (after insert) {
    InvoiceTriggerHandler.run();
}
```

**`force-app/main/default/triggers/InvoiceFailureTrigger.trigger`**

```apex
trigger InvoiceFailureTrigger on Invoice_Failure__e (after insert) {
    InvoiceFailureHandler.run(Trigger.new);
}
```

**`force-app/main/default/classes/AutomationSwitch.cls`**

The bypass has two levels: a Custom Metadata record for admins, and a transaction-only set for code such as data-fix scripts.

```apex
public with sharing class AutomationSwitch {
    private static final Set<String> TRANSACTION_OFF = new Set<String>();

    public static Boolean isOff(String key) {
        if (TRANSACTION_OFF.contains(key)) {
            return true;
        }
        Automation_Switch__mdt setting = Automation_Switch__mdt.getInstance(key);
        return setting != null && setting.Is_Disabled__c == true;
    }

    public static void disableForTransaction(String key) {
        TRANSACTION_OFF.add(key);
    }

    public static void enableForTransaction(String key) {
        TRANSACTION_OFF.remove(key);
    }
}
```

**`force-app/main/default/classes/TransitionGuard.cls`**

The guard remembers a step, a record and the new value, not just the record. The same order can legitimately move to a different status later in the transaction.

```apex
public class TransitionGuard {
    private static final Set<String> SEEN = new Set<String>();

    // Returns true the first time a step is seen for this record and value.
    public static Boolean firstTime(String step, Id recordId, String value) {
        return SEEN.add(step + ':' + recordId + ':' + value);
    }

    @TestVisible
    private static void reset() {
        SEEN.clear();
    }
}
```

**`force-app/main/default/classes/SalesOrderTriggerHandler.cls`**

```apex
public with sharing class SalesOrderTriggerHandler {
    public static final Decimal LARGE_ORDER_THRESHOLD = 100000;

    public static void run() {
        if (AutomationSwitch.isOff('Sales_Order')) {
            return;
        }
        Map<Id, Sales_Order__c> oldMap = (Map<Id, Sales_Order__c>) Trigger.oldMap;
        if (Trigger.isBefore) {
            beforeSave((List<Sales_Order__c>) Trigger.new, oldMap);
        } else if (Trigger.isAfter && Trigger.isUpdate) {
            afterUpdate((List<Sales_Order__c>) Trigger.new, oldMap);
        }
    }

    private static Boolean statusChanged(Sales_Order__c o, Map<Id, Sales_Order__c> oldMap) {
        return oldMap == null || !oldMap.containsKey(o.Id)
            || o.Status__c != oldMap.get(o.Id).Status__c;
    }

    private static void beforeSave(List<Sales_Order__c> orders, Map<Id, Sales_Order__c> oldMap) {
        for (Sales_Order__c o : orders) {
            if (!statusChanged(o, oldMap)) {
                continue;
            }
            if (o.Status__c == 'Shipped'
                && (o.Total_Amount__c == null || o.Total_Amount__c <= 0)) {
                o.addError('An order needs at least one priced item before it ships.');
            }
            if (o.Status__c == 'Approved' && isLarge(o)) {
                o.Needs_Finance_Review__c = true; // before trigger: saved without DML
            }
        }
    }

    private static void afterUpdate(List<Sales_Order__c> orders, Map<Id, Sales_Order__c> oldMap) {
        List<Sales_Order__c> toInvoice = new List<Sales_Order__c>();
        Set<Id> reviewerIds = new Set<Id>();

        for (Sales_Order__c o : orders) {
            if (!statusChanged(o, oldMap)) {
                continue;
            }
            if (o.Status__c == 'Shipped'
                && TransitionGuard.firstTime('invoice', o.Id, o.Status__c)) {
                toInvoice.add(o);
            }
            if (o.Status__c == 'Approved' && isLarge(o)
                && o.OwnerId.getSobjectType() == User.SObjectType
                && TransitionGuard.firstTime('reviewer', o.Id, o.Status__c)) {
                reviewerIds.add(o.OwnerId);
            }
        }

        if (!toInvoice.isEmpty()) {
            InvoiceService.createInvoices(toInvoice);
        }
        if (!reviewerIds.isEmpty()
            && Limits.getQueueableJobs() < Limits.getLimitQueueableJobs()) {
            // Permission set assignment is a setup object: it cannot share
            // a transaction with these order updates (mixed DML).
            System.enqueueJob(new ReviewerAccessJob(reviewerIds));
        }
    }

    private static Boolean isLarge(Sales_Order__c o) {
        return o.Total_Amount__c != null && o.Total_Amount__c >= LARGE_ORDER_THRESHOLD;
    }
}
```

**`force-app/main/default/classes/BillingEmailLookup.cls`**

This is the one deliberate `without sharing` class. Billing needs the Account's email even when the user who shipped the order cannot see that Account. It reads one field and returns it to code only, never to the UI.

```apex
public without sharing class BillingEmailLookup {
    public static Map<Id, String> forAccounts(Set<Id> accountIds) {
        Map<Id, String> emails = new Map<Id, String>();
        if (accountIds.isEmpty()) {
            return emails;
        }
        for (Account a : [SELECT Id, Billing_Email__c FROM Account WHERE Id IN :accountIds]) {
            emails.put(a.Id, a.Billing_Email__c);
        }
        return emails;
    }
}
```

**`force-app/main/default/classes/InvoiceService.cls`**

The service builds all invoices, saves them with one partial-success upsert, and reads the result list by index. The external ID makes it idempotent: a retry updates the existing invoice instead of duplicating it. Status is not set here, so an invoice already Sent keeps that status.

```apex
public with sharing class InvoiceService {
    public class Result {
        public Integer created = 0;
        public Map<Id, String> failureByOrderId = new Map<Id, String>();
    }

    public static Result createInvoices(List<Sales_Order__c> orders) {
        Set<Id> accountIds = new Set<Id>();
        for (Sales_Order__c o : orders) {
            if (o.Account__c != null) {
                accountIds.add(o.Account__c);
            }
        }
        Map<Id, String> emails = BillingEmailLookup.forAccounts(accountIds);

        List<Invoice__c> invoices = new List<Invoice__c>();
        for (Sales_Order__c o : orders) {
            invoices.add(new Invoice__c(
                Invoice_Key__c = String.valueOf(o.Id),
                Sales_Order__c = o.Id,
                Amount__c = o.Total_Amount__c,
                Bill_To_Email__c = emails.get(o.Account__c)
            ));
        }

        // allOrNone = false: one bad invoice must not block the others.
        List<Database.UpsertResult> results =
            Database.upsert(invoices, Invoice__c.Invoice_Key__c, false);

        Result outcome = new Result();
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                outcome.created++;
            } else {
                Database.Error err = results[i].getErrors()[0];
                outcome.failureByOrderId.put(
                    invoices[i].Sales_Order__c,
                    err.getStatusCode() + ': ' + err.getMessage());
            }
        }
        if (!outcome.failureByOrderId.isEmpty()) {
            InvoiceFailureReporter.report(outcome.failureByOrderId);
        }
        return outcome;
    }
}
```

**`force-app/main/default/classes/InvoiceFailureReporter.cls`**

This class shows re-entrancy. Updating the order from an after trigger fires `SalesOrderTrigger` again with a fresh context. The status becomes Invoice_Failed, which no rule reacts to, so the loop ends. The guard protects the Shipped transition in case a flow flips the status back.

```apex
public with sharing class InvoiceFailureReporter {
    public static void report(Map<Id, String> reasonByOrderId) {
        List<Invoice_Failure__e> events = new List<Invoice_Failure__e>();
        List<Sales_Order__c> marks = new List<Sales_Order__c>();

        for (Id orderId : reasonByOrderId.keySet()) {
            events.add(new Invoice_Failure__e(
                Order_Id__c = orderId,
                Reason__c = reasonByOrderId.get(orderId).left(255)));
            marks.add(new Sales_Order__c(Id = orderId, Status__c = 'Invoice_Failed'));
        }

        // Publish Immediately event: delivered even if this transaction rolls back.
        for (Database.SaveResult sr : EventBus.publish(events)) {
            if (!sr.isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Event publish failed: ' + sr.getErrors());
            }
        }
        // New instances, so this DML is allowed from an after trigger.
        Database.update(marks, false);
    }
}
```

**`force-app/main/default/classes/InvoiceTriggerHandler.cls`**

```apex
public with sharing class InvoiceTriggerHandler {
    public static void run() {
        if (AutomationSwitch.isOff('Invoice')) {
            return;
        }
        if (Trigger.isAfter && Trigger.isInsert) {
            List<Id> pendingIds = new List<Id>();
            for (Invoice__c inv : (List<Invoice__c>) Trigger.new) {
                if (inv.Status__c == 'Pending') {
                    pendingIds.add(inv.Id);
                }
            }
            if (!pendingIds.isEmpty()
                && Limits.getQueueableJobs() < Limits.getLimitQueueableJobs()) {
                System.enqueueJob(new ErpInvoicePushJob(pendingIds));
            }
            // If the job cannot be enqueued, invoices stay Pending
            // and a scheduled retry job (not shown) can pick them up.
        }
    }
}
```

**`force-app/main/default/classes/ErpInvoicePushJob.cls`**

The job sends one callout for the whole chunk, not one per invoice. It runs after commit as the enqueuing user. DML happens only after the callout, because an uncommitted DML before a callout throws.

```apex
public with sharing class ErpInvoicePushJob implements Queueable, Database.AllowsCallouts {
    private final List<Id> invoiceIds;

    public ErpInvoicePushJob(List<Id> invoiceIds) {
        this.invoiceIds = invoiceIds;
    }

    public void execute(QueueableContext context) {
        List<Invoice__c> invoices = [
            SELECT Id, Invoice_Key__c, Amount__c, Bill_To_Email__c, Sales_Order__c
            FROM Invoice__c
            WHERE Id IN :invoiceIds AND Status__c = 'Pending'
        ];
        if (invoices.isEmpty()) {
            return;
        }

        List<Map<String, Object>> payload = new List<Map<String, Object>>();
        for (Invoice__c inv : invoices) {
            payload.add(new Map<String, Object>{
                'invoiceKey' => inv.Invoice_Key__c,
                'amount' => inv.Amount__c,
                'billTo' => inv.Bill_To_Email__c
            });
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Brightforge_ERP/v1/invoices');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(60000);
        req.setBody(JSON.serialize(payload));

        String failure = null;
        try {
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() < 200 || res.getStatusCode() > 299) {
                failure = 'ERP returned HTTP ' + res.getStatusCode();
            }
        } catch (CalloutException e) {
            failure = 'Callout error: ' + e.getMessage();
        }
        finish(invoices, failure);
    }

    private static void finish(List<Invoice__c> invoices, String failure) {
        Map<Id, String> failedOrders = new Map<Id, String>();
        for (Invoice__c inv : invoices) {
            inv.Status__c = failure == null ? 'Sent' : 'Failed';
            inv.Failure_Reason__c = failure;
            if (failure != null) {
                failedOrders.put(inv.Sales_Order__c, failure);
            }
        }
        Database.update(invoices, false);
        if (!failedOrders.isEmpty()) {
            InvoiceFailureReporter.report(failedOrders);
        }
    }
}
```

**`force-app/main/default/classes/ReviewerAccessJob.cls`**

```apex
public with sharing class ReviewerAccessJob implements Queueable {
    private final Set<Id> userIds;

    public ReviewerAccessJob(Set<Id> userIds) {
        this.userIds = userIds;
    }

    public void execute(QueueableContext context) {
        List<PermissionSet> sets = [
            SELECT Id FROM PermissionSet WHERE Name = 'Large_Order_Reviewer' LIMIT 1
        ];
        if (sets.isEmpty()) {
            return;
        }
        Id permissionSetId = sets[0].Id;

        Set<Id> alreadyAssigned = new Set<Id>();
        for (PermissionSetAssignment existing : [
            SELECT AssigneeId FROM PermissionSetAssignment
            WHERE PermissionSetId = :permissionSetId AND AssigneeId IN :userIds
        ]) {
            alreadyAssigned.add(existing.AssigneeId);
        }

        List<PermissionSetAssignment> toAdd = new List<PermissionSetAssignment>();
        for (Id userId : userIds) {
            if (!alreadyAssigned.contains(userId)) {
                toAdd.add(new PermissionSetAssignment(
                    PermissionSetId = permissionSetId, AssigneeId = userId));
            }
        }
        // Setup object DML, in its own transaction: no mixed DML error.
        Database.insert(toAdd, false);
    }
}
```

**`force-app/main/default/classes/InvoiceFailureHandler.cls`**

Event triggers receive batches of up to 2,000 events and run as the Automated Process user, so the Case owner comes from your Case assignment rules or default owner.

```apex
public with sharing class InvoiceFailureHandler {
    public static void run(List<Invoice_Failure__e> events) {
        List<Case> cases = new List<Case>();
        for (Invoice_Failure__e evt : events) {
            cases.add(new Case(
                Subject = 'Invoice failed for order ' + evt.Order_Id__c,
                Description = evt.Reason__c,
                Priority = 'High'));
        }
        List<Database.SaveResult> results = Database.insert(cases, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR,
                    'Case not created for ' + events[i].Order_Id__c + ': '
                    + results[i].getErrors()[0].getMessage());
            }
        }
    }
}
```

**`force-app/main/default/objects/Invoice_Failure__e/Invoice_Failure__e.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <eventType>StandardVolume</eventType>
    <label>Invoice Failure</label>
    <pluralLabel>Invoice Failures</pluralLabel>
    <publishBehavior>PublishImmediately</publishBehavior>
</CustomObject>
```

**`force-app/main/default/objects/Invoice__c/fields/Bill_To_Email__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Bill_To_Email__c</fullName>
    <label>Bill To Email</label>
    <required>true</required>
    <type>Email</type>
</CustomField>
```

**`force-app/main/default/permissionsets/Large_Order_Reviewer.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Large Order Reviewer</label>
    <hasActivationRequired>false</hasActivationRequired>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Invoice__c</object>
        <viewAllRecords>true</viewAllRecords>
    </objectPermissions>
</PermissionSet>
```

### Flow coexistence

Add an optional before-save flow: Setup, Flows, New Flow, Record-Triggered Flow, object Sales Order, trigger "A record is created or updated", run **Fast Field Updates** (before save), entry condition "Status is changed". Add an Assignment that sets `$Record.Status_Changed_On__c` to `{!$Flow.CurrentDate}` (create a Date field `Status_Changed_On__c` first). Why this order is safe: the flow runs before `beforeSave`, so the trigger could read the stamped date. The rule is one owner per field. Never let a flow and a trigger both write the same field, because the later writer silently wins and nobody can tell why. An after-save flow that updates the order is different: it runs after the trigger, re-fires it, and counts against the same limits.

### Tests

**`force-app/main/default/classes/ErpMock.cls`**

```apex
@IsTest
public class ErpMock implements HttpCalloutMock {
    private final Integer statusCode;
    public static Integer calls = 0;

    public ErpMock(Integer statusCode) {
        this.statusCode = statusCode;
    }

    public HttpResponse respond(HttpRequest req) {
        calls++;
        HttpResponse res = new HttpResponse();
        res.setStatusCode(statusCode);
        res.setHeader('Content-Type', 'application/json');
        res.setBody('{"accepted": true}');
        return res;
    }
}
```

**`force-app/main/default/classes/OrderToCashTriggerTest.cls`**

```apex
@IsTest
private class OrderToCashTriggerTest {

    @TestSetup
    static void setup() {
        Account withEmail = new Account(Name = 'Has Email', Billing_Email__c = 'ap@example.com');
        Account noEmail = new Account(Name = 'No Email');
        insert new List<Account>{ withEmail, noEmail };

        List<Sales_Order__c> orders = new List<Sales_Order__c>();
        for (Integer i = 0; i < 200; i++) {
            orders.add(new Sales_Order__c(
                Account__c = i < 160 ? withEmail.Id : noEmail.Id, Status__c = 'Approved'));
        }
        insert orders;

        List<Sales_Order_Item__c> items = new List<Sales_Order_Item__c>();
        for (Sales_Order__c o : orders) {
            items.add(new Sales_Order_Item__c(
                Sales_Order__c = o.Id, Quantity__c = 2, Unit_Price__c = 50));
        }
        insert items;
    }

    private static List<Sales_Order__c> statusUpdates(String status) {
        List<Sales_Order__c> updates = new List<Sales_Order__c>();
        for (Sales_Order__c o : [SELECT Id FROM Sales_Order__c]) {
            updates.add(new Sales_Order__c(Id = o.Id, Status__c = status));
        }
        return updates;
    }

    @IsTest
    static void shipping200OrdersInvoicesTheGoodAndReportsTheBad() {
        Test.setMock(HttpCalloutMock.class, new ErpMock(200));
        List<Sales_Order__c> updates = statusUpdates('Shipped');

        Test.startTest();
        Integer queriesBefore = Limits.getQueries();
        Integer dmlBefore = Limits.getDmlStatements();
        update updates;
        Integer queriesUsed = Limits.getQueries() - queriesBefore;
        Integer dmlUsed = Limits.getDmlStatements() - dmlBefore;
        Test.stopTest(); // the Queueable ERP push runs here
        Test.getEventBus().deliver(); // the event trigger runs here

        System.Assert.isTrue(queriesUsed <= 10, 'SOQL used: ' + queriesUsed);
        System.Assert.isTrue(dmlUsed <= 6, 'DML used: ' + dmlUsed);

        System.Assert.areEqual(160, [SELECT COUNT() FROM Invoice__c]);
        System.Assert.areEqual(160, [SELECT COUNT() FROM Invoice__c WHERE Status__c = 'Sent']);
        System.Assert.areEqual(40,
            [SELECT COUNT() FROM Sales_Order__c WHERE Status__c = 'Invoice_Failed']);
        System.Assert.areEqual(1, ErpMock.calls, 'One callout for the whole chunk');
        System.Assert.areEqual(40,
            [SELECT COUNT() FROM Case WHERE Subject LIKE 'Invoice failed for order%']);
    }

    @IsTest
    static void shippingAnEmptyOrderIsRejectedPerRecord() {
        Sales_Order__c empty = new Sales_Order__c(Status__c = 'Draft');
        insert empty;

        Database.SaveResult result =
            Database.update(new Sales_Order__c(Id = empty.Id, Status__c = 'Shipped'), false);

        System.Assert.isFalse(result.isSuccess());
        System.Assert.isTrue(result.getErrors()[0].getMessage().contains('priced item'));
    }

    @IsTest
    static void erpFailureMarksInvoicesAndRaisesEvents() {
        Test.setMock(HttpCalloutMock.class, new ErpMock(500));
        Sales_Order__c one = [
            SELECT Id FROM Sales_Order__c WHERE Account__r.Name = 'Has Email' LIMIT 1
        ];

        Test.startTest();
        update new Sales_Order__c(Id = one.Id, Status__c = 'Shipped');
        Test.stopTest();

        Invoice__c inv = [SELECT Status__c, Failure_Reason__c FROM Invoice__c];
        System.Assert.areEqual('Failed', inv.Status__c);
        System.Assert.isTrue(inv.Failure_Reason__c.contains('500'));
    }

    @IsTest
    static void reshippingDoesNotDuplicateInvoices() {
        Test.setMock(HttpCalloutMock.class, new ErpMock(200));
        Sales_Order__c one = [
            SELECT Id FROM Sales_Order__c WHERE Account__r.Name = 'Has Email' LIMIT 1
        ];
        update new Sales_Order__c(Id = one.Id, Status__c = 'Shipped');
        TransitionGuard.reset(); // statics live for the whole test transaction

        update new Sales_Order__c(Id = one.Id, Status__c = 'Approved');
        update new Sales_Order__c(Id = one.Id, Status__c = 'Shipped');

        System.Assert.areEqual(1, [SELECT COUNT() FROM Invoice__c]);
    }

    @IsTest
    static void largeApprovedOrderGrantsReviewerPermissionSet() {
        Sales_Order__c big = new Sales_Order__c(Status__c = 'Draft');
        insert big;
        insert new Sales_Order_Item__c(
            Sales_Order__c = big.Id, Quantity__c = 1000, Unit_Price__c = 150);

        Test.startTest();
        update new Sales_Order__c(Id = big.Id, Status__c = 'Approved');
        Test.stopTest();

        System.Assert.isTrue([SELECT Needs_Finance_Review__c FROM Sales_Order__c
            WHERE Id = :big.Id].Needs_Finance_Review__c);
        System.Assert.areEqual(1, [
            SELECT COUNT() FROM PermissionSetAssignment
            WHERE AssigneeId = :UserInfo.getUserId()
            AND PermissionSet.Name = 'Large_Order_Reviewer'
        ], 'Deploy the Large_Order_Reviewer permission set first');
    }

    @IsTest
    static void bypassSwitchSkipsTheAutomation() {
        Sales_Order__c empty = new Sales_Order__c(Status__c = 'Draft');
        insert empty;

        AutomationSwitch.disableForTransaction('Sales_Order');
        Database.SaveResult result =
            Database.update(new Sales_Order__c(Id = empty.Id, Status__c = 'Shipped'), false);

        System.Assert.isTrue(result.isSuccess(), 'Rule skipped while the switch is off');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org my-dev-org
sf apex run test --class-names OrderToCashTriggerTest --code-coverage \
  --result-format human --wait 10 --target-org my-dev-org
```

## What happens behind the scenes

Follow one load: a distributor integration sets 200 orders to Shipped in one API call.

1. **The chunk arrives.** All 200 orders fit one trigger chunk. Before-save flows run first, then `beforeSave` runs once for 200 records. Every order has a total above zero, so none is rejected.
2. **The save and the after trigger.** The platform writes the rows without committing. `afterUpdate` loops once, passes the guard, and builds a list of 200 orders. `BillingEmailLookup` runs one SOQL query. `Database.upsert` is one DML statement for 200 invoices.
3. **Partial failure.** Forty invoices miss the required `Bill_To_Email__c`. Those rows come back as failed results. The platform saves the other 160. Invoice triggers run for the saved set. The 160 inserts fire `InvoiceTrigger` once, which enqueues one job. (Salesforce's docs note that triggers can fire again for the surviving subset in a partial save, which is why the guard sits only in after logic.)
4. **Events and re-entrancy.** `EventBus.publish` sends 40 events. With Publish Immediately they are not tied to commit. `Database.update(marks, false)` is one more DML statement and fires `SalesOrderTrigger` again. The static guard and the status check stop the loop.
5. **Commit and post-commit.** The transaction commits. The enqueued job is now queued. Event delivery starts for the subscriber.
6. **Async work.** `ErpInvoicePushJob` runs in its own transaction with its own limits: one SOQL query, one callout, one DML. Success flips invoices to Sent. The event trigger runs in another transaction and inserts 40 Cases in one DML.

Limits used by the synchronous transaction: 1 or 2 SOQL queries (plus any your flows add), 3 DML statements (order update, invoice upsert, failure marks), 1 enqueued job, 1 `EventBus.publish` call. Documented synchronous limits: 100 SOQL queries, 150 DML statements, 10,000 records per DML, 10 seconds CPU, and 50 enqueued jobs. In a debug log, look for `CODE_UNIT_STARTED` lines per trigger, `DML_BEGIN` with `Op:Upsert Type:Invoice__c Rows:200`, and the `LIMIT_USAGE_FOR_NS` summary at the end.

## Test it and verify

1. Run the test class (command above). Expect all tests to pass.
2. Create Account records with and without `Billing_Email__c`. In Developer Console, Debug, Open Execute Anonymous Apex, run:

   ```apex
   // Anonymous Apex
   List<Sales_Order__c> orders = [SELECT Id FROM Sales_Order__c WHERE Status__c = 'Approved' LIMIT 20];
   for (Sales_Order__c o : orders) { o.Status__c = 'Shipped'; }
   Database.update(orders, false);
   System.debug([SELECT COUNT() FROM Invoice__c]);
   ```

3. Check the log for the `Op:Upsert Type:Invoice__c` DML line and the final limits block. Expect one query on Account.
4. Query `SELECT Status__c, Failure_Reason__c FROM Invoice__c`. With a reachable ERP endpoint, invoices show Sent after the job runs (Setup, Apex Jobs lists the Queueable).
5. Open Setup, Platform Events and check the event's usage, or open the Cases list to confirm one Case per failure.
6. Set the `Sales_Order` switch record to disabled, ship an empty order, and confirm it now saves. Re-enable it afterwards.

## Common mistakes and fixes

- **Symptom: `MIXED_DML_OPERATION` when granting a permission set.** Cause: a setup object and a non-setup object changed in one transaction. Fix: do the setup-object DML in a Queueable, as `ReviewerAccessJob` does.
- **Symptom: `Uncommitted work pending` or no callout from a trigger.** Cause: callouts are not allowed in the trigger transaction, and a callout after uncommitted DML fails. Fix: enqueue a job with `Database.AllowsCallouts` and do DML only after the callout.
- **Symptom: a trigger runs twice and doubles a Task.** Cause: an after-save flow or your own after-trigger update re-fired it. Fix: guard the transition (`step + id + value`), not a Boolean for the whole class.
- **Symptom: records processed only once even when you expected more.** Cause: a static guard keyed on Id alone persists across the whole transaction, including test methods. Fix: key it on the transition, and call a `@TestVisible` reset in tests.
- **Symptom: one bad row fails a 200-row load.** Cause: `insert` or `update` runs with `allOrNone` true, or the trigger calls `addError` carelessly. Fix: use `Database.*(records, false)`, and read the result list by index.
- **Symptom: `DmlException` from an after trigger changing `Trigger.new`.** Cause: after-trigger records are read-only. Fix: edit in a before trigger, or issue DML on a new instance with only the changed fields.
- **Symptom: an event trigger creates duplicates.** Cause: a retried or replayed event. Fix: key the work on a business Id, such as an external ID, and upsert.
- **Symptom: a flow and a trigger fight over a field.** Cause: both write it. Fix: one owner per field, and a bypass for data loads.

## Key takeaways

- The save order decides what your trigger sees: before-save flows come first, roll-ups and after-save flows come later.
- Edit records in before triggers; use DML on new instances in after triggers, and expect re-entry.
- Guard transitions with a static set keyed on step, Id and value, and never guard non-idempotent before logic.
- Triggers cannot call out and cannot mix setup and non-setup DML. Hand that work to a Queueable.
- Use `Database.*` with `allOrNone=false`, read results by index, and report failures with a platform event.
- Triggers run in system mode. Choose sharing in the classes they call, and explain every `without sharing`.

## Where to go next

- [Bulkify your Apex triggers](/articles/bulkify-apex-triggers/) for limits and the 200 and 10,000 record tests.
- [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/) for chaining and finalizers.
- [Platform events and CDC pub/sub](/articles/platform-events-cdc-pubsub/) for event design.
- [Record-triggered Flow best practices](/articles/record-triggered-flow-best-practices/) for the flow side of coexistence.
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/).
