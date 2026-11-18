---
title: "Apex Triggers from Scratch: Events, Context Variables and Your First Trigger"
description: "Learn Apex trigger events, context variables, before vs after, addError and bulk-safe related-record updates with a lead and opportunity sales-ops build."
category: salesforce-development
tags: [Apex, Triggers, Beginner]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/apex-triggers-from-scratch.jpg
sources:
  - title: "Triggers (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm"
  - title: "Trigger Context Variables (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_triggers_context_variables.htm"
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm"
  - title: "SObject Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_methods_system_sobject.htm"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

A **trigger** is Apex code that the platform runs for you when a record is inserted, updated, deleted or undeleted. You do not call it. You write it once, attach it to an object, and from then on it runs for every save, whether the save comes from the UI, a Flow, an integration or a data load.

That reach is the reason triggers are both powerful and risky. A trigger can set defaults, reject bad data and update other records, and it can also fail a 10,000 row import at 2 a.m. if you wrote it for one record at a time. This article teaches the parts of a trigger you must understand before anything else: the seven events, the context variables, the difference between before and after, how `addError` stops a save, and why every trigger must handle a list of records. You build a first trigger, then a bulk-safe one that updates related records, with tests.

It deliberately stops short of frameworks. How to structure many rules, bypass switches and recursion guards is covered in [One trigger per object: a clean trigger handler pattern](/articles/trigger-handler-pattern/). Read this one first.

## The business scenario

Northgate Industrial Supply (a fictional distributor of factory equipment) has a sales-operations team that owns lead intake and the deal desk. They want these rules enforced on every save, from any source:

**Leads**

1. A lead with no source gets the source `Other`, so reports never have a blank bucket.
2. Email and company are cleaned (trimmed, email lowercased) and a **Region** (`AMER`, `EMEA`, `APAC`) is set from the country.
3. A rep cannot move a lead to `Working - Contacted` unless the lead has an email or a phone number.

**Opportunities**

4. New opportunities get a discount of 0 percent and a **next step due** date seven days out.
5. A discount above 20 percent needs a written reason.
6. An open opportunity cannot be given a close date in the past.
7. An opportunity cannot be moved to `Closed Won` while its Account is on **credit hold**.
8. Each Account shows its **won deal count, won amount total and last won date**, kept correct when deals are won, reopened, moved to another account, deleted or restored.

Rules 1 to 7 change or reject the record being saved, so they belong in **before** triggers. Rule 8 changes a different record, so it belongs in an **after** trigger. That split is the main lesson of this article.

## Before you start: setup

Nothing outside Salesforce is needed. There is no external system, API key or callout in this article. Menu labels can differ slightly by release, so use the Quick Find box in Setup if a path has moved (see the Setup documentation for your release).

### In Salesforce

1. **Use a safe org.** A Developer Edition org or a scratch org, never production. Why: you will deploy code and fields. Verify: you can open Setup and the Developer Console.
2. **Create the Lead field.** Setup, Object Manager, Lead, Fields & Relationships, New. Text, length 20, label `Region`, API name `Region__c`. Verify: it appears in the field list.
3. **Create the Opportunity fields.** `Discount_Percent__c` (Percent, length 3, decimal places 2), `Discount_Reason__c` (Text, 255) and `Next_Step_Due__c` (Date). Verify: all three are listed.
4. **Create the Account fields.** `Credit_Hold__c` (Checkbox, default unchecked), `Won_Amount_Total__c` (Currency, length 16, decimal places 2), `Won_Deal_Count__c` (Number, length 18, decimal places 0), `Last_Won_On__c` (Date). Why: rule 7 reads the checkbox and rule 8 writes the other three. Verify: all four are listed.
5. **Check field-level security.** When the wizard asks who can see each field, keep your own profile selected. Why: your test user must be able to read and edit them in the UI. Verify: open a Lead record page and add the field to the layout if it is missing.
6. **Check picklist values.** Lead Status needs `Working - Contacted`, and Opportunity Stage needs `Closed Won`, `Closed Lost` and `Prospecting`. Why: the code and tests compare against these exact labels. Verify: Setup, Object Manager, Lead, Fields, Status (and the same for Opportunity Stage). If your org renamed them, change the constants in the code.
7. **Turn on a debug log.** Setup, Debug Logs, New, pick your user. Why: you will read the trigger's lines in the log later. Verify: the entry appears with an expiry time.
8. **Create sample data.** Two Accounts: `Northgate Test Co` and `Credit Hold Test Co` (tick Credit Hold on the second). Verify: both open correctly.

The XML for steps 2 to 4 is in the advanced section if you prefer to deploy.

### On your machine

