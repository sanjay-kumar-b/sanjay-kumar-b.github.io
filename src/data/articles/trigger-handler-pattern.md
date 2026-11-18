---
title: "One Trigger per Object: A Clean Trigger Handler Pattern"
description: "Build a trigger handler framework with one trigger per object, bypass switches, a per-object Custom Metadata toggle and a recursion guard."
category: salesforce-development
tags: [Apex, Triggers, Architecture]
publishedAt: 2026-10-26
updatedAt: 2026-11-13
cover: /images/covers/trigger-handler-pattern.jpg
sources:
  - title: "Triggers (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm"
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
  - title: "Trigger Context Variables (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_triggers_context_variables.htm"
  - title: "Set an Access Mode for Database Operations (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_classes_enforce_usermode.htm"
  - title: "FeatureManagement Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.262.0.apexref.meta/apexref/apex_class_System_FeatureManagement.htm"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

Salesforce does not guarantee the order in which two triggers on the same object and event run. The widely used fix is **one trigger per object, with no logic inside it**. The trigger only hands the work to a handler class, and the handler decides what to run, in what order, and whether to run at all.

This article builds that idea into a small framework you can copy into a real project. It has four jobs: route each trigger event to a method, let you switch the automation off in three different ways, stop the same record being processed twice in one transaction, and keep every method bulk-safe. If you have never written a trigger, read [Apex triggers from scratch](/articles/apex-triggers-from-scratch/) first. This article is about structure, not syntax.

## The business scenario

Harborview Software (a fictional B2B SaaS company) has a sales-operations team that wants four rules enforced on every save, from the UI, from the integration that syncs customers, and from data loads:

1. Every Account gets a **segment** from its employee count: Enterprise from 1,000 employees, Mid-Market from 100, SMB below that.
2. When an Account's segment changes, every **open** Opportunity on it gets the new segment copied to a reporting field, so pipeline reports can group by segment without a cross-object formula.
3. Every Opportunity records the **date its stage last changed**.
4. When an Opportunity becomes Closed Won, its owner gets an onboarding **Task**, exactly once.

The team also has operational needs. During a migration they must pause the Account automation for one integration user. During an incident an admin must switch off the Opportunity automation for the whole org without a deployment. And a data fix script written in Apex must be able to skip the logic for the records it touches. The model has these pieces:

| Piece | Job |
|---|---|
| `AccountTrigger`, `OpportunityTrigger` | One per object, one line each |
| `TriggerHandler` | Base class: skip checks, then dispatch by event |
| `TriggerContext` | Wraps the `Trigger.*` variables so tests can build one |
| `TriggerBypass` | Code switch and custom permission switch |
| `TriggerSettings` | Org-wide switch from Custom Metadata |
| `TriggerRecursionGuard` | Once-per-record-per-transaction check |
| `AccountTriggerHandler`, `OpportunityTriggerHandler` | The four business rules |
| `AccountSelector`, `OpportunitySelector` | The only classes that run SOQL |

## Before you start: setup

This pattern needs no external system. Everything runs inside Salesforce. Setup menu labels can differ slightly by release, so use the Quick Find box in Setup if a path has moved.

### In Salesforce

1. **Get a safe org.** Use a Developer Edition org or a scratch org, not production. Why: you will create fields and deploy code. Verify: you can open Setup and the Developer Console.
2. **Create the Account field `Segment`.** Setup, Object Manager, Account, Fields & Relationships, New. Type Text, length 20, API name `Segment__c`. Why: rule 1 writes it. Verify: it shows in the field list.
3. **Create two Opportunity fields.** `Account_Segment__c` (Text, 20) and `Stage_Changed_On__c` (Date). Why: rules 2 and 3 write them. Verify: both appear on Opportunity.
4. **Create the Custom Metadata Type `Trigger Setting`.** Setup, Custom Metadata Types, New. API name `Trigger_Setting__mdt`. Add one Checkbox field `Is_Active__c`, default checked. Why: this is the org-wide switch an admin can flip without a deployment. Verify: Manage Records opens an empty list.
5. **Add two records:** label and name `Account`, and label and name `Opportunity`, both with Is Active checked. The record name (DeveloperName) must equal the object API name, because the code looks it up by that name. Verify: `SELECT DeveloperName, Is_Active__c FROM Trigger_Setting__mdt` returns two rows.
6. **Create the Custom Permission `Bypass Triggers`.** Setup, Custom Permissions, New. API name `Bypass_Triggers`. Why: assigning it to a user makes every handler skip for that user. Verify: it appears in the list.
7. **Create the permission set `Trigger Bypass`** and add the custom permission to it. Do not assign it to anyone yet. Verify: Setup, Permission Sets, Trigger Bypass, Custom Permissions shows the permission enabled.
8. **Check the Opportunity stage names.** The code uses the standard `Closed Won` stage. Verify: Setup, Object Manager, Opportunity, Fields, Stage shows it.

The XML for steps 2 to 7 is in the advanced section so you can deploy instead of clicking.

### On your machine

