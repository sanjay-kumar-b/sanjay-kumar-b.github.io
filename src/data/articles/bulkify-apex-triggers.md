---
title: "Bulkify Your Apex Triggers: Stop Hitting Governor Limits"
description: "Why Apex triggers must handle 200 records at a time, and how Sets, Maps, aggregate and relationship queries keep a renewal trigger under governor limits."
category: salesforce-development
tags: [Apex, Triggers, Governor Limits, Best Practices]
publishedAt: 2026-11-03
updatedAt: 2026-11-13
cover: /images/covers/bulkify-apex-triggers.jpg
featured: true
sources:
  - title: "Apex Developer Guide: Execution Governors and Limits"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm"
  - title: "Apex Developer Guide: Triggers"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers.htm"
  - title: "Trigger Context Variables (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_triggers_context_variables.htm"
  - title: "Limits Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_methods_system_limits.htm"
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
---

A trigger that works for one record in the UI can fail the moment someone loads 200 records through Data Loader or an integration. The cause is almost always the same: a query or a DML statement inside a loop. Each pass of the loop spends part of a small, fixed budget called a **governor limit**, and at record 101 the budget runs out.

This article shows how to make a trigger **bulk-safe**: its cost stays the same whether it receives 1 record or 200. We build one realistic renewal trigger twice, once the wrong way and once the right way, then write tests that prove the right version stays under the limits for 200 records and for 10,000. If you are new to triggers, read [Apex triggers from scratch](/articles/apex-triggers-from-scratch/) first.

## The business scenario

Meridian Analytics (a fictional SaaS company) sells annual subscriptions priced per licensed seat. Sixty days before renewal, an account manager moves the **Subscription** to the status Renewal Quoted. The platform must then:

1. Count the licensed **Contacts** on the Account. Each one is a seat.
2. Price the renewal: seats times the seat price, plus a tier uplift (Standard 4%, Premier 8%, Enterprise 12%) that finance keeps in Custom Metadata.
3. Reject the quote if the Account has no licensed Contacts.
4. Grant a renewal **entitlement** (a record saying a Contact may use a feature) to every licensed Contact.
5. When a Contact loses its license, deactivate that Contact's active entitlements.

Account managers do this one record at a time, but customer success loads renewals in bulk: 200 rows at a time from Data Loader, sometimes thousands in one run. The code must cope with both.

## Before you start: setup

No external system is needed to build and test this. You only need Data Loader (or the CLI) to run the large load. Menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved.

### In Salesforce

1. **Use a Developer Edition org, scratch org or sandbox.** Why: you will load thousands of test rows. Verify: you can open Setup and run `sf org list`.
2. **Create the custom objects and fields.** Setup, Object Manager, Create, Custom Object. Why: the code uses these API names. Verify: each shows in Object Manager.

   | Object | Field (API name) | Type |
   |---|---|---|
   | Contact | Is_Licensed__c | Checkbox |
   | Subscription__c | Account__c | Lookup(Account) |
   | Subscription__c | Status__c | Picklist: Active, Renewal_Quoted, Renewed |
   | Subscription__c | Plan_Tier__c | Picklist: Standard, Premier, Enterprise |
   | Subscription__c | Seat_Price__c, Renewal_Price__c | Currency |
   | Subscription__c | Licensed_Seats__c | Number(5,0) |
   | Entitlement_Grant__c | Subscription__c, Contact__c | Lookup(Subscription), Lookup(Contact) |
   | Entitlement_Grant__c | Feature__c | Text(40) |
   | Entitlement_Grant__c | Active__c | Checkbox, default checked |
   | Entitlement_Grant__c | Entitlement_Key__c | Text(40), External ID, Unique |

3. **Create the Custom Metadata Type `Renewal_Tier__mdt`** with a Number field `Uplift_Pct__c`. Add three records named Standard, Premier and Enterprise (the name must match the picklist value). Why: finance can change uplifts without a deployment, and `getAll()` reads them without a SOQL query. Verify: Manage Records lists three rows.
4. **Give yourself access.** Create a permission set with Read, Create and Edit on the two custom objects and the new Contact field, and assign it to your user. Why: the Data Loader user needs it. Verify: you can open a Subscription record.
5. **Seed test accounts.** Run the anonymous Apex in the Test it and verify section. Why: the 10,000-row load needs real Account Ids. Verify: `SELECT COUNT() FROM Account WHERE Name LIKE 'LoadTest%'` returns 100.