1. Install the Salesforce CLI (`sf`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version` prints a version.
2. Authorize the org: `sf org login web --alias northgate`. Verify: `sf org list` shows it.

## How it works

### Terms

A **trigger** is declared with the `trigger` keyword on one object and a list of **events**. An **event** pairs a time (`before` or `after`) with an operation (`insert`, `update`, `delete`, `undelete`). There are seven valid events: `before insert`, `before update`, `before delete`, `after insert`, `after update`, `after delete` and `after undelete`.

A **chunk** is a group of up to 200 records. When one DML statement touches more than 200 records, the trigger runs once per chunk, all inside the same transaction. **Context variables** are the read-only values the platform gives a trigger so it can see the records and the event. **System mode** means the trigger ignores the running user's object and field permissions and sharing; triggers cannot declare an access mode of their own, so push security-sensitive work into classes where you choose it.

### Before or after

| Question | Before trigger | After trigger |
|---|---|---|
| Is the record saved yet? | No. It has no Id on insert | Yes, in the transaction but not committed |
| Can I change the record's own fields? | Yes, directly, with no DML | No. `Trigger.new` is read-only |
| Typical use | Defaults, cleaning, validation | Related records, tasks, callouts handoff |
| Does a validation rule see my change? | Yes, rules run after before triggers | Not applicable |

### Which variables exist when

| Event | `Trigger.new` | `Trigger.newMap` | `Trigger.old` / `oldMap` | Edit `new`? |
|---|---|---|---|---|
| before insert | yes | no | no | yes |
| before update | yes | yes | yes | yes |
| before delete | no | no | yes | no |
| after insert | yes | yes | no | no |
| after update | yes | yes | yes | no |
| after delete | no | no | yes | no |
| after undelete | yes | yes | no | no |

This follows the context variables page in the sources. A variable that is "not available" is `null`, so `Trigger.old.size()` in an insert trigger throws a null pointer error. The other variables are `Trigger.isInsert`, `isUpdate`, `isDelete`, `isUndelete`, `isBefore`, `isAfter`, `isExecuting` and `Trigger.size` (the size of the current chunk only). The most useful one is `Trigger.operationType`, an enum (`System.TriggerOperation`) with one value per event, because you can branch on it with a `switch`.

### Where a trigger sits in a save

The documented order of execution, trimmed to the steps that matter here:

```text
1. Load the original record, apply the incoming field values
2. Record-triggered flows that run before save
3. BEFORE triggers                <- rules 1 to 7 run here
4. System validation and custom validation rules   (they see your changes)
5. Duplicate rules
6. Record saved to the database, not committed
7. AFTER triggers                 <- rule 8 runs here
8. Assignment rules, workflow, flows that run after save, roll-ups ...
9. Commit, then post-commit work (email, queued jobs)
```

### What addError does

`record.addError('message')` marks that record as failed and attaches the message. `record.Field__c.addError('message')` attaches it to one field, so the UI shows it under that field. The text is HTML-escaped by default. What happens next depends on how the DML was called. A plain `insert` or an edit in the UI is all-or-none: one failed record rolls back the whole statement. `Database.insert(list, false)`, the Bulk API and most integrations use partial success: only the failed records are rejected and the rest are saved.

### Why one trigger per object

Salesforce does not guarantee the order in which two triggers on the same object and event run. If one trigger lowercases an email and the other reads it, the result changes with the order. One trigger per object, which calls ordinary classes in a fixed order, removes the question. The next article, [Trigger handler pattern](/articles/trigger-handler-pattern/), builds the full structure. Here the trigger stays small: a `switch` on `Trigger.operationType` that calls static methods.

## Basic example

This is a complete first trigger for Lead. It does two things before a lead is saved: it fills a blank source and it rejects a lead with no way to contact it.

```apex
trigger LeadTrigger on Lead (before insert) {
    for (Lead lead : Trigger.new) {
        // Rule 1: default the source. Before triggers edit the record in place,
        // so there is no DML statement here.
        if (String.isBlank(lead.LeadSource)) {
            lead.LeadSource = 'Other';
        }
        // Reject the record. The message shows under the Email field in the UI.
        if (String.isBlank(lead.Email) && String.isBlank(lead.Phone)) {
            lead.Email.addError('Enter an email address or a phone number.');
        }
    }
}
```

Try it in the Developer Console (Debug, Open Execute Anonymous Window):

```apex
// Anonymous Apex
Lead ok = new Lead(LastName = 'Rivera', Company = 'Rivera Metalworks', Phone = '555-0100');
insert ok;
System.debug('Source: ' + [SELECT LeadSource FROM Lead WHERE Id = :ok.Id].LeadSource);

Lead bad = new Lead(LastName = 'Nguyen', Company = 'Nguyen Tooling');
Database.SaveResult result = Database.insert(bad, false);   // partial success: no exception
System.debug('Saved: ' + result.isSuccess());
System.debug('Error: ' + result.getErrors()[0].getMessage());
```

Expected output: `Source: Other`, then `Saved: false` and `Error: Enter an email address or a phone number.` The first lead was saved with its source filled in. The second was rejected before it reached the database. With a plain `insert bad;` the same trigger would throw a `DmlException` instead.

Two things go wrong for most beginners. The first is a query inside the loop, which works for one record and fails on the first large import:

```apex
trigger BadLeadTrigger on Lead (before insert) {
    for (Lead lead : Trigger.new) {
        // BAD: one query per record. 101 leads in one save = "Too many SOQL queries: 101".
        List<Account> match = [SELECT Id FROM Account WHERE Name = :lead.Company LIMIT 1];
        if (!match.isEmpty()) {
            lead.Description = 'Existing account: ' + match[0].Id;
        }
    }
}
```

The fix is to collect the company names, run one query, and read from a map (the advanced example does this for Accounts). The second mistake is trying to edit records in an after trigger:

```apex
trigger BadLeadAfterTrigger on Lead (after insert) {
    for (Lead lead : Trigger.new) {
        // BAD: Trigger.new is read-only in after triggers.
        // This throws System.FinalException: Record is read-only.
        lead.LeadSource = 'Other';
    }
}
```

The fix is to do the work in a before trigger, or to query the records again and update them (which costs an extra DML statement).

## Advanced end-to-end example

The files below implement all eight Northgate rules. The design is: one trigger per object that only routes, rule classes for the before logic, one service class for the Account totals, a small lookup class for the credit hold, and tests that prove the code on 200 records. The `LeadTrigger` here replaces the basic one above, because an object gets one trigger.

### Lead: trigger and rules

**`force-app/main/default/triggers/LeadTrigger.trigger`**

```apex
trigger LeadTrigger on Lead (before insert, before update) {
    switch on Trigger.operationType {
        when BEFORE_INSERT {
            LeadRules.beforeInsert(Trigger.new);
        }
        when BEFORE_UPDATE {
            LeadRules.beforeUpdate(Trigger.new, (Map<Id, Lead>) Trigger.oldMap);
        }
    }
}
```

**`force-app/main/default/classes/LeadRules.cls`**

```apex
public with sharing class LeadRules {
    @TestVisible
    private static final String DEFAULT_SOURCE = 'Other';
    @TestVisible
    private static final String WORKING_STATUS = 'Working - Contacted';
    @TestVisible
    private static final String UNKNOWN_REGION = 'Other';

    // Keys are lower case. Extend this map, or move it to Custom Metadata, as markets grow.
    private static final Map<String, String> REGION_BY_COUNTRY = new Map<String, String>{
        'united states' => 'AMER', 'usa' => 'AMER', 'canada' => 'AMER',
        'mexico' => 'AMER', 'brazil' => 'AMER',
        'united kingdom' => 'EMEA', 'germany' => 'EMEA', 'france' => 'EMEA',
        'netherlands' => 'EMEA', 'spain' => 'EMEA',
        'india' => 'APAC', 'japan' => 'APAC', 'australia' => 'APAC', 'singapore' => 'APAC'
    };

    public static void beforeInsert(List<Lead> leads) {
        for (Lead lead : leads) {
            normalize(lead);
            lead.Region__c = regionFor(lead.Country);
            requireContactDetailsWhenWorking(lead);
        }
    }

    public static void beforeUpdate(List<Lead> leads, Map<Id, Lead> oldMap) {
        for (Lead lead : leads) {
            Lead previous = oldMap.get(lead.Id);
            // Decide what changed before normalizing, so cleaning alone is not a "change".
            Boolean contactRelevantChange = lead.Status != previous.Status
                || lead.Email != previous.Email
                || lead.Phone != previous.Phone;
            Boolean countryChanged = lead.Country != previous.Country;

            normalize(lead);
            if (countryChanged || lead.Region__c == null) {
                lead.Region__c = regionFor(lead.Country);
            }
            // Only check when something relevant changed, so old leads that already
            // break the rule can still be edited for unrelated reasons.
            if (contactRelevantChange) {
                requireContactDetailsWhenWorking(lead);
            }
        }
    }

    @TestVisible
    private static String regionFor(String country) {
        if (String.isBlank(country)) {
            return null;
        }
        return REGION_BY_COUNTRY.get(country.trim().toLowerCase()) ?? UNKNOWN_REGION;
    }

    private static void normalize(Lead lead) {
        if (String.isBlank(lead.LeadSource)) {
            lead.LeadSource = DEFAULT_SOURCE;
        }
        if (lead.Email != null) {
            lead.Email = lead.Email.trim().toLowerCase();
        }
        if (lead.Company != null) {
            lead.Company = lead.Company.trim();
        }
    }

    private static void requireContactDetailsWhenWorking(Lead lead) {
        if (lead.IsConverted || lead.Status != WORKING_STATUS) {
            return;
        }
        if (String.isBlank(lead.Email) && String.isBlank(lead.Phone)) {
            lead.Email.addError(
                'Add an email address or a phone number before marking this lead as working.'
            );
        }
    }
}
```

The class is `with sharing`, but a trigger always runs in system mode, so sharing never blocks these rules. The keyword matters when the same class is called from somewhere else.

### Opportunity: trigger and before rules

**`force-app/main/default/triggers/OpportunityTrigger.trigger`**

```apex
trigger OpportunityTrigger on Opportunity (
    before insert, before update,
    after insert, after update, after delete, after undelete
) {
    switch on Trigger.operationType {
        when BEFORE_INSERT {
            OpportunityRules.beforeSave(Trigger.new, null);
        }
        when BEFORE_UPDATE {
            OpportunityRules.beforeSave(Trigger.new, (Map<Id, Opportunity>) Trigger.oldMap);
        }
        when AFTER_INSERT, AFTER_UNDELETE {
            AccountWonTotals.afterSave(Trigger.new, null);
        }
        when AFTER_UPDATE {
            AccountWonTotals.afterSave(Trigger.new, (Map<Id, Opportunity>) Trigger.oldMap);
        }
        when AFTER_DELETE {
            AccountWonTotals.afterDelete(Trigger.old);
        }
    }
}
```

**`force-app/main/default/classes/OpportunityRules.cls`**

```apex
public with sharing class OpportunityRules {
    @TestVisible
    private static final Decimal REASON_REQUIRED_ABOVE = 20;
    private static final String CLOSED_WON = 'Closed Won';
    private static final String CLOSED_LOST = 'Closed Lost';

    // previousById is null on insert. On update it holds the old versions by Id.
    public static void beforeSave(List<Opportunity> opps, Map<Id, Opportunity> previousById) {
        List<Opportunity> becomingWon = new List<Opportunity>();
        for (Opportunity opp : opps) {
            Opportunity previous = previousById == null ? null : previousById.get(opp.Id);
            applyDefaults(opp);
            validateDiscount(opp, previous);
            validateCloseDate(opp, previous);
            if (opp.StageName == CLOSED_WON && opp.AccountId != null
                && (previous == null || previous.StageName != CLOSED_WON)) {
                becomingWon.add(opp);
            }
        }
        blockWhenOnCreditHold(becomingWon);
    }

    private static Boolean isClosed(Opportunity opp) {
        return opp.StageName == CLOSED_WON || opp.StageName == CLOSED_LOST;
    }

    private static void applyDefaults(Opportunity opp) {
        if (opp.Discount_Percent__c == null) {
            opp.Discount_Percent__c = 0;
        }
        if (opp.Next_Step_Due__c == null && !isClosed(opp)) {
            opp.Next_Step_Due__c = Date.today().addDays(7);
        }
    }

    private static void validateDiscount(Opportunity opp, Opportunity previous) {
        if (opp.Discount_Percent__c <= REASON_REQUIRED_ABOVE) {
            return;
        }
        Boolean touched = previous == null
            || opp.Discount_Percent__c != previous.Discount_Percent__c
            || opp.Discount_Reason__c != previous.Discount_Reason__c;
        if (touched && String.isBlank(opp.Discount_Reason__c)) {
            opp.Discount_Reason__c.addError(
                'Explain why this deal needs a discount above ' + REASON_REQUIRED_ABOVE + '%.'
            );
        }
    }

    private static void validateCloseDate(Opportunity opp, Opportunity previous) {
        if (isClosed(opp) || opp.CloseDate == null) {
            return;
        }
        Boolean touched = previous == null
            || opp.CloseDate != previous.CloseDate
            || opp.StageName != previous.StageName;
        if (touched && opp.CloseDate < Date.today()) {
            opp.CloseDate.addError('The close date of an open opportunity cannot be in the past.');
        }
    }

    // One query for the whole chunk, however many opportunities are becoming won.
    private static void blockWhenOnCreditHold(List<Opportunity> becomingWon) {
        if (becomingWon.isEmpty()) {
            return;
        }
        Set<Id> accountIds = new Set<Id>();
        for (Opportunity opp : becomingWon) {
            accountIds.add(opp.AccountId);
        }
        Set<Id> onHold = new CreditHoldLookup().onHold(accountIds);
        for (Opportunity opp : becomingWon) {
            if (onHold.contains(opp.AccountId)) {
                opp.StageName.addError(
                    'This account is on credit hold. Finance must release it before the deal can close.'
                );
            }
        }
    }
}
```

**`force-app/main/default/classes/CreditHoldLookup.cls`**

```apex
// Deliberately without sharing and in system mode: the credit hold is a finance control.
// A sales rep who cannot see the account, or the Credit_Hold__c field, must not be able
// to skip the rule because of what their permissions hide.
public without sharing class CreditHoldLookup {
    public Set<Id> onHold(Set<Id> accountIds) {
        Map<Id, Account> held = new Map<Id, Account>([
            SELECT Id
            FROM Account
            WHERE Id IN :accountIds AND Credit_Hold__c = true
            WITH SYSTEM_MODE
        ]);
        return held.keySet();
    }
}
```

### Opportunity: after logic that updates Accounts

**`force-app/main/default/classes/AccountWonTotals.cls`**

```apex
// Without sharing on purpose: the totals must count every won opportunity on the account,
// not only the ones the saving user can see. The Account update also runs in system mode.
public without sharing class AccountWonTotals {

    public static void afterSave(List<Opportunity> newList, Map<Id, Opportunity> oldMap) {
        Set<Id> accountIds = new Set<Id>();
        for (Opportunity opp : newList) {
            Opportunity previous = oldMap == null ? null : oldMap.get(opp.Id);
            if (!isRelevantChange(opp, previous)) {
                continue;
            }
            if (opp.AccountId != null) {
                accountIds.add(opp.AccountId);
            }
            // The deal moved away from another account: that account needs a recount too.
            if (previous != null && previous.AccountId != null) {
                accountIds.add(previous.AccountId);
            }
        }
        recalculate(accountIds, newList);
    }

    // Trigger.old is the only list available after a delete.
    public static void afterDelete(List<Opportunity> deleted) {
        Set<Id> accountIds = new Set<Id>();
        for (Opportunity opp : deleted) {
            if (opp.IsWon && opp.AccountId != null) {
                accountIds.add(opp.AccountId);
            }
        }
        recalculate(accountIds, deleted);
    }

    // Skip the work unless a won deal is involved and a field we sum has changed.
    private static Boolean isRelevantChange(Opportunity current, Opportunity previous) {
        Boolean wasWon = previous != null && previous.IsWon;
        if (!current.IsWon && !wasWon) {
            return false;
        }
        if (previous == null) {
            return true;
        }
        return current.IsWon != previous.IsWon
            || current.Amount != previous.Amount
            || current.AccountId != previous.AccountId
            || current.CloseDate != previous.CloseDate;
    }

    // One aggregate query and one DML statement, for any number of accounts.
    private static void recalculate(Set<Id> accountIds, List<Opportunity> triggerRecords) {
        if (accountIds.isEmpty()) {
            return;
        }
        // Start every account at zero, so an account that lost its last won deal is reset.
        Map<Id, Account> totals = new Map<Id, Account>();
        for (Id accountId : accountIds) {
            totals.put(accountId, new Account(
                Id = accountId,
                Won_Amount_Total__c = 0,
                Won_Deal_Count__c = 0,
                Last_Won_On__c = null
            ));
        }
        for (AggregateResult row : [
            SELECT AccountId acct, SUM(Amount) sumAmount, COUNT(Id) deals, MAX(CloseDate) lastWon
            FROM Opportunity
            WHERE AccountId IN :accountIds AND IsWon = true
            WITH SYSTEM_MODE
            GROUP BY AccountId
        ]) {
            Account target = totals.get((Id) row.get('acct'));
            target.Won_Amount_Total__c = (Decimal) row.get('sumAmount') ?? 0;
            target.Won_Deal_Count__c = Integer.valueOf(row.get('deals'));
            target.Last_Won_On__c = (Date) row.get('lastWon');
        }
        try {
            Database.update(totals.values(), true, AccessLevel.SYSTEM_MODE);
        } catch (DmlException e) {
            // Failing loudly keeps the totals and the deals consistent: the save rolls back.
            for (Opportunity opp : triggerRecords) {
                opp.addError('Could not update the account totals: ' + e.getDmlMessage(0));
            }
        }
    }
}
```

### Metadata to deploy

The fields from the setup steps, as files. Every other field follows the same shape.

**`force-app/main/default/objects/Lead/fields/Region__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Region__c</fullName>
    <label>Region</label>
    <length>20</length>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Discount_Percent__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Discount_Percent__c</fullName>
    <label>Discount Percent</label>
    <precision>5</precision>
    <scale>2</scale>
    <required>false</required>
    <type>Percent</type>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Discount_Reason__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Discount_Reason__c</fullName>
    <label>Discount Reason</label>
    <length>255</length>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Next_Step_Due__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Next_Step_Due__c</fullName>
    <label>Next Step Due</label>
    <required>false</required>
    <type>Date</type>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Credit_Hold__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Credit_Hold__c</fullName>
    <defaultValue>false</defaultValue>
    <label>Credit Hold</label>
    <type>Checkbox</type>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Won_Amount_Total__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Won_Amount_Total__c</fullName>
    <label>Won Amount Total</label>
    <precision>16</precision>
    <scale>2</scale>
    <required>false</required>
    <type>Currency</type>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Won_Deal_Count__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Won_Deal_Count__c</fullName>
    <label>Won Deal Count</label>
    <precision>18</precision>
    <scale>0</scale>
    <required>false</required>
    <type>Number</type>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Last_Won_On__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Last_Won_On__c</fullName>
    <label>Last Won On</label>
    <required>false</required>
    <type>Date</type>
</CustomField>
```

Fields deployed by source are not visible to any profile until a permission set or profile grants them. Add them to a permission set (see [Permission sets vs profiles](/articles/permission-sets-vs-profiles/)) or tick visibility in the UI.

### Tests

**`force-app/main/default/classes/LeadTriggerTest.cls`**

```apex
@IsTest
private class LeadTriggerTest {
    private static Lead newLead(String lastName, String email, String phone) {
        return new Lead(LastName = lastName, Company = 'Co ' + lastName, Email = email, Phone = phone);
    }

    @IsTest
    static void defaultsAndCleansTheLead() {
        Lead lead = newLead('Rivera', '  Pat.Rivera@Example.COM ', null);
        lead.Company = '  Rivera Metalworks  ';
        lead.Country = 'Germany';
        insert lead;

        Lead saved = [
            SELECT LeadSource, Email, Company, Region__c FROM Lead WHERE Id = :lead.Id
        ];
        Assert.areEqual('Other', saved.LeadSource);
        Assert.areEqual('pat.rivera@example.com', saved.Email);
        Assert.areEqual('Rivera Metalworks', saved.Company);
        Assert.areEqual('EMEA', saved.Region__c);
    }

    @IsTest
    static void keepsAnExplicitSource() {
        Lead lead = newLead('Source', 'a@example.com', null);
        lead.LeadSource = 'Web';
        insert lead;
        Assert.areEqual('Web', [SELECT LeadSource FROM Lead WHERE Id = :lead.Id].LeadSource);
    }

    @IsTest
    static void unknownCountryGetsTheFallbackAndBlankCountryGetsNone() {
        Assert.areEqual('Other', LeadRules.regionFor('Atlantis'));
        Assert.areEqual('AMER', LeadRules.regionFor(' CANADA '));
        Assert.isNull(LeadRules.regionFor(null));
    }

    @IsTest
    static void regionFollowsACountryChange() {
        Lead lead = newLead('Mover', 'mover@example.com', null);
        lead.Country = 'Japan';
        insert lead;
        lead.Country = 'France';
        update lead;
        Assert.areEqual('EMEA', [SELECT Region__c FROM Lead WHERE Id = :lead.Id].Region__c);
    }

    @IsTest
    static void workingLeadNeedsAnEmailOrAPhone() {
        Lead lead = newLead('NoContact', null, null);
        insert lead;                                     // an open lead is allowed
        lead.Status = LeadRules.WORKING_STATUS;

        Database.SaveResult result = Database.update(lead, false);
        Assert.isFalse(result.isSuccess());
        Assert.isTrue(result.getErrors()[0].getMessage().contains('email address or a phone'));

        lead.Phone = '555-0100';
        Assert.isTrue(Database.update(lead, false).isSuccess());
    }

    @IsTest
    static void editingAnUnrelatedFieldIsNeverBlocked() {
        Lead lead = newLead('Plain', null, null);
        insert lead;
        lead.Title = 'Buyer';
        update lead;
        Assert.areEqual('Buyer', [SELECT Title FROM Lead WHERE Id = :lead.Id].Title);
    }

    @IsTest
    static void partialSuccessRejectsOnlyTheBadRecords() {
        List<Lead> leads = new List<Lead>();
        for (Integer i = 0; i < 200; i++) {
            Boolean bad = Math.mod(i, 10) == 0;       // 20 working leads without contact details
            Lead lead = newLead('Bulk' + i, bad ? null : 'bulk' + i + '@example.com', null);
            if (bad) {
                lead.Status = LeadRules.WORKING_STATUS;
            }
            leads.add(lead);
        }

        Test.startTest();
        List<Database.SaveResult> results = Database.insert(leads, false);
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Integer failures = 0;
        for (Database.SaveResult result : results) {
            if (!result.isSuccess()) {
                failures++;
            }
        }
        Assert.areEqual(20, failures);
        Assert.areEqual(180, [SELECT COUNT() FROM Lead WHERE LastName LIKE 'Bulk%']);
        Assert.areEqual(0, queries, 'The lead trigger must not run any query');
    }
}
```

**`force-app/main/default/classes/OpportunityTriggerTest.cls`**

```apex
@IsTest
private class OpportunityTriggerTest {
    private static Account makeAccount(String name, Boolean creditHold) {
        Account acct = new Account(Name = name, Credit_Hold__c = creditHold);
        insert acct;
        return acct;
    }

    private static Opportunity makeOpp(Id accountId, String stage, Decimal amount) {
        return new Opportunity(
            Name = 'Deal ' + stage, AccountId = accountId, StageName = stage,
            CloseDate = Date.today().addDays(30), Amount = amount
        );
    }

    private static Account reload(Id accountId) {
        return [
            SELECT Won_Amount_Total__c, Won_Deal_Count__c, Last_Won_On__c
            FROM Account WHERE Id = :accountId
        ];
    }

    // Decimal fields are compared as whole numbers to keep the asserts simple.
    private static Integer totalOf(Id accountId) {
        return reload(accountId).Won_Amount_Total__c.intValue();
    }

    private static Integer countOf(Id accountId) {
        return reload(accountId).Won_Deal_Count__c.intValue();
    }

    @IsTest
    static void appliesDefaultsToTwoHundredNewOpportunities() {
        Account acct = makeAccount('Defaults Co', false);
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            opps.add(makeOpp(acct.Id, 'Prospecting', 1000));
        }

        Test.startTest();
        insert opps;
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Assert.areEqual(200, [
            SELECT COUNT() FROM Opportunity
            WHERE Discount_Percent__c = 0 AND Next_Step_Due__c = :Date.today().addDays(7)
        ]);
        Assert.areEqual(0, queries, 'Open deals need no query at all');
    }

    @IsTest
    static void discountAboveTheThresholdNeedsAReason() {
        Account acct = makeAccount('Discount Co', false);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting', 5000);
        opp.Discount_Percent__c = 25;

        Database.SaveResult rejected = Database.insert(opp, false);
        Assert.isFalse(rejected.isSuccess());
        Assert.isTrue(rejected.getErrors()[0].getMessage().contains('discount above 20'));

        opp.Discount_Reason__c = 'Competitor price match';
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void discountExactlyAtTheThresholdPasses() {
        Account acct = makeAccount('Edge Co', false);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting', 5000);
        opp.Discount_Percent__c = 20;
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void openOpportunityCannotHaveAPastCloseDate() {
        Account acct = makeAccount('Dates Co', false);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting', 1000);
        opp.CloseDate = Date.today().addDays(-1);
        Assert.isFalse(Database.insert(opp, false).isSuccess());

        opp.StageName = 'Closed Lost';                // a closed deal may have a past date
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void creditHoldBlocksClosedWonUntilReleased() {
        Account acct = makeAccount('Hold Co', true);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting', 8000);
        insert opp;

        opp.StageName = 'Closed Won';
        Database.SaveResult blocked = Database.update(opp, false);
        Assert.isFalse(blocked.isSuccess());
        Assert.isTrue(blocked.getErrors()[0].getMessage().contains('credit hold'));

        acct.Credit_Hold__c = false;
        update acct;
        Assert.isTrue(Database.update(opp, false).isSuccess());
    }

    @IsTest
    static void twoHundredWinsCostOneLookupAndOneTotalsQuery() {
        Account acct = makeAccount('Bulk Won Co', false);
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            opps.add(makeOpp(acct.Id, 'Prospecting', 100));
        }
        insert opps;

        for (Opportunity opp : opps) {
            opp.StageName = 'Closed Won';
        }
        Test.startTest();
        update opps;
        Integer queries = Limits.getQueries();
        Integer dmls = Limits.getDmlStatements();
        Test.stopTest();

        Assert.areEqual(20000, totalOf(acct.Id));
        Assert.areEqual(200, countOf(acct.Id));
        Assert.isTrue(queries <= 2, 'Queries used: ' + queries);
        Assert.isTrue(dmls <= 2, 'DML statements used: ' + dmls);
    }

    @IsTest
    static void totalsFollowWinReopenMoveDeleteAndUndelete() {
        Account first = makeAccount('First Co', false);
        Account second = makeAccount('Second Co', false);
        List<Opportunity> opps = new List<Opportunity>{
            makeOpp(first.Id, 'Closed Won', 1000),
            makeOpp(first.Id, 'Closed Won', 2000),
            makeOpp(first.Id, 'Closed Won', 3000)
        };
        opps[0].CloseDate = Date.today().addDays(-10);
        opps[1].CloseDate = Date.today().addDays(-5);
        opps[2].CloseDate = Date.today().addDays(-1);
        insert opps;

        Assert.areEqual(6000, totalOf(first.Id));
        Assert.areEqual(3, countOf(first.Id));
        Assert.areEqual(Date.today().addDays(-1), reload(first.Id).Last_Won_On__c);

        opps[2].StageName = 'Closed Lost';            // reopen or lose a won deal
        update opps[2];
        Assert.areEqual(3000, totalOf(first.Id));

        opps[1].AccountId = second.Id;                // move a deal: both accounts change
        update opps[1];
        Assert.areEqual(1000, totalOf(first.Id));
        Assert.areEqual(2000, totalOf(second.Id));

        delete opps[1];
        Assert.areEqual(0, totalOf(second.Id));
        Assert.isNull(reload(second.Id).Last_Won_On__c);

        undelete opps[1];
        Assert.areEqual(2000, totalOf(second.Id));
        Assert.areEqual(1, countOf(second.Id));
    }

    @IsTest
    static void editingAnOpenDealDoesNotTouchTheAccount() {
        Account acct = makeAccount('Quiet Co', false);
        Opportunity opp = makeOpp(acct.Id, 'Prospecting', 500);
        insert opp;

        Test.startTest();
        opp.Amount = 900;
        update opp;
        Integer dmls = Limits.getDmlStatements();
        Test.stopTest();

        Assert.areEqual(1, dmls, 'Only the opportunity update, no Account DML');
    }

    @IsTest
    static void twoHundredAccountsAreRecalculatedTogether() {
        List<Account> accounts = new List<Account>();
        for (Integer i = 0; i < 200; i++) {
            accounts.add(new Account(Name = 'Many ' + i));
        }
        insert accounts;
        List<Opportunity> opps = new List<Opportunity>();
        for (Account acct : accounts) {
            opps.add(makeOpp(acct.Id, 'Closed Won', 250));
        }

        Test.startTest();
        insert opps;
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Assert.areEqual(200, [
            SELECT COUNT() FROM Account
            WHERE Name LIKE 'Many %' AND Won_Amount_Total__c = 250 AND Won_Deal_Count__c = 1
        ]);
        Assert.isTrue(queries <= 2, 'Queries used: ' + queries);
    }
}
```

### Deploy and run

**`scripts/apex/try-deal-rules.apex`**

```apex
// Anonymous Apex
// Shows a rejected save, an accepted save and the roll-up in one run.
Account acct = new Account(Name = 'Script Test Co');
insert acct;

Opportunity opp = new Opportunity(
    Name = 'Script deal', AccountId = acct.Id, StageName = 'Prospecting',
    CloseDate = Date.today().addDays(14), Amount = 12000, Discount_Percent__c = 30
);
Database.SaveResult first = Database.insert(opp, false);
System.debug('Without a reason, saved: ' + first.isSuccess());
System.debug('Reason: ' + first.getErrors()[0].getMessage());

opp.Discount_Reason__c = 'Multi-year commitment';
insert opp;
opp.StageName = 'Closed Won';
update opp;

Account result = [
    SELECT Won_Amount_Total__c, Won_Deal_Count__c, Last_Won_On__c FROM Account WHERE Id = :acct.Id
];
System.debug('Totals: ' + result.Won_Amount_Total__c + ' / ' + result.Won_Deal_Count__c);
```

```bash
sf project generate --name northgate-sales-ops && cd northgate-sales-ops
# Copy the files above into force-app/main/default/... and scripts/apex/, then:
sf project deploy start --source-dir force-app --target-org northgate
sf apex run test --class-names LeadTriggerTest --class-names OpportunityTriggerTest \
  --code-coverage --result-format human --wait 10 --target-org northgate
sf apex run --file scripts/apex/try-deal-rules.apex --target-org northgate
sf apex tail log --target-org northgate
```

Every class and trigger needs a `-meta.xml` file that holds an API version. `sf apex generate class` and `sf apex generate trigger` create them, and they use your project's current API version. Use your org's current API version rather than copying a number from an article.

## What happens behind the scenes

Take the heaviest ordinary case: an integration updates 200 Opportunities to `Closed Won` in one call. All 200 belong to one Account.

1. **One chunk, one trigger run.** 200 records fit in one chunk, so `OpportunityTrigger` runs once for `before update` and once for `after update`. With 450 records the platform would run both events three times (200, 200, 50) in the same transaction, and every limit below is shared across the three runs.
2. **Before update.** `Trigger.operationType` is `BEFORE_UPDATE`. `OpportunityRules.beforeSave` loops over `Trigger.new` and applies defaults. Because the stage changed to `Closed Won`, each record joins the `becomingWon` list. After the loop there is **one** SOQL query in `CreditHoldLookup` for the distinct account Ids. No hold means no `addError`.
3. **Validation and save.** The platform now runs validation rules and duplicate rules. A validation rule on Opportunity would see the defaults the trigger just wrote. Then the records are saved to the database without being committed.
4. **After update.** `AccountWonTotals.afterSave` compares each new record with `Trigger.oldMap`. `IsWon` flipped, so every record is relevant. The set of account Ids has one member. **One** aggregate query returns one row with the sum, count and latest close date, and **one** DML statement updates the Account.
5. **Later steps.** Workflow, flows that run after save, roll-ups and sharing recalculation run, then the transaction commits. If anything throws, including a validation rule on Account rejecting the totals update, the `DmlException` is caught, `addError` marks the Opportunities, and the whole save rolls back, including the stage changes.
6. **Limits for this save**, using the synchronous numbers from the governor limits page: 2 of 100 SOQL queries, 2 of 150 DML statements, and 201 of 10,000 DML rows (200 Opportunities plus 1 Account). A trigger-fired chain also has a recursion depth limit of 16.

The limit to watch is the last one. If one call touches 200 Accounts, the totals update adds 200 rows. A parent update that fires another trigger runs inside the same transaction, so that trigger's queries also count against the 100.

Because totals come from an aggregate query rather than from "add this amount", the result stays correct however many times a deal is edited, moved or restored. A running `+=` would drift the first time a trigger ran twice.

In the debug log you will see lines like these:

```text
CODE_UNIT_STARTED|[EXTERNAL]|01q...|OpportunityTrigger on Opportunity trigger event BeforeUpdate
SOQL_EXECUTE_BEGIN|[11]|Aggregations:0|FROM Account WHERE Id IN :accountIds AND Credit_Hold__c = true
SOQL_EXECUTE_END|[11]|Rows:0
CODE_UNIT_FINISHED|OpportunityTrigger on Opportunity trigger event BeforeUpdate
CODE_UNIT_STARTED|[EXTERNAL]|01q...|OpportunityTrigger on Opportunity trigger event AfterUpdate
SOQL_EXECUTE_BEGIN|[34]|Aggregations:3|FROM Opportunity WHERE AccountId IN :accountIds AND IsWon = true
SOQL_EXECUTE_END|[34]|Rows:1
DML_BEGIN|[52]|Op:Update|Type:Account|Rows:1
```

Search the log for `CODE_UNIT_STARTED` to see each event, and for `LIMIT_USAGE_FOR_NS` at the end to see the totals for the transaction.

## Test it and verify

1. Run the tests: `sf apex run test --class-names LeadTriggerTest --class-names OpportunityTriggerTest --code-coverage --result-format human --wait 10`. Expect 16 passing tests and no failures. If a test fails on a picklist value, step 6 of the setup does not match your org.
2. Run the script `scripts/apex/try-deal-rules.apex`. The log should show `Without a reason, saved: false`, the reason text, and `Totals: 12000.00 / 1`.
3. In the UI, create a Lead with no source and a country of `Singapore`. After saving, Lead Source is `Other` and Region is `APAC`.
4. Edit that lead, set Status to `Working - Contacted` with no email and no phone. The error appears under the Email field. Add a phone number and save again.
5. Create an Opportunity on `Northgate Test Co` with a 25 percent discount and no reason. The error appears under Discount Reason. Fill it in and save.
6. Move an Opportunity on `Credit Hold Test Co` to `Closed Won`. The save fails under Stage. Untick Credit Hold on the Account, retry, and it succeeds.
7. Open `Northgate Test Co` and check the three won fields. Move the Opportunity to another account and watch both accounts change.
8. Import 200 opportunities with Data Loader or the Bulk API, half of them with a 40 percent discount and no reason. Half should load and half should show the error message in the failure file. This is partial success in practice.

## Common mistakes and fixes

- **Symptom: `Too many SOQL queries: 101` on an import.** Cause: a query inside the loop over `Trigger.new`. Fix: collect the Ids first, query once, store the result in a map and read from the map. The credit hold lookup above is the pattern.
- **Symptom: `System.FinalException: Record is read-only`.** Cause: the code sets a field on `Trigger.new` in an after trigger. Fix: move the logic to a before trigger, or update a fresh copy of the record with DML (and accept the extra statement).
- **Symptom: `Attempt to de-reference a null object` on insert.** Cause: `Trigger.old` or `Trigger.oldMap` was used in an insert trigger, or `Trigger.newMap` in a before insert trigger. Fix: check the table above, or guard with `Trigger.isUpdate`. The rule methods here take the old map as a parameter and accept `null`.
- **Symptom: a rule blocks edits on old records.** Cause: the check runs on every save, so a record that already breaks the rule cannot be edited for any reason. Fix: validate only when a relevant field changed, as `validateDiscount` and `validateCloseDate` do.
- **Symptom: `addError` on one record fails every record in the import.** Cause: the load uses all-or-none DML, such as a plain `insert` in Apex. Fix: use `Database.insert(records, false)` in your own code and confirm that your integration or loader allows partial success.
- **Symptom: `UNABLE_TO_LOCK_ROW` during a large load.** Cause: many opportunities for the same Account are saved in parallel batches, and each batch updates the same Account row. Fix: sort the load by Account Id, lower the parallelism (or use serial mode in the Bulk API), and keep the Account update to one statement.
- **Symptom: totals are wrong after an Opportunity is moved to another Account.** Cause: the code only recounted the new Account. Fix: add the old Account Id from `Trigger.oldMap`, as `afterSave` does.
- **Symptom: a validation rule or flow disagrees with your trigger.** Cause: wrong assumption about order. Before-save flows run before the trigger, and validation rules run after it. Fix: read the order of execution page and test both layers together.
- **Symptom: two triggers on one object behave differently in each org.** Cause: the platform does not guarantee the order of triggers on the same object and event. Fix: one trigger per object, calling classes in a fixed order.

## Key takeaways

- A trigger runs on seven events. Use `Trigger.operationType` in a `switch` so each event calls exactly one method.
- Use before triggers to change or reject the record being saved. Use after triggers to change other records. Records in `Trigger.new` are read-only after the save.
- Check the context variable table before using `Trigger.old` or `Trigger.newMap`. A variable that is not available is `null`.
- `addError` rejects a record, not a statement. Whether the rest of the batch survives depends on the caller's all-or-none setting.
- Write every trigger for a list of up to 200 records: no SOQL or DML inside loops, aggregate queries for totals, and tests that load 200 records and assert the query count.

## Where to go next

- [One trigger per object: a clean trigger handler pattern](/articles/trigger-handler-pattern/)
- [Advanced Apex triggers: order of execution and async handoff](/articles/apex-triggers-advanced/)
- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
- [Validation rule patterns](/articles/validation-rule-patterns/)
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Apex test classes: best practices](/articles/apex-test-classes-best-practices/)
- [Flow vs Apex](/articles/flow-vs-apex/)