1. Install the Salesforce CLI (`sf`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version` prints a version.
2. Authorize the org: `sf org login web --alias harborview`. Verify: `sf org list` shows it.

## How it works

### Terms

A **trigger** is Apex that the platform runs before or after a record is inserted, updated, deleted or undeleted. A **handler** is an ordinary class the trigger calls. The **operation type** is the enum `System.TriggerOperation` (for example `BEFORE_INSERT` or `AFTER_UPDATE`) that says which event fired. A **chunk** is a group of up to 200 records. When a single DML statement touches more than 200 records, the platform runs the trigger once per chunk, all inside the same transaction. `Trigger.size` counts only the current chunk.

A **bypass** is a deliberate way to skip logic. A **recursion guard** is a check that stops the same work running again when a save causes another save. **System mode** means the code ignores the running user's object and field permissions. Record sharing then follows the sharing keyword of the class (see the access mode page in the sources).

### Where the handler sits in a save

The platform follows a fixed order of execution. The parts that matter here are:

| Step | What runs |
|---|---|
| 1 | Record-triggered flows that run **before** save |
| 2 | **Before triggers** (our `beforeInsert`, `beforeUpdate`) |
| 3 | Custom validation rules and duplicate rules |
| 4 | The record is saved, not committed |
| 5 | **After triggers** (our `afterInsert`, `afterUpdate`) |
| 6 | Workflow rules, then record-triggered flows that run **after** save |
| 7 | Commit, then post-commit work such as email and queued jobs |

If a workflow field update changes the record, the update triggers fire one more time. Inside that second run `Trigger.old` still holds the values from before the original update. That detail matters in rule 4, and it is why the recursion guard exists.

### Shape of the framework

```text
AccountTrigger (one line)
   |
   v
AccountTriggerHandler.run()              inherited from TriggerHandler
   |-- skip? TriggerBypass (code switch, custom permission)
   |-- skip? TriggerSettings (Custom Metadata, per object)
   '-- switch on operation type
          BEFORE_INSERT  -> beforeInsert()
          BEFORE_UPDATE  -> beforeUpdate()
          AFTER_UPDATE   -> afterUpdate()   uses selectors + guard
```

### Why not a loop counter

Many frameworks count how often a handler ran and throw at a limit. Do not copy that idea. A 10,000 record data load runs your handler 50 times in one transaction, one run per chunk. A counter would fail a perfectly healthy load. The guard here tracks record Ids instead, and the platform itself stops runaway chains at a trigger depth of 16.

## Basic example

This is the smallest useful handler. It has one trigger, one handler, a `switch` on the operation type, and bulk-safe logic. It lowercases Contact emails so duplicates are easier to find.

```apex
trigger ContactTrigger on Contact (before insert, before update) {
    ContactTriggerHandler.run();
}
```

```apex
public with sharing class ContactTriggerHandler {
    public static void run() {
        switch on Trigger.operationType {
            when BEFORE_INSERT, BEFORE_UPDATE {
                normalizeEmails((List<Contact>) Trigger.new);
            }
            when else {
                // Other events are ignored on purpose.
            }
        }
    }

    private static void normalizeEmails(List<Contact> contacts) {
        for (Contact c : contacts) {
            if (c.Email != null) {
                c.Email = c.Email.trim().toLowerCase();   // no DML in a before trigger
            }
        }
    }
}
```

Try it in the Developer Console (Debug, Open Execute Anonymous Window):

```apex
// Anonymous Apex
Contact c = new Contact(LastName = 'Demo', Email = '  Sam.Rivera@Example.COM ');
insert c;
System.debug([SELECT Email FROM Contact WHERE Id = :c.Id].Email);
```

Expected output: `sam.rivera@example.com`. A before trigger changes the record before it is saved, so no second DML is needed.

Here is the problem this pattern prevents. The **bad** version has two triggers on the same object, each with logic inside:

```apex
// BAD: two triggers on the same object and event. Their order is not
// guaranteed, and the logic cannot be unit tested without DML.
trigger ContactEmailTrigger on Contact (before insert) {
    for (Contact c : Trigger.new) {
        c.Email = c.Email == null ? null : c.Email.toLowerCase();
    }
}
```

```apex
// BAD: runs "somewhere" around the other trigger. If it reads Email,
// it may see the lowercased value or the original, depending on the order.
trigger ContactDuplicateTrigger on Contact (before insert) {
    for (Contact c : Trigger.new) {
        c.Description = 'Email domain: ' + c.Email?.substringAfter('@');
    }
}
```

The fixed version is the one trigger and one handler above, where the second rule becomes a second method called after the first. The order is now written in code, not left to the platform.

## Advanced end-to-end example

The files below are the whole framework plus the Harborview rules. The design rules are: triggers contain one line, the base class owns skipping and dispatch, handlers own business rules, and selectors own SOQL.

### The two triggers

**`force-app/main/default/triggers/AccountTrigger.trigger`**

```apex
trigger AccountTrigger on Account (
    before insert, before update, before delete,
    after insert, after update, after delete, after undelete
) {
    new AccountTriggerHandler().run();
}
```

**`force-app/main/default/triggers/OpportunityTrigger.trigger`**

```apex
trigger OpportunityTrigger on Opportunity (
    before insert, before update, before delete,
    after insert, after update, after delete, after undelete
) {
    new OpportunityTriggerHandler().run();
}
```

Subscribing to all seven events costs nothing. A handler that does not override a method does nothing for that event.

### The framework

**`force-app/main/default/classes/TriggerContext.cls`**

```apex
public inherited sharing class TriggerContext {
    public final System.TriggerOperation operation;
    public final String objectName;
    public final List<SObject> newList;
    public final Map<Id, SObject> newMap = new Map<Id, SObject>();
    public final Map<Id, SObject> oldMap;

    public TriggerContext(
        System.TriggerOperation operation,
        String objectName,
        List<SObject> newList,
        Map<Id, SObject> oldMap
    ) {
        this.operation = operation;
        this.objectName = objectName;
        this.newList = newList == null ? new List<SObject>() : newList;
        this.oldMap = oldMap == null ? new Map<Id, SObject>() : oldMap;
        for (SObject rec : this.newList) {
            if (rec.Id != null) {
                this.newMap.put(rec.Id, rec);
            }
        }
    }

    // Builds a context from the Trigger.* variables. Only valid inside a trigger.
    public static TriggerContext fromTrigger() {
        // Trigger.new is null on delete, so read the type from Trigger.old there.
        List<SObject> source = Trigger.isDelete ? Trigger.old : Trigger.new;
        return new TriggerContext(
            Trigger.operationType,
            String.valueOf(source[0].getSObjectType()),
            Trigger.new,
            Trigger.oldMap
        );
    }

    // True on insert, or when the field value differs from the old version.
    public Boolean hasChanged(SObject record, Schema.SObjectField field) {
        SObject previous = oldMap.get(record.Id);
        return previous == null || record.get(field) != previous.get(field);
    }
}
```

**`force-app/main/default/classes/TriggerBypass.cls`**

```apex
public inherited sharing class TriggerBypass {
    private static final Set<String> BYPASSED = new Set<String>();

    // Code switch: skip one handler for the rest of this transaction.
    public static void bypass(String handlerName) {
        BYPASSED.add(handlerName);
    }

    public static void clear(String handlerName) {
        BYPASSED.remove(handlerName);
    }

    public static void clearAll() {
        BYPASSED.clear();
    }

    public static Boolean isBypassed(String handlerName) {
        return BYPASSED.contains(handlerName);
    }

    // Person switch: the running user has the Bypass_Triggers custom permission.
    public static Boolean userHasBypassPermission() {
        return FeatureManagement.checkPermission('Bypass_Triggers');
    }
}
```

**`force-app/main/default/classes/TriggerSettings.cls`**

```apex
public inherited sharing class TriggerSettings {
    // Custom Metadata records cannot be created in a test, so tests set
    // an override here instead.
    @TestVisible
    private static Map<String, Boolean> testOverrides = new Map<String, Boolean>();

    // Org switch. A missing record means "active", so a new object is never
    // silently switched off.
    public static Boolean isActive(String objectName) {
        if (testOverrides.containsKey(objectName)) {
            return testOverrides.get(objectName);
        }
        // getInstance reads cached metadata. It does not use a SOQL query.
        Trigger_Setting__mdt setting = Trigger_Setting__mdt.getInstance(objectName);
        return setting == null || setting.Is_Active__c;
    }
}
```

**`force-app/main/default/classes/TriggerRecursionGuard.cls`**

```apex
public inherited sharing class TriggerRecursionGuard {
    private static final Set<String> SEEN = new Set<String>();

    // Returns only the Ids not yet seen for this scope in this transaction.
    // The scope names the piece of logic, so two rules never block each other.
    public static Set<Id> firstTime(String scope, Set<Id> recordIds) {
        Set<Id> fresh = new Set<Id>();
        for (Id recordId : recordIds) {
            if (SEEN.add(scope + ':' + recordId)) {
                fresh.add(recordId);
            }
        }
        return fresh;
    }

    @TestVisible
    private static void reset() {
        SEEN.clear();
    }
}
```

**`force-app/main/default/classes/TriggerHandler.cls`**

```apex
public abstract inherited sharing class TriggerHandler {
    protected TriggerContext ctx;

    // Called by the trigger.
    public void run() {
        run(TriggerContext.fromTrigger());
    }

    // Called by tests with a hand-built context.
    public void run(TriggerContext context) {
        this.ctx = context;
        String reason = skipReason();
        if (reason != null) {
            System.debug(LoggingLevel.INFO, handlerName() + ' skipped: ' + reason);
            return;
        }
        switch on context.operation {
            when BEFORE_INSERT {
                beforeInsert();
            }
            when BEFORE_UPDATE {
                beforeUpdate();
            }
            when BEFORE_DELETE {
                beforeDelete();
            }
            when AFTER_INSERT {
                afterInsert();
            }
            when AFTER_UPDATE {
                afterUpdate();
            }
            when AFTER_DELETE {
                afterDelete();
            }
            when AFTER_UNDELETE {
                afterUndelete();
            }
        }
    }

    // Subclasses override only the events they care about.
    protected virtual void beforeInsert() {
    }
    protected virtual void beforeUpdate() {
    }
    protected virtual void beforeDelete() {
    }
    protected virtual void afterInsert() {
    }
    protected virtual void afterUpdate() {
    }
    protected virtual void afterDelete() {
    }
    protected virtual void afterUndelete() {
    }

    private String handlerName() {
        // String.valueOf(this) looks like "AccountTriggerHandler:[]".
        return String.valueOf(this).substringBefore(':');
    }

    private String skipReason() {
        if (TriggerBypass.isBypassed(handlerName())) {
            return 'code bypass';
        }
        if (TriggerBypass.userHasBypassPermission()) {
            return 'user has Bypass_Triggers';
        }
        if (!TriggerSettings.isActive(ctx.objectName)) {
            return 'switched off in Trigger_Setting__mdt';
        }
        return null;
    }
}
```

### Selectors

Triggers run in system mode, and the Summer '26 release notes say they cannot declare a sharing or access mode, so security-sensitive work belongs in classes where you choose the mode. These two selectors are **deliberately `without sharing` and use system mode**. The automation must update every open opportunity on the account, whoever saved the account. The user who edits an Account may not be able to see all of its Opportunities, and a half-updated pipeline is worse than the privilege. The mode is written out in each query because the default changed at API version 67.0.

**`force-app/main/default/classes/AccountSelector.cls`**

```apex
public without sharing class AccountSelector {
    public Map<Id, Account> byIds(Set<Id> accountIds) {
        return new Map<Id, Account>([
            SELECT Id, Segment__c
            FROM Account
            WHERE Id IN :accountIds
            WITH SYSTEM_MODE
        ]);
    }
}
```

**`force-app/main/default/classes/OpportunitySelector.cls`**

```apex
public without sharing class OpportunitySelector {
    public List<Opportunity> openByAccountIds(Set<Id> accountIds) {
        return [
            SELECT Id, AccountId, Account_Segment__c
            FROM Opportunity
            WHERE AccountId IN :accountIds AND IsClosed = false
            WITH SYSTEM_MODE
        ];
    }
}
```

### The business handlers

**`force-app/main/default/classes/AccountTriggerHandler.cls`**

```apex
public with sharing class AccountTriggerHandler extends TriggerHandler {
    @TestVisible
    private static final Integer ENTERPRISE_MIN = 1000;
    @TestVisible
    private static final Integer MID_MARKET_MIN = 100;

    protected override void beforeInsert() {
        applySegments((List<Account>) ctx.newList);
    }

    protected override void beforeUpdate() {
        // Recalculate only where the input changed.
        List<Account> changed = new List<Account>();
        for (Account acct : (List<Account>) ctx.newList) {
            if (ctx.hasChanged(acct, Account.NumberOfEmployees)) {
                changed.add(acct);
            }
        }
        applySegments(changed);
    }

    protected override void afterUpdate() {
        Map<Id, String> segmentByAccount = new Map<Id, String>();
        for (Account acct : (List<Account>) ctx.newList) {
            if (ctx.hasChanged(acct, Account.Segment__c)) {
                segmentByAccount.put(acct.Id, acct.Segment__c);
            }
        }
        if (!segmentByAccount.isEmpty()) {
            propagateToOpenOpportunities(segmentByAccount);
        }
    }

    @TestVisible
    private static String segmentFor(Integer employees) {
        if (employees >= ENTERPRISE_MIN) {
            return 'Enterprise';
        }
        return employees >= MID_MARKET_MIN ? 'Mid-Market' : 'SMB';
    }

    private static void applySegments(List<Account> accounts) {
        for (Account acct : accounts) {
            if (acct.NumberOfEmployees != null) {
                acct.Segment__c = segmentFor(acct.NumberOfEmployees);
            }
        }
    }

    // One query and one DML statement for the whole chunk.
    private void propagateToOpenOpportunities(Map<Id, String> segmentByAccount) {
        List<Opportunity> toUpdate = new List<Opportunity>();
        for (Opportunity opp : new OpportunitySelector().openByAccountIds(segmentByAccount.keySet())) {
            String segment = segmentByAccount.get(opp.AccountId);
            if (opp.Account_Segment__c != segment) {
                opp.Account_Segment__c = segment;
                toUpdate.add(opp);
            }
        }
        if (toUpdate.isEmpty()) {
            return;
        }
        try {
            Database.update(toUpdate, AccessLevel.SYSTEM_MODE);
        } catch (DmlException e) {
            // Failing loudly keeps Account and Opportunity data consistent.
            for (Id accountId : segmentByAccount.keySet()) {
                ctx.newMap.get(accountId).addError(
                    'Could not update the segment on open opportunities: ' + e.getDmlMessage(0)
                );
            }
        }
    }
}
```

**`force-app/main/default/classes/OpportunityTriggerHandler.cls`**

```apex
public with sharing class OpportunityTriggerHandler extends TriggerHandler {
    private static final String CLOSED_WON = 'Closed Won';
    @TestVisible
    private static final String TASK_SCOPE = 'OpportunityTriggerHandler.onboardingTask';

    protected override void beforeInsert() {
        copySegments((List<Opportunity>) ctx.newList);
    }

    protected override void beforeUpdate() {
        List<Opportunity> accountChanged = new List<Opportunity>();
        for (Opportunity opp : (List<Opportunity>) ctx.newList) {
            if (ctx.hasChanged(opp, Opportunity.StageName)) {
                opp.Stage_Changed_On__c = Date.today();
            }
            if (ctx.hasChanged(opp, Opportunity.AccountId)) {
                accountChanged.add(opp);
            }
        }
        copySegments(accountChanged);
    }

    protected override void afterUpdate() {
        Set<Id> becameWon = new Set<Id>();
        for (Opportunity opp : (List<Opportunity>) ctx.newList) {
            if (opp.StageName == CLOSED_WON && ctx.hasChanged(opp, Opportunity.StageName)) {
                becameWon.add(opp.Id);
            }
        }
        // A workflow field update re-fires this trigger with the same old values.
        // The guard makes sure each opportunity gets its Task only once.
        Set<Id> fresh = TriggerRecursionGuard.firstTime(TASK_SCOPE, becameWon);
        if (fresh.isEmpty()) {
            return;
        }
        List<Task> tasks = new List<Task>();
        for (Id oppId : fresh) {
            Opportunity opp = (Opportunity) ctx.newMap.get(oppId);
            tasks.add(new Task(
                Subject = 'Kick off customer onboarding',
                WhatId = opp.Id,
                OwnerId = opp.OwnerId,
                Priority = 'High',
                Status = 'Not Started',
                ActivityDate = Date.today().addDays(3)
            ));
        }
        Database.insert(tasks, AccessLevel.SYSTEM_MODE);
    }

    private static void copySegments(List<Opportunity> opportunities) {
        Set<Id> accountIds = new Set<Id>();
        for (Opportunity opp : opportunities) {
            if (opp.AccountId != null) {
                accountIds.add(opp.AccountId);
            }
        }
        if (accountIds.isEmpty()) {
            return;
        }
        Map<Id, Account> accounts = new AccountSelector().byIds(accountIds);
        for (Opportunity opp : opportunities) {
            opp.Account_Segment__c = accounts.get(opp.AccountId)?.Segment__c;
        }
    }
}
```

The bad pattern to avoid in `copySegments` is a query per opportunity (`[SELECT Segment__c FROM Account WHERE Id = :opp.AccountId]` inside the loop). That throws "Too many SOQL queries: 101" on the first large load. The version above collects the Ids, queries once, and reads from a map.

### A data-fix script that uses the code switch

**`scripts/apex/fix-segments.apex`**

```apex
// Anonymous Apex
// Back-fills Segment__c while skipping the Account automation, then restores it.
TriggerBypass.bypass('AccountTriggerHandler');
try {
    List<Account> accounts = [
        SELECT Id, NumberOfEmployees FROM Account
        WHERE Segment__c = null AND NumberOfEmployees != null
        LIMIT 5000
    ];
    for (Account acct : accounts) {
        acct.Segment__c = acct.NumberOfEmployees >= 1000 ? 'Enterprise' : 'Other';
    }
    update accounts;
    System.debug('Fixed ' + accounts.size() + ' accounts');
} finally {
    TriggerBypass.clear('AccountTriggerHandler');
}
```

### Metadata to deploy

**`force-app/main/default/objects/Account/fields/Segment__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Segment__c</fullName>
    <label>Segment</label>
    <length>20</length>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Account_Segment__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account_Segment__c</fullName>
    <label>Account Segment</label>
    <length>20</length>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Stage_Changed_On__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Stage_Changed_On__c</fullName>
    <label>Stage Changed On</label>
    <required>false</required>
    <type>Date</type>
</CustomField>
```

**`force-app/main/default/objects/Trigger_Setting__mdt/Trigger_Setting__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Trigger Setting</label>
    <pluralLabel>Trigger Settings</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/Trigger_Setting__mdt/fields/Is_Active__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Is_Active__c</fullName>
    <defaultValue>true</defaultValue>
    <fieldManageability>DeveloperControlled</fieldManageability>
    <label>Is Active</label>
    <type>Checkbox</type>
</CustomField>
```

**`force-app/main/default/customMetadata/Trigger_Setting.Account.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Account</label>
    <protected>false</protected>
    <values>
        <field>Is_Active__c</field>
        <value xsi:type="xsd:boolean">true</value>
    </values>
</CustomMetadata>
```

Create `Trigger_Setting.Opportunity.md-meta.xml` the same way with the label `Opportunity`.

**`force-app/main/default/customPermissions/Bypass_Triggers.customPermission-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">
    <isLicensed>false</isLicensed>
    <label>Bypass Triggers</label>
</CustomPermission>
```

**`force-app/main/default/permissionsets/Trigger_Bypass.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Trigger Bypass</label>
    <description>Skips all trigger handlers built on TriggerHandler. Assign sparingly.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <customPermissions>
        <enabled>true</enabled>
        <name>Bypass_Triggers</name>
    </customPermissions>
</PermissionSet>
```

### Test classes

**`force-app/main/default/classes/TriggerFrameworkTest.cls`**

```apex
@IsTest
private class TriggerFrameworkTest {
    // A recording handler lets us test the framework without any DML.
    private class RecordingHandler extends TriggerHandler {
        public List<String> calls = new List<String>();
        protected override void beforeInsert() {
            calls.add('beforeInsert');
        }
        protected override void afterUpdate() {
            calls.add('afterUpdate');
        }
    }

    private static TriggerContext contextFor(System.TriggerOperation op) {
        return new TriggerContext(op, 'Account', new List<Account>{ new Account(Name = 'Ctx') }, null);
    }

    @IsTest
    static void dispatchesToTheMatchingMethodOnly() {
        RecordingHandler handler = new RecordingHandler();
        handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
        handler.run(contextFor(System.TriggerOperation.BEFORE_DELETE));   // not overridden
        Assert.areEqual(new List<String>{ 'beforeInsert' }, handler.calls);
    }

    @IsTest
    static void codeBypassSkipsTheHandlerUntilCleared() {
        RecordingHandler handler = new RecordingHandler();
        TriggerBypass.bypass('TriggerFrameworkTest.RecordingHandler');
        handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
        Assert.isTrue(handler.calls.isEmpty(), 'Bypassed handler must not run');

        TriggerBypass.clearAll();
        handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
        Assert.areEqual(1, handler.calls.size());
    }

    @IsTest
    static void metadataToggleSkipsOneObjectOnly() {
        RecordingHandler handler = new RecordingHandler();
        TriggerSettings.testOverrides.put('Account', false);
        handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
        Assert.isTrue(handler.calls.isEmpty());

        TriggerSettings.testOverrides.put('Account', true);
        handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
        Assert.areEqual(1, handler.calls.size());
    }

    @IsTest
    static void aMissingMetadataRecordMeansActive() {
        Assert.isTrue(TriggerSettings.isActive('Never_Configured__c'));
    }

    @IsTest
    static void bypassPermissionSkipsTheHandlerForThatUser() {
        PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Trigger_Bypass' LIMIT 1];
        Profile standard = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        User u = new User(
            Alias = 'bypass', Email = 'bypass.user@example.com', LastName = 'Bypass',
            Username = 'bypass.' + System.currentTimeMillis() + '@example.com',
            ProfileId = standard.Id, TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'
        );
        // Setup objects (User, PermissionSetAssignment) go in their own context
        // to avoid a mixed DML error.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert u;
            insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
        }

        System.runAs(u) {
            RecordingHandler handler = new RecordingHandler();
            handler.run(contextFor(System.TriggerOperation.BEFORE_INSERT));
            Assert.isTrue(handler.calls.isEmpty(), 'Handler must skip for the bypass user');
        }
    }

    @IsTest
    static void aUserWithoutThePermissionIsNotBypassed() {
        Assert.isFalse(TriggerBypass.userHasBypassPermission());
    }

    @IsTest
    static void recursionGuardReturnsEachIdOncePerScope() {
        Id first = Id.valueOf('006000000000001');
        Id second = Id.valueOf('006000000000002');
        Set<Id> run1 = TriggerRecursionGuard.firstTime('scopeA', new Set<Id>{ first, second });
        Set<Id> run2 = TriggerRecursionGuard.firstTime('scopeA', new Set<Id>{ first });
        Set<Id> otherScope = TriggerRecursionGuard.firstTime('scopeB', new Set<Id>{ first });

        Assert.areEqual(2, run1.size());
        Assert.isTrue(run2.isEmpty(), 'Same scope and Id must be blocked');
        Assert.areEqual(1, otherScope.size(), 'A different scope must not be blocked');
    }

    @IsTest
    static void hasChangedComparesAgainstTheOldVersion() {
        Account before = new Account(Id = Id.valueOf('001000000000001'), Name = 'Old');
        Account after = new Account(Id = before.Id, Name = 'New');
        TriggerContext ctx = new TriggerContext(
            System.TriggerOperation.BEFORE_UPDATE, 'Account',
            new List<SObject>{ after }, new Map<Id, SObject>{ before.Id => before }
        );
        Assert.isTrue(ctx.hasChanged(after, Account.Name));
        Assert.isFalse(ctx.hasChanged(after, Account.Industry));
    }
}
```

**`force-app/main/default/classes/TriggerHandlersTest.cls`**

```apex
@IsTest
private class TriggerHandlersTest {
    private static List<Account> makeAccounts(Integer count, Integer employees) {
        List<Account> rows = new List<Account>();
        for (Integer i = 0; i < count; i++) {
            rows.add(new Account(Name = 'Harborview Test ' + i, NumberOfEmployees = employees));
        }
        return rows;
    }