### On your machine

1. **Install Data Loader and the Salesforce CLI.** Data Loader is available from Setup (search "Data Loader") or from the official Data Loader documentation. Why: it sends records in fixed-size batches, like an integration. Verify: `sf --version` prints a version and Data Loader opens.

## How it works

A trigger runs once per **chunk**: a group of up to 200 records, delivered in `Trigger.new`. A DML statement on more than 200 records runs the trigger once per chunk, all in the same transaction. A **transaction** is one unit of work with one set of governor limits. Data Loader in SOAP mode sends batches of up to 200 records, and each batch is its own transaction (check the Data Loader guide for batch size in Bulk API mode). Apex code that inserts 10,000 records in one statement is different: 50 chunks share one set of limits.

The limits that matter here (verified in the Apex Developer Guide, synchronous column):

| Limit | Value |
|---|---|
| SOQL queries issued | 100 (200 async) |
| Records retrieved by SOQL | 50,000 |
| DML statements | 150 |
| Records processed by DML | 10,000 |
| CPU time | 10,000 ms (60,000 ms async) |

A query inside a loop over 200 records spends 200 queries. At the 101st, Apex throws `System.LimitException`, which you cannot catch. The whole transaction rolls back.

The tools that keep cost flat:

| Tool | Use it to |
|---|---|
| `Set<Id>` | Collect parent Ids once, with no duplicates, so one query can use `IN :ids` |
| `Map<Id, SObject>` | Look a record up by Id with no inner loop. The constructor `new Map<Id, Account>(queryResult)` builds one in a single line |
| `Map<Id, List<SObject>>` | Group child records under their parent |
| Aggregate query | Let the database count, sum or group (`COUNT`, `SUM`, `GROUP BY`) and return one row per group instead of every record |
| Relationship query | Fetch a parent and its children in one query: child-to-parent with dots (`Account__r.Name`), parent-to-child with a subquery (`SELECT Id, (SELECT Id FROM Contacts) FROM Account`) |
| `List<SObject>` for DML | Add records inside the loop, run one `insert`, `update` or `upsert` after it |

The pattern for every trigger: **collect Ids, query once, loop with Map lookups, write once**.

## Basic example

This trigger sets `Licensed_Seats__c` on new subscriptions. It uses a Set, one aggregate query and a Map. The query count is 1 for 1 record and 1 for 200.

```apex
trigger SubscriptionSeatsTrigger on Subscription__c (before insert) {
    // 1. Collect the parent Ids once.
    Set<Id> accountIds = new Set<Id>();
    for (Subscription__c s : Trigger.new) {
        if (s.Account__c != null) {
            accountIds.add(s.Account__c);
        }
    }

    // 2. One aggregate query: one row per account, not one per contact.
    Map<Id, Integer> seats = new Map<Id, Integer>();
    for (AggregateResult ar : [
        SELECT AccountId acct, COUNT(Id) total
        FROM Contact
        WHERE AccountId IN :accountIds AND Is_Licensed__c = true
        GROUP BY AccountId
    ]) {
        seats.put((Id) ar.get('acct'), (Integer) ar.get('total'));
    }

    // 3. Look up in memory. Changes to Trigger.new in a before trigger need no DML.
    for (Subscription__c s : Trigger.new) {
        s.Licensed_Seats__c = seats.containsKey(s.Account__c) ? seats.get(s.Account__c) : 0;
    }
}
```

Expected result: insert a Subscription for an Account with five licensed Contacts and `Licensed_Seats__c` saves as 5. Replace this trigger with the advanced version below before deploying that one, because the advanced trigger covers the same event.

## Advanced end-to-end example

First, the wrong way. These two classes are labelled as bad on purpose, and they are syntactically valid. Do not deploy them.

**`bad-example/RenewalPricingBad.cls`** (do not deploy)