    private static Opportunity makeOpp(Id accountId, String stage) {
        return new Opportunity(
            Name = 'Test opp', AccountId = accountId, StageName = stage,
            CloseDate = Date.today().addDays(30)
        );
    }

    @IsTest
    static void segmentsTwoHundredAccountsInOneChunk() {
        List<Account> rows = new List<Account>();
        for (Integer i = 0; i < 200; i++) {
            Integer employees = Math.mod(i, 3) == 0 ? 5000 : (Math.mod(i, 3) == 1 ? 500 : 10);
            rows.add(new Account(Name = 'Seg ' + i, NumberOfEmployees = employees));
        }

        Test.startTest();
        insert rows;
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Assert.areEqual(67, [SELECT COUNT() FROM Account WHERE Segment__c = 'Enterprise']);
        Assert.areEqual(67, [SELECT COUNT() FROM Account WHERE Segment__c = 'Mid-Market']);
        Assert.areEqual(66, [SELECT COUNT() FROM Account WHERE Segment__c = 'SMB']);
        Assert.areEqual(0, queries, 'The before trigger must not query');
    }

    @IsTest
    static void leavesSegmentEmptyWhenEmployeeCountIsUnknown() {
        Account acct = new Account(Name = 'No size');
        insert acct;
        Assert.isNull([SELECT Segment__c FROM Account WHERE Id = :acct.Id].Segment__c);
    }

    @IsTest
    static void propagatesNewSegmentToOpenOpportunitiesOnly() {
        List<Account> accounts = makeAccounts(200, 10);
        insert accounts;
        List<Opportunity> opps = new List<Opportunity>();
        for (Account acct : accounts) {
            opps.add(makeOpp(acct.Id, 'Prospecting'));
            opps.add(makeOpp(acct.Id, 'Closed Lost'));
        }
        insert opps;

        for (Account acct : accounts) {
            acct.NumberOfEmployees = 5000;
        }
        Test.startTest();
        update accounts;
        Integer queries = Limits.getQueries();
        Integer dmls = Limits.getDmlStatements();
        Test.stopTest();

        Assert.areEqual(200, [
            SELECT COUNT() FROM Opportunity WHERE IsClosed = false AND Account_Segment__c = 'Enterprise'
        ]);
        Assert.areEqual(200, [
            SELECT COUNT() FROM Opportunity WHERE IsClosed = true AND Account_Segment__c = 'SMB'
        ]);
        Assert.isTrue(queries <= 2, 'Queries used: ' + queries);
        Assert.isTrue(dmls <= 3, 'DML statements used: ' + dmls);
    }

    @IsTest
    static void createsOneOnboardingTaskPerWonOpportunityAndStampsTheDate() {
        Account acct = makeAccounts(1, 50)[0];
        insert acct;
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            opps.add(makeOpp(acct.Id, 'Prospecting'));
        }
        insert opps;