```apex
// BAD VERSION: two queries per record. 200 records = 400 queries, fails at the 101st.
public with sharing class RenewalPricingBad {
    public static void price(List<Subscription__c> subs) {
        for (Subscription__c s : subs) {
            Integer seats = [
                SELECT COUNT() FROM Contact
                WHERE AccountId = :s.Account__c AND Is_Licensed__c = true
            ];
            Renewal_Tier__mdt tier = [
                SELECT Uplift_Pct__c FROM Renewal_Tier__mdt
                WHERE DeveloperName = :s.Plan_Tier__c LIMIT 1
            ];
            s.Renewal_Price__c = seats * s.Seat_Price__c * (1 + tier.Uplift_Pct__c / 100);
        }
    }
}
```

**`bad-example/RenewalEntitlementsBad.cls`** (do not deploy)

```apex
// BAD VERSION: a query per subscription plus one DML statement per contact.
// 200 subscriptions x 5 contacts = 200 queries and 1,000 DML statements (limit 150).
public with sharing class RenewalEntitlementsBad {
    public static void grant(List<Subscription__c> subs) {
        for (Subscription__c s : subs) {
            for (Contact c : [
                SELECT Id FROM Contact
                WHERE AccountId = :s.Account__c AND Is_Licensed__c = true
            ]) {
                insert new Entitlement_Grant__c(
                    Subscription__c = s.Id, Contact__c = c.Id, Active__c = true);
            }
        }
    }
}
```

Now the right way. Triggers stay one line, a handler routes, services hold the rules, and one selector owns the queries.

**`force-app/main/default/triggers/SubscriptionTrigger.trigger`**

```apex
trigger SubscriptionTrigger on Subscription__c (before insert, before update, after update) {
    SubscriptionTriggerHandler.run();
}
```

**`force-app/main/default/triggers/ContactLicenseTrigger.trigger`**

```apex
trigger ContactLicenseTrigger on Contact (after update) {
    ContactLicenseHandler.afterUpdate(Trigger.new, Trigger.oldMap);
}
```

**`force-app/main/default/classes/SubscriptionTriggerHandler.cls`**

```apex
public with sharing class SubscriptionTriggerHandler {
    public static void run() {
        List<Subscription__c> subs = (List<Subscription__c>) Trigger.new;
        Map<Id, Subscription__c> oldMap = (Map<Id, Subscription__c>) Trigger.oldMap;

        if (Trigger.isBefore) {
            RenewalPricingService.price(subs, oldMap);
        } else if (Trigger.isAfter && Trigger.isUpdate) {
            RenewalEntitlementService.grant(subs, oldMap);
        }
    }
}
```

**`force-app/main/default/classes/ContactSelector.cls`**

This is the only class that queries Contacts. It is `without sharing` on purpose: the renewal price must count every licensed Contact, so it cannot depend on which records the account manager can see. It returns data to code only.

```apex
public without sharing class ContactSelector {

    // Aggregate query: one row per account, however many contacts it has.
    public static Map<Id, Integer> licensedSeatsByAccount(Set<Id> accountIds) {
        Map<Id, Integer> seats = new Map<Id, Integer>();
        if (accountIds.isEmpty()) {
            return seats;
        }
        for (AggregateResult ar : [
            SELECT AccountId acct, COUNT(Id) total
            FROM Contact
            WHERE AccountId IN :accountIds AND Is_Licensed__c = true
            GROUP BY AccountId
        ]) {
            seats.put((Id) ar.get('acct'), (Integer) ar.get('total'));
        }
        return seats;
    }

    // Relationship query: parents and their licensed children in one query.
    public static Map<Id, List<Contact>> licensedContactsByAccount(Set<Id> accountIds) {
        Map<Id, List<Contact>> result = new Map<Id, List<Contact>>();
        if (accountIds.isEmpty()) {
            return result;
        }
        for (Account a : [
            SELECT Id, (SELECT Id FROM Contacts WHERE Is_Licensed__c = true)
            FROM Account
            WHERE Id IN :accountIds
        ]) {
            result.put(a.Id, a.Contacts);
        }
        return result;
    }
}
```

**`force-app/main/default/classes/RenewalPricingService.cls`**