        for (Opportunity opp : opps) {
            opp.StageName = 'Closed Won';
        }
        Test.startTest();
        update opps;
        Test.stopTest();

        Assert.areEqual(200, [SELECT COUNT() FROM Task WHERE Subject = 'Kick off customer onboarding']);
        Assert.areEqual(200, [SELECT COUNT() FROM Opportunity WHERE Stage_Changed_On__c = :Date.today()]);

        // Saving again with no stage change must not create more Tasks.
        update opps;
        Assert.areEqual(200, [SELECT COUNT() FROM Task WHERE Subject = 'Kick off customer onboarding']);
    }

    @IsTest
    static void copiesTheAccountSegmentWhenAnOpportunityIsCreated() {
        Account acct = makeAccounts(1, 250)[0];
        insert acct;
        Opportunity opp = makeOpp(acct.Id, 'Prospecting');
        insert opp;
        Assert.areEqual('Mid-Market', [
            SELECT Account_Segment__c FROM Opportunity WHERE Id = :opp.Id
        ].Account_Segment__c);
    }

    @IsTest
    static void opportunityWithoutAnAccountSavesCleanly() {
        Opportunity opp = makeOpp(null, 'Prospecting');
        insert opp;
        Assert.isNull([SELECT Account_Segment__c FROM Opportunity WHERE Id = :opp.Id].Account_Segment__c);
    }

    @IsTest
    static void codeBypassSkipsTheAccountRules() {
        TriggerBypass.bypass('AccountTriggerHandler');
        Account acct = makeAccounts(1, 5000)[0];
        insert acct;
        Assert.isNull([SELECT Segment__c FROM Account WHERE Id = :acct.Id].Segment__c);
    }

    @IsTest
    static void metadataToggleSkipsTheOpportunityRules() {
        Account acct = makeAccounts(1, 5000)[0];
        insert acct;
        TriggerSettings.testOverrides.put('Opportunity', false);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting');
        insert opp;
        Assert.isNull([SELECT Account_Segment__c FROM Opportunity WHERE Id = :opp.Id].Account_Segment__c);
    }

    @IsTest
    static void segmentThresholdsAreInclusive() {
        Assert.areEqual('Enterprise', AccountTriggerHandler.segmentFor(1000));
        Assert.areEqual('Mid-Market', AccountTriggerHandler.segmentFor(999));
        Assert.areEqual('Mid-Market', AccountTriggerHandler.segmentFor(100));
        Assert.areEqual('SMB', AccountTriggerHandler.segmentFor(99));
    }
}
```

### Deploy and run

```bash
sf project generate --name harborview-triggers && cd harborview-triggers
# copy the files above into force-app/main/default/..., then:
sf project deploy start --source-dir force-app --target-org harborview
sf org assign permset --name Trigger_Bypass --target-org harborview   # only when testing the bypass
sf apex run test --class-names TriggerFrameworkTest --class-names TriggerHandlersTest \
  --code-coverage --result-format human --wait 10 --target-org harborview
sf apex run --file scripts/apex/fix-segments.apex --target-org harborview
```

Every class and trigger also needs a `-meta.xml` file with an API version. `sf apex generate class` and `sf apex generate trigger` create them. Use your org's current API version.

## What happens behind the scenes

Take the most demanding case: an integration updates 200 Accounts to 5,000 employees in one call, and each Account has open Opportunities.

1. **Chunking.** 200 records fit in one chunk, so each trigger runs once. With 450 records the platform would run the trigger three times (200, 200, 50) in the same transaction, and the static guard and bypass sets would be shared by all three runs.
2. **Before update, Account.** `AccountTrigger` calls `new AccountTriggerHandler().run()`. `TriggerContext.fromTrigger()` copies the `Trigger.*` variables. `skipReason()` checks the code switch (a set lookup), the custom permission (`FeatureManagement.checkPermission`) and the Custom Metadata record (cached, no SOQL). Then the `switch` calls `beforeUpdate()`, which sets `Segment__c` on the in-memory records. No query, no DML.
3. **Validation and save.** The platform runs validation rules and duplicate rules, then saves the Accounts without committing.
4. **After update, Account.** `afterUpdate()` sees that `Segment__c` changed, runs **one** SOQL query for the open Opportunities of all 200 accounts, and issues **one** DML statement for the ones whose segment differs.
5. **Nested triggers.** That Opportunity update fires `OpportunityTrigger` inside the same transaction. Its before-update logic sees no stage change and no account change, so it does nothing. Its after-update logic finds no new Closed Won, so no Task is created. Trigger depth is now 2. The platform stops a chain at a depth of 16.
6. **Later steps.** Workflow, after-save flows and roll-ups run. If any of them updates an Opportunity and re-fires the update trigger, the guard blocks a second onboarding Task.
7. **Commit.** Everything is committed together. If a validation rule on Opportunity rejects the segment copy, the `DmlException` is caught, `addError` marks the Accounts and the whole save rolls back.

Limits for that transaction, using the synchronous numbers from the Apex governor limits page: 1 of 100 SOQL queries, 2 of 150 DML statements, and 200 plus the number of Opportunities updated against the limit of 10,000 DML rows. The last number is the one to watch. If 200 Accounts each have 50 open Opportunities, the transaction reaches 10,200 DML rows and fails. For accounts with large pipelines, keep the Account trigger to a single `System.enqueueJob` call and do the copy in a Queueable (see [Queueable Apex complete guide](/articles/queueable-apex-complete-guide/)). The selector query can also hit the 50,000 row limit.

In a debug log (Setup, Debug Logs, or `sf apex tail log`) you will see lines like these:

```text
CODE_UNIT_STARTED|[EXTERNAL]|01q...|AccountTrigger on Account trigger event BeforeUpdate
CODE_UNIT_STARTED|[EXTERNAL]|01q...|AccountTrigger on Account trigger event AfterUpdate
SOQL_EXECUTE_BEGIN|[10]|Aggregations:0|FROM Opportunity WHERE AccountId IN :accountIds ...
SOQL_EXECUTE_END|[10]|Rows:420
DML_BEGIN|[...]|Op:Update|Type:Opportunity|Rows:420
CODE_UNIT_STARTED|[EXTERNAL]|01q...|OpportunityTrigger on Opportunity trigger event BeforeUpdate
USER_DEBUG|[...]|INFO|OpportunityTriggerHandler skipped: switched off in Trigger_Setting__mdt
```

The last line only appears when a switch is active. That is the line to search for when someone asks why automation "did not run".

## Test it and verify

1. Run both test classes: `sf apex run test --class-names TriggerFrameworkTest --class-names TriggerHandlersTest --code-coverage --result-format human --wait 10`. Expect 16 passing tests.
2. Create an Account in the UI with 1,200 employees. Open it and check that Segment is `Enterprise`. Change employees to 300 and save. Segment should become `Mid-Market`.
3. Create an Opportunity on that Account. Its Account Segment should be `Mid-Market`. Change the Account to 20 employees. The open Opportunity should switch to `SMB`. A Closed Won or Closed Lost Opportunity keeps its old value.
4. Move an Opportunity to Closed Won. Check Activities: one Task, "Kick off customer onboarding". Save the Opportunity again. There is still one Task.
5. Org switch: Setup, Custom Metadata Types, Trigger Setting, Manage Records, Opportunity, Edit, untick Is Active, save. Move another Opportunity to Closed Won. No Task is created. Tick it again to restore the behavior.
6. Person switch: assign `Trigger Bypass` to a test user (`sf org assign permset --name Trigger_Bypass --on-behalf-of <username>`), have that user create an Account with 5,000 employees, and check that Segment stays empty. Remove the assignment afterwards.
7. Code switch: run `scripts/apex/fix-segments.apex` in Execute Anonymous and check the log for the debug line and no `AccountTrigger` code unit doing work.

## Common mistakes and fixes

- **Symptom: "Too many SOQL queries: 101" after a data load.** Cause: a query inside a loop, usually inside a handler method that takes one record. Fix: every handler method takes a list, collects Ids, queries once and reads from a map.
- **Symptom: a second trigger on the same object behaves unpredictably.** Cause: two triggers on one object and event, so the platform picks the order. Fix: keep one trigger per object and add the second rule as a method call in the handler.
- **Symptom: the automation stopped for everyone after an incident.** Cause: someone left `Is_Active__c` unticked or left a user with `Bypass_Triggers`. Fix: log every skip (the framework does), restrict who can edit the Custom Metadata and who gets the permission set, and review assignments regularly.
- **Symptom: the framework throws on a healthy 10,000 record load.** Cause: a loop counter that counts handler runs. Chunks of 200 make the counter climb. Fix: guard by record Id as shown, not by run count.
- **Symptom: a record is skipped on a retry after a partial failure.** Cause: with partial-success DML (`allOrNone` false) the platform fires triggers again for the records that can still be saved, and static variables are not reset. A record that was marked in the guard on the first attempt is skipped on the second. Fix: use the guard only for work that is safe to skip on retry, scope it narrowly (as `TASK_SCOPE` does) and never use one global flag.
- **Symptom: the second update of a record re-creates a Task.** Cause: workflow field updates re-fire update triggers and `Trigger.old` still holds the pre-update values, so the stage still looks changed. Fix: the per-Id guard.
- **Symptom: the integration user cannot see why Opportunities were updated.** Cause: system-mode selectors ignore the user's permissions by design. Fix: that is the point, but document it in the class header and keep the mode confined to the selectors.
- **Symptom: a test cannot insert a Trigger Setting record.** Cause: Custom Metadata cannot be created by DML in a test. Fix: use the `TriggerSettings.testOverrides` hook, as the tests do.

## Key takeaways

- One trigger per object, one line in the trigger, and a handler that routes by `Trigger.operationType`.
- Give automation three independent switches: a code switch for scripts, a custom permission for people and a Custom Metadata record for the whole org.
- Guard recursion by record Id and by scope. Never count handler runs, because chunks of 200 make a healthy load look like a loop.
- Put SOQL in selectors and choose their sharing and access mode on purpose. Triggers themselves always run in system mode.
- Wrap the `Trigger.*` variables in a context object so the framework can be tested without DML.

## Where to go next

- [Apex triggers from scratch](/articles/apex-triggers-from-scratch/)
- [Advanced Apex triggers: order of execution and async handoff](/articles/apex-triggers-advanced/)
- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Record-triggered Flow best practices](/articles/record-triggered-flow-best-practices/)
- [Custom metadata, settings and labels](/articles/custom-metadata-settings-and-labels/)
- [Apex test classes: best practices](/articles/apex-test-classes-best-practices/)