Pricing runs in a before trigger, so it edits `Trigger.new` directly and needs no DML. `addError` rejects only the bad record when the load uses partial success.

```apex
public with sharing class RenewalPricingService {
    @TestVisible
    private static Map<String, Renewal_Tier__mdt> tierOverride;

    private static Map<String, Renewal_Tier__mdt> tiers() {
        // getAll() reads Custom Metadata from the cache: no SOQL query.
        return tierOverride != null ? tierOverride : Renewal_Tier__mdt.getAll();
    }

    public static void price(List<Subscription__c> subs, Map<Id, Subscription__c> oldMap) {
        List<Subscription__c> targets = new List<Subscription__c>();
        Set<Id> accountIds = new Set<Id>();
        for (Subscription__c s : subs) {
            if (!needsPricing(s, oldMap)) {
                continue;
            }
            targets.add(s);
            if (s.Account__c != null) {
                accountIds.add(s.Account__c);
            }
        }
        if (targets.isEmpty()) {
            return; // nothing to do: zero queries spent
        }

        Map<Id, Integer> seatsByAccount = ContactSelector.licensedSeatsByAccount(accountIds);
        Map<String, Renewal_Tier__mdt> tierMap = tiers();

        for (Subscription__c s : targets) {
            Integer seats = seatsByAccount.containsKey(s.Account__c)
                ? seatsByAccount.get(s.Account__c) : 0;
            Renewal_Tier__mdt tier = tierMap.get(s.Plan_Tier__c);

            if (seats == 0) {
                s.addError('Renewal needs at least one licensed contact on the account.');
            } else if (tier == null || s.Seat_Price__c == null) {
                s.addError('Set a plan tier and seat price before quoting a renewal.');
            } else {
                s.Licensed_Seats__c = seats;
                s.Renewal_Price__c =
                    (seats * s.Seat_Price__c * (1 + tier.Uplift_Pct__c / 100)).setScale(2);
            }
        }
    }

    private static Boolean needsPricing(Subscription__c s, Map<Id, Subscription__c> oldMap) {
        Subscription__c before = oldMap == null ? null : oldMap.get(s.Id);
        return s.Status__c == 'Renewal_Quoted'
            && (before == null || before.Status__c != s.Status__c);
    }
}
```

**`force-app/main/default/classes/RenewalEntitlementService.cls`**

The service builds every grant in memory, then writes them with one upsert. It checks the DML row budget first: anything that would not fit goes to a Queueable instead of throwing a limit exception. The external key makes the upsert safe to repeat.

```apex
public with sharing class RenewalEntitlementService {
    private static final Integer ROW_RESERVE = 500;

    public static void grant(List<Subscription__c> subs, Map<Id, Subscription__c> oldMap) {
        Map<Id, Subscription__c> quoted = new Map<Id, Subscription__c>();
        Set<Id> accountIds = new Set<Id>();
        for (Subscription__c s : subs) {
            Subscription__c before = oldMap.get(s.Id);
            if (s.Status__c == 'Renewal_Quoted' && before.Status__c != s.Status__c
                && s.Account__c != null) {
                quoted.put(s.Id, s);
                accountIds.add(s.Account__c);
            }
        }
        if (quoted.isEmpty()) {
            return;
        }

        Map<Id, List<Contact>> contactsByAccount =
            ContactSelector.licensedContactsByAccount(accountIds);

        List<Entitlement_Grant__c> grants = new List<Entitlement_Grant__c>();
        for (Subscription__c s : quoted.values()) {
            List<Contact> seats = contactsByAccount.get(s.Account__c);
            if (seats == null) {
                continue;
            }
            for (Contact c : seats) {
                grants.add(new Entitlement_Grant__c(
                    Entitlement_Key__c = s.Id + '-' + c.Id,
                    Subscription__c = s.Id,
                    Contact__c = c.Id,
                    Feature__c = s.Plan_Tier__c,
                    Active__c = true));
            }
        }

        // Stay inside the 10,000-row DML limit; defer the overflow.
        Integer budget = Math.max(0, Limits.getLimitDmlRows() - Limits.getDmlRows() - ROW_RESERVE);
        List<Entitlement_Grant__c> now = new List<Entitlement_Grant__c>();
        List<Entitlement_Grant__c> later = new List<Entitlement_Grant__c>();
        for (Entitlement_Grant__c g : grants) {
            if (now.size() < budget) {
                now.add(g);
            } else {
                later.add(g);
            }
        }

        // One DML statement for every grant; one bad row does not block the rest.
        List<Database.UpsertResult> results =
            Database.upsert(now, Entitlement_Grant__c.Entitlement_Key__c, false);
        Set<Id> failedSubs = new Set<Id>();
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                failedSubs.add(now[i].Subscription__c);
            }
        }
        for (Id subId : failedSubs) {
            // Rolls back this subscription's save, and only this one.
            quoted.get(subId).addError('Could not create renewal entitlements. Try again.');
        }
        if (!later.isEmpty()) {
            System.enqueueJob(new EntitlementGrantJob(later));
        }
    }
}
```

**`force-app/main/default/classes/EntitlementGrantJob.cls`**

```apex
public with sharing class EntitlementGrantJob implements Queueable {
    private static final Integer SLICE = 5000;
    private final List<Entitlement_Grant__c> grants;

    public EntitlementGrantJob(List<Entitlement_Grant__c> grants) {
        this.grants = grants;
    }

    public void execute(QueueableContext context) {
        List<Entitlement_Grant__c> slice = new List<Entitlement_Grant__c>();
        List<Entitlement_Grant__c> rest = new List<Entitlement_Grant__c>();
        for (Entitlement_Grant__c g : grants) {
            if (slice.size() < SLICE) {
                slice.add(g);
            } else {
                rest.add(g);
            }
        }
        List<Database.UpsertResult> results =
            Database.upsert(slice, Entitlement_Grant__c.Entitlement_Key__c, false);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Grant failed: ' + slice[i].Entitlement_Key__c
                    + ' ' + results[i].getErrors()[0].getMessage());
            }
        }
        if (!rest.isEmpty()) {
            System.enqueueJob(new EntitlementGrantJob(rest)); // chain the remainder
        }
    }
}
```

**`force-app/main/default/classes/ContactLicenseHandler.cls`**

```apex
public with sharing class ContactLicenseHandler {
    public static void afterUpdate(List<Contact> contacts, Map<Id, Contact> oldMap) {
        Set<Id> revoked = new Set<Id>();
        for (Contact c : contacts) {
            Contact before = oldMap.get(c.Id);
            if (before.Is_Licensed__c == true && c.Is_Licensed__c != true) {
                revoked.add(c.Id);
            }
        }
        if (revoked.isEmpty()) {
            return;
        }

        // One query for every revoked contact, one DML for every grant found.
        List<Entitlement_Grant__c> active = [
            SELECT Id FROM Entitlement_Grant__c
            WHERE Contact__c IN :revoked AND Active__c = true
        ];
        for (Entitlement_Grant__c g : active) {
            g.Active__c = false;
        }
        Database.update(active, false);
    }
}
```

**`force-app/main/default/customMetadata/Renewal_Tier.Premier.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Premier</label>
    <protected>false</protected>
    <values>
        <field>Uplift_Pct__c</field>
        <value xsi:type="xsd:double">8.0</value>
    </values>
</CustomMetadata>
```

**`force-app/main/default/objects/Contact/fields/Is_Licensed__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Is_Licensed__c</fullName>
    <defaultValue>false</defaultValue>
    <label>Is Licensed</label>
    <type>Checkbox</type>
</CustomField>
```

### The proof: tests for 200 and 10,000 records

A test cannot catch a `LimitException`, so we prove the limits differently. We read `Limits.getQueries()` and `Limits.getDmlStatements()` before and after the statement under test, then assert the difference. A bulkified trigger spends a small number that does not grow with the batch.

One honest note about 10,000 records. A single statement of 10,000 rows is 50 chunks in one transaction, so the per-chunk cost is multiplied by 50 and must stay under 100 in total. That is the harshest case. Data Loader splits the same file into separate batches, so each batch has its own budget.

**`force-app/main/default/classes/SubscriptionBulkLoadTest.cls`**

```apex
@IsTest
private class SubscriptionBulkLoadTest {

    @TestSetup
    static void tiers() {
        // Nothing to insert: tiers come from the in-memory override below.
        System.assert(true);
    }

    private static void useTestTiers() {
        RenewalPricingService.tierOverride = new Map<String, Renewal_Tier__mdt>{
            'Premier' => new Renewal_Tier__mdt(DeveloperName = 'Premier', Uplift_Pct__c = 8)
        };
    }

    private static List<Account> makeAccounts(Integer accounts, Integer licensedEach) {
        List<Account> list1 = new List<Account>();
        for (Integer i = 0; i < accounts; i++) {
            list1.add(new Account(Name = 'Renewal Acct ' + i));
        }
        insert list1;

        List<Contact> contacts = new List<Contact>();
        for (Account a : list1) {
            for (Integer j = 0; j < licensedEach; j++) {
                contacts.add(new Contact(
                    LastName = 'Seat ' + j, AccountId = a.Id, Is_Licensed__c = true));
            }
            contacts.add(new Contact(
                LastName = 'Viewer', AccountId = a.Id, Is_Licensed__c = false));
        }
        insert contacts;
        return list1;
    }

    private static List<Subscription__c> makeSubs(
        List<Account> accounts, Integer count, String status
    ) {
        List<Subscription__c> subs = new List<Subscription__c>();
        for (Integer i = 0; i < count; i++) {
            subs.add(new Subscription__c(
                Account__c = accounts[Math.mod(i, accounts.size())].Id,
                Status__c = status, Plan_Tier__c = 'Premier', Seat_Price__c = 100));
        }
        return subs;
    }

    @IsTest
    static void chunkOf200UsesAFixedNumberOfQueriesAndOneUpsert() {
        useTestTiers();
        List<Account> accounts = makeAccounts(20, 5);
        List<Subscription__c> subs = makeSubs(accounts, 200, 'Active');
        insert subs;

        List<Subscription__c> quote = new List<Subscription__c>();
        for (Subscription__c s : subs) {
            quote.add(new Subscription__c(Id = s.Id, Status__c = 'Renewal_Quoted'));
        }

        Test.startTest();
        Integer q0 = Limits.getQueries();
        Integer d0 = Limits.getDmlStatements();
        Integer r0 = Limits.getDmlRows();
        update quote;
        Integer queries = Limits.getQueries() - q0;
        Integer statements = Limits.getDmlStatements() - d0;
        Integer rows = Limits.getDmlRows() - r0;
        Test.stopTest();

        System.Assert.isTrue(queries <= 3, 'Queries used: ' + queries);
        System.Assert.isTrue(statements <= 2, 'DML statements used: ' + statements);
        System.Assert.areEqual(1200, rows, '200 updates + 200 x 5 grants');
        System.Assert.areEqual(200,
            [SELECT COUNT() FROM Subscription__c WHERE Renewal_Price__c = 540]);
        System.Assert.areEqual(1000,
            [SELECT COUNT() FROM Entitlement_Grant__c WHERE Active__c = true]);
    }

    @IsTest
    static void tenThousandRowsInOneTransactionStayUnderLimits() {
        useTestTiers();
        List<Account> accounts = makeAccounts(100, 3);
        List<Subscription__c> subs = makeSubs(accounts, 10000, 'Renewal_Quoted');

        Test.startTest();
        Integer q0 = Limits.getQueries();
        Integer d0 = Limits.getDmlStatements();
        insert subs; // 10,000 rows = 50 chunks of 200 in one transaction
        Integer queries = Limits.getQueries() - q0;
        Integer statements = Limits.getDmlStatements() - d0;
        Integer cpu = Limits.getCpuTime();
        Test.stopTest();

        // One aggregate query per chunk: 50 chunks, well under the limit of 100.
        System.Assert.isTrue(queries <= 55, 'Queries used: ' + queries);
        System.Assert.areEqual(1, statements);
        System.Assert.isTrue(cpu < Limits.getLimitCpuTime() * 7 / 10, 'CPU ms: ' + cpu);
        System.Assert.areEqual(10000,
            [SELECT COUNT() FROM Subscription__c WHERE Renewal_Price__c = 324]);
    }

    @IsTest
    static void accountWithoutLicensedContactsFailsAlone() {
        useTestTiers();
        List<Account> good = makeAccounts(1, 4);
        Account empty = new Account(Name = 'No seats');
        insert empty;

        List<Subscription__c> subs = new List<Subscription__c>{
            makeSubs(good, 1, 'Renewal_Quoted')[0],
            new Subscription__c(Account__c = empty.Id, Status__c = 'Renewal_Quoted',
                Plan_Tier__c = 'Premier', Seat_Price__c = 100)
        };
        List<Database.SaveResult> results = Database.insert(subs, false);

        System.Assert.isTrue(results[0].isSuccess());
        System.Assert.isFalse(results[1].isSuccess());
        System.Assert.isTrue(results[1].getErrors()[0].getMessage().contains('licensed contact'));
    }

    @IsTest
    static void revoking200LicensesDeactivatesTheirGrantsInOneQuery() {
        useTestTiers();
        List<Account> accounts = makeAccounts(1, 200);
        Subscription__c sub = makeSubs(accounts, 1, 'Active')[0];
        insert sub;
        update new Subscription__c(Id = sub.Id, Status__c = 'Renewal_Quoted');
        System.Assert.areEqual(200,
            [SELECT COUNT() FROM Entitlement_Grant__c WHERE Active__c = true]);

        List<Contact> revoke = new List<Contact>();
        for (Contact c : [SELECT Id FROM Contact WHERE Is_Licensed__c = true]) {
            revoke.add(new Contact(Id = c.Id, Is_Licensed__c = false));
        }

        Test.startTest();
        Integer q0 = Limits.getQueries();
        Integer d0 = Limits.getDmlStatements();
        update revoke;
        Integer queries = Limits.getQueries() - q0;
        Integer statements = Limits.getDmlStatements() - d0;
        Test.stopTest();

        System.Assert.isTrue(queries <= 2, 'Queries used: ' + queries);
        System.Assert.isTrue(statements <= 2, 'DML statements used: ' + statements);
        System.Assert.areEqual(0,
            [SELECT COUNT() FROM Entitlement_Grant__c WHERE Active__c = true]);
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org my-dev-org
sf apex run test --class-names SubscriptionBulkLoadTest --code-coverage \
  --result-format human --wait 15 --target-org my-dev-org
```

## What happens behind the scenes

Take a Data Loader batch of 200 subscriptions moving to Renewal Quoted.

1. **Chunk and validation.** The API receives 200 rows and runs the save path once for the batch. Before-save flows run first. `SubscriptionTrigger` fires once with `Trigger.isBefore` true and 200 records in `Trigger.new`.
2. **Before trigger.** `RenewalPricingService` loops 200 records to build a Set of Account Ids, then runs one aggregate query. Twenty accounts means 20 result rows, not 100 Contact rows. It sets prices by direct field assignment. Cost: 1 query, 0 DML.
3. **Validation and save.** The platform runs validation rules on the priced records, writes the rows without committing, and runs after triggers.
4. **After trigger.** `RenewalEntitlementService` runs one relationship query: 1 query. It builds 1,000 grants in memory, checks the DML row budget, and sends one upsert: 1 DML statement, 1,000 rows. The update itself added 1 statement and 200 rows, which matches the test's 2 statements and 1,200 rows.
5. **Commit.** If any subscription still carries an error, only that one is rejected when the load uses partial success. Otherwise the transaction commits.

Compare with the bad version for the same batch: 200 COUNT queries, 200 metadata queries, 200 Contact queries and 1,000 single-row inserts. It dies at the 101st query. The good version spends 2 queries and 2 DML statements. The limits are 100 and 150, so that leaves a lot of room for flows and other triggers sharing the transaction.

In a debug log, look for `SOQL_EXECUTE_BEGIN` lines (you should see exactly two), `DML_BEGIN` lines with `Rows:200` and `Rows:1000`, and the `LIMIT_USAGE_FOR_NS` block at the end showing `Number of SOQL queries: 2 out of 100`. Use Event Monitoring or the Apex Jobs page to watch the Queueable that handles any overflow.

## Test it and verify

1. Run the test class (command above). All four methods should pass.
2. Seed 100 accounts with licensed contacts. Run this in Developer Console, Debug, Open Execute Anonymous Apex:

   ```apex
   // Anonymous Apex
   List<Account> accounts = new List<Account>();
   for (Integer i = 0; i < 100; i++) {
       accounts.add(new Account(Name = 'LoadTest ' + i));
   }
   insert accounts;
   List<Contact> contacts = new List<Contact>();
   for (Account a : accounts) {
       for (Integer j = 0; j < 3; j++) {
           contacts.add(new Contact(LastName = 'Seat ' + j, AccountId = a.Id,
               Is_Licensed__c = true));
       }
   }
   insert contacts;
   ```

3. Export the account Ids and build a CSV with 10,000 rows:

   ```bash
   sf data query --query "SELECT Id FROM Account WHERE Name LIKE 'LoadTest%'" \
     --result-format csv --target-org my-dev-org > accounts.csv
   awk -F, 'NR>1 {ids[n++]=$1} END {
     print "Account__c,Status__c,Plan_Tier__c,Seat_Price__c"
     for (i=0;i<10000;i++) print ids[i%n] ",Renewal_Quoted,Premier,100"
   }' accounts.csv | tr -d '"' > subscriptions.csv
   ```

4. In Data Loader choose Insert, object Subscription, and the CSV. In Settings set the batch size to 200. Run it. Expect 10,000 successes.
5. Run `SELECT COUNT() FROM Subscription__c WHERE Renewal_Price__c = 324`. Expect 10,000.
6. To see the failure path, add one row for an Account without licensed Contacts. Expect one error row saying the renewal needs a licensed contact, and every other row saved.

## Common mistakes and fixes

- **Symptom: `Too many SOQL queries: 101`.** Cause: a query inside a loop, often in a method called from the loop. Fix: search the trigger and every class it calls for `[SELECT` under a `for`, collect Ids first, query once.
- **Symptom: `Too many DML statements: 151`.** Cause: `insert` or `update` inside a loop. Fix: add records to a List and run one statement after the loop.
- **Symptom: it works at 200 and fails at 5,000 in one script.** Cause: 25 chunks share one set of limits, so a fixed per-chunk cost adds up. Fix: measure the per-chunk cost, multiply by chunks, or move the work to Batch Apex or a Queueable.
- **Symptom: `Too many query rows: 50001`.** Cause: a parent-to-child subquery or plain query pulling every Contact. Fix: use an aggregate query when you only need counts, filter hard, and select only the fields you use.
- **Symptom: `Apex CPU time limit exceeded` with no queries in a loop.** Cause: nested loops over two big lists. Fix: put one list in a Map and look up by key.
- **Symptom: a null `Account__c` causes `Attempt to de-reference a null object`.** Cause: `accounts.get(null)` returns null and the next line uses it. Fix: guard nulls when building the Set and when reading the Map.
- **Symptom: one bad row fails the whole 200 batch.** Cause: all-or-none DML. Fix: use `Database.insert(list, false)`, read results by index, or call `addError` on that record in a before trigger.
- **Symptom: tests pass with one record and fail in production.** Cause: tests never loaded a full chunk. Fix: always test with 200, and assert `Limits` deltas as above.

## Key takeaways

- A trigger receives up to 200 records per chunk, and a bigger DML statement runs several chunks in one transaction.
- Collect Ids in a Set, query once, look up in a Map, write once.
- Let the database aggregate with `COUNT` and `GROUP BY`, and use subqueries to fetch parents and children together.
- `System.LimitException` cannot be caught, so prove bulk safety with `Limits` assertions in tests.
- Check the DML row budget before large writes and hand the overflow to a Queueable.

## Where to go next

- [Advanced Apex triggers](/articles/apex-triggers-advanced/) for order of execution, recursion and async handoff.
- [Trigger handler pattern](/articles/trigger-handler-pattern/) for one trigger per object.
- [SOQL relationships and aggregate queries](/articles/soql-relationships-and-aggregate-queries/) for the query side.
- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/) for every limit in one place.
- [Apex test classes best practices](/articles/apex-test-classes-best-practices/) for the testing habits used here.
