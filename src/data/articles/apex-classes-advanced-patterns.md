---
title: "Advanced Apex Classes: Interfaces, Abstraction, Selectors and Services"
description: "Design maintainable Apex: interfaces, abstract classes, a metadata-driven factory, service and selector layers and secure data access, with tests."
category: salesforce-development
tags: [Apex, Classes, Architecture, Advanced]
publishedAt: 2026-11-08
updatedAt: 2026-11-14
cover: /images/covers/apex-classes-advanced-patterns.jpg
sources:
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
---

Once your org grows, the question changes from "does it work?" to "can five developers change it safely?". The patterns in this article answer that. Each one separates *what changes* from *what stays the same*, so a new requirement means adding a class instead of editing five.

You will build one small pricing feature and use four patterns in it: an **interface** for swappable behavior, an **abstract class** for a shared workflow, a **factory driven by Custom Metadata** so admins can wire in a new strategy without a code change, and a **selector and service** pair that keeps SOQL and business rules apart.

## The business scenario

Ridgeline Cloud (a fictional software reseller) prices renewals differently by customer type: standard customers get 5% off, partners get 15% off, and strategic accounts get a volume-based discount. Sales leadership adds a new customer type about once a quarter, and every time it used to mean editing one giant `if/else` method. They want to add a type by writing one class and one metadata record, and to notify the account owner after pricing.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create the Custom Metadata Type `Discount_Strategy__mdt` with one custom field `Apex_Class__c` (Text, 80, required). The record name (DeveloperName) is the customer type key, for example `Partner`. In Setup, search for Custom Metadata Types, click New, then add the field (labels can differ slightly by release). The XML below creates the same thing if you deploy with the CLI.
3. Create three records: `Standard` (class `StandardDiscount`), `Partner` (class `PartnerDiscount`) and `Strategic` (class `VolumeDiscount`). Verify: Setup, Custom Metadata Types, Manage Records shows three rows.
4. Make sure your user can read Opportunities and Accounts. The selector uses user mode, so missing permission shows up as an exception.

### In the external system

5. None. This article is about code structure inside Salesforce. The notifier in the example sends email through Salesforce; swapping in a Slack or SMS notifier would be an external setup covered in the integration articles.

## How it works

| Pattern | Problem it solves | Key idea |
|---|---|---|
| Interface | Callers must not care which algorithm runs | Depend on `DiscountStrategy`, not on `PartnerDiscount` |
| Abstract class | Many classes follow the same steps with small differences | The base class owns the order of steps; subclasses fill in the blanks (the template method pattern) |
| Factory from metadata | New variants should not need a code edit | Look up the class name in Custom Metadata, create it with `Type.forName` |
| Selector | SOQL is scattered and unsafe | One class per object that owns queries and security mode |
| Service | Business rules are scattered in triggers and controllers | One class with the operations; triggers, Flows, LWC and REST all call it |

Words you will see: `virtual` means a method can be overridden; `abstract` means it must be. `inherited sharing` makes a class use the sharing mode of whoever called it, which suits selectors.

## Basic example

An interface and two implementations. Callers use only the interface.

```apex
public interface DiscountStrategy {
    Decimal apply(Decimal amount);
}
```

```apex
public class StandardDiscount implements DiscountStrategy {
    public Decimal apply(Decimal amount) {
        return amount * 0.95;
    }
}
```

```apex
public class PartnerDiscount implements DiscountStrategy {
    public Decimal apply(Decimal amount) {
        return amount * 0.85;
    }
}
```

Use them:

```apex
// Anonymous Apex
DiscountStrategy strategy = new PartnerDiscount();
System.debug(strategy.apply(1000)); // 850

strategy = new StandardDiscount();
System.debug(strategy.apply(1000)); // 950
```

The calling code did not change when the strategy changed. That is the whole idea.

## Advanced end-to-end example

### Metadata

**`force-app/main/default/objects/Discount_Strategy__mdt/Discount_Strategy__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Discount Strategy</label>
    <pluralLabel>Discount Strategies</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/Discount_Strategy__mdt/fields/Apex_Class__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Apex_Class__c</fullName>
    <externalId>false</externalId>
    <fieldManageability>DeveloperControlled</fieldManageability>
    <label>Apex class</label>
    <length>80</length>
    <required>true</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/customMetadata/Discount_Strategy.Partner.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Partner</label>
    <protected>false</protected>
    <values>
        <field>Apex_Class__c</field>
        <value xsi:type="xsd:string">PartnerDiscount</value>
    </values>
</CustomMetadata>
```

Create `Standard` and `Strategic` the same way, with `StandardDiscount` and `VolumeDiscount` as the values.

### Strategies

**`force-app/main/default/classes/VolumeDiscount.cls`**

```apex
// Strategic accounts: the bigger the deal, the bigger the discount.
public class VolumeDiscount implements DiscountStrategy {
    public Decimal apply(Decimal amount) {
        if (amount == null) {
            return 0;
        }
        Decimal rate = 0.90;            // up to 100,000: 10% off
        if (amount > 500000) {
            rate = 0.75;                // above 500,000: 25% off
        } else if (amount > 100000) {
            rate = 0.82;                // above 100,000: 18% off
        }
        return (amount * rate).setScale(2, RoundingMode.HALF_UP);
    }
}
```

### Factory driven by Custom Metadata

**`force-app/main/default/classes/DiscountStrategyFactory.cls`**

```apex
public with sharing class DiscountStrategyFactory {

    public class StrategyException extends Exception {}

    // Cached for the transaction. Tests set this directly because
    // Custom Metadata records cannot be created by DML in a test.
    @TestVisible
    private static Map<String, String> classByType;

    private static Map<String, String> load() {
        if (classByType == null) {
            classByType = new Map<String, String>();
            for (Discount_Strategy__mdt row : Discount_Strategy__mdt.getAll().values()) {
                classByType.put(row.DeveloperName, row.Apex_Class__c);
            }
        }
        return classByType;
    }

    public static DiscountStrategy forCustomerType(String customerType) {
        String key = String.isBlank(customerType) ? 'Standard' : customerType;
        String className = load().get(key);
        if (className == null) {
            className = load().get('Standard');   // safe default
        }
        if (className == null) {
            throw new StrategyException('No discount strategy configured for ' + key);
        }

        Type t = Type.forName(className);
        if (t == null) {
            throw new StrategyException('Class not found: ' + className);
        }
        Object instance = t.newInstance();
        // Allow-list: the class must implement our interface. Never instantiate arbitrary types.
        if (!(instance instanceof DiscountStrategy)) {
            throw new StrategyException(className + ' does not implement DiscountStrategy');
        }
        return (DiscountStrategy) instance;
    }
}
```

### Abstract notifier (template method)

**`force-app/main/default/classes/Notifier.cls`**

```apex
// The base class owns the order of the steps. Subclasses fill in 'deliver'.
public abstract class Notifier {

    public void send(Id recipientUserId, String message) {
        validate(recipientUserId, message);
        deliver(recipientUserId, message);
        afterDelivery(recipientUserId);
    }

    // virtual: may be overridden.
    protected virtual void validate(Id recipientUserId, String message) {
        if (recipientUserId == null || String.isBlank(message)) {
            throw new IllegalArgumentException('Recipient and message are required');
        }
    }

    // abstract: every subclass must implement it.
    protected abstract void deliver(Id recipientUserId, String message);

    protected virtual void afterDelivery(Id recipientUserId) {
        // hook: do nothing by default
    }
}
```

**`force-app/main/default/classes/EmailNotifier.cls`**

```apex
public with sharing class EmailNotifier extends Notifier {

    protected override void deliver(Id recipientUserId, String message) {
        Messaging.SingleEmailMessage mail = new Messaging.SingleEmailMessage();
        mail.setTargetObjectId(recipientUserId);   // a User id
        mail.setSaveAsActivity(false);
        mail.setSubject('Renewal pricing updated');
        mail.setPlainTextBody(message);
        Messaging.sendEmail(new List<Messaging.SingleEmailMessage>{ mail });
    }
}
```

### Selector and service

**`force-app/main/default/classes/OpportunitySelector.cls`**

```apex
// The only class that queries Opportunities. inherited sharing: runs in the caller's mode.
public inherited sharing class OpportunitySelector {

    public static List<Opportunity> byIds(Set<Id> ids) {
        return [
            SELECT Id, Name, Amount, OwnerId, Account.Type
            FROM Opportunity
            WHERE Id IN :ids
            WITH USER_MODE
        ];
    }
}
```

**`force-app/main/default/classes/RenewalPricingService.cls`**

```apex
public with sharing class RenewalPricingService {

    // Replaced in tests so no real email is sent.
    @TestVisible
    private static Notifier notifier = new EmailNotifier();

    // Pure core: no SOQL, no DML. Easy to test, easy to reuse.
    public static Decimal priceFor(String customerType, Decimal amount) {
        if (amount == null) {
            return null;
        }
        return DiscountStrategyFactory.forCustomerType(customerType).apply(amount);
    }

    // Thin shell: query, price, save, notify.
    public static Integer reprice(Set<Id> opportunityIds) {
        List<Opportunity> opps = OpportunitySelector.byIds(opportunityIds);
        List<Opportunity> changed = new List<Opportunity>();

        for (Opportunity o : opps) {
            Decimal newAmount = priceFor(o.Account?.Type, o.Amount);
            if (newAmount != null && newAmount != o.Amount) {
                o.Amount = newAmount;
                changed.add(o);
            }
        }
        if (changed.isEmpty()) {
            return 0;
        }

        update as user changed;

        for (Opportunity o : changed) {
            notifier.send(o.OwnerId, o.Name + ' repriced to ' + o.Amount);
        }
        return changed.size();
    }
}
```

### Tests

**`force-app/main/default/classes/RenewalPricingServiceTest.cls`**

```apex
@IsTest
private class RenewalPricingServiceTest {

    // A notifier that records messages instead of sending email.
    private class RecordingNotifier extends Notifier {
        public List<String> messages = new List<String>();
        protected override void deliver(Id recipientUserId, String message) {
            messages.add(message);
        }
    }

    @IsTest
    static void strategiesPriceAsExpected() {
        Assert.areEqual(950, new StandardDiscount().apply(1000), 'Standard 5% off');
        Assert.areEqual(850, new PartnerDiscount().apply(1000), 'Partner 15% off');
        Assert.areEqual(90000, new VolumeDiscount().apply(100000), 'Volume tier 1');
        Assert.areEqual(82000.01, new VolumeDiscount().apply(100000.01), 'Volume tier 2 starts above 100,000');
        Assert.areEqual(375000.01, new VolumeDiscount().apply(500000.01), 'Volume tier 3 starts above 500,000');
    }

    @IsTest
    static void factoryReadsTheClassNameFromMetadata() {
        DiscountStrategyFactory.classByType = new Map<String, String>{
            'Standard' => 'StandardDiscount',
            'Partner' => 'PartnerDiscount'
        };
        Assert.isInstanceOfType(DiscountStrategyFactory.forCustomerType('Partner'), PartnerDiscount.class, 'Partner');
        Assert.isInstanceOfType(DiscountStrategyFactory.forCustomerType(null), StandardDiscount.class, 'Blank defaults to Standard');
        Assert.isInstanceOfType(DiscountStrategyFactory.forCustomerType('Unknown'), StandardDiscount.class, 'Unknown defaults to Standard');
    }

    @IsTest
    static void factoryRejectsClassesThatAreNotStrategies() {
        DiscountStrategyFactory.classByType = new Map<String, String>{ 'Standard' => 'Account' };
        try {
            DiscountStrategyFactory.forCustomerType('Standard');
            Assert.fail('Expected a StrategyException');
        } catch (DiscountStrategyFactory.StrategyException e) {
            Assert.isTrue(e.getMessage().contains('does not implement'), e.getMessage());
        }
    }

    @IsTest
    static void factoryFailsClearlyWhenNothingIsConfigured() {
        DiscountStrategyFactory.classByType = new Map<String, String>();
        try {
            DiscountStrategyFactory.forCustomerType('Partner');
            Assert.fail('Expected a StrategyException');
        } catch (DiscountStrategyFactory.StrategyException e) {
            Assert.isTrue(e.getMessage().contains('No discount strategy'), e.getMessage());
        }
    }

    @IsTest
    static void repriceUpdatesAmountsAndNotifiesOwners() {
        DiscountStrategyFactory.classByType = new Map<String, String>{
            'Standard' => 'StandardDiscount',
            'Partner' => 'PartnerDiscount'
        };
        RecordingNotifier recorder = new RecordingNotifier();
        RenewalPricingService.notifier = recorder;

        Account partner = new Account(Name = 'Partner Co', Type = 'Partner');
        insert partner;
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            opps.add(new Opportunity(
                Name = 'Renewal ' + i, AccountId = partner.Id, Amount = 1000,
                StageName = 'Prospecting', CloseDate = Date.today().addDays(30)
            ));
        }
        insert opps;

        Test.startTest();
        Integer changed = RenewalPricingService.reprice(new Map<Id, Opportunity>(opps).keySet());
        Test.stopTest();

        Assert.areEqual(200, changed, 'All 200 opportunities repriced');
        Assert.areEqual(200, recorder.messages.size(), 'One notification each');
        Assert.areEqual(200, [SELECT COUNT() FROM Opportunity WHERE Amount = 850], '15% off for partners');
    }

    @IsTest
    static void nullAmountIsIgnored() {
        Assert.isNull(RenewalPricingService.priceFor('Partner', null), 'No amount, no price');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names RenewalPricingServiceTest --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

1. `reprice` calls the selector. The query runs in **user mode**, so object permission, field-level security and sharing all apply to the running user. The selector is declared `inherited sharing` so it takes the caller's sharing mode instead of deciding one itself.
2. For each Opportunity the service asks the factory for a strategy. The factory reads the Custom Metadata map once per transaction (`getAll()` does not count as a SOQL query) and caches it in a static variable.
3. `Type.forName(className)` finds the class by name at run time. `newInstance()` calls its no-argument constructor. The `instanceof DiscountStrategy` check makes sure the metadata row cannot make the code create an arbitrary class; an admin who types `Account` gets a clear error instead of a surprise.
4. `update as user` performs one DML statement for all changed records, and enforces the user's update permission and field-level security.
5. `notifier.send` is the template method: `validate`, then `deliver`, then `afterDelivery`. Each Opportunity owner receives one email; each email counts toward the daily and per-transaction email limits, so for 200 owners you would normally batch notifications into a digest. See the limits article.
6. Adding a new customer type later means a new class implementing `DiscountStrategy` plus one metadata record. Nothing else changes, and the deployment contains only the new class and the record.

## Test it and verify

1. Run the test class. Expected: 6 tests pass.
2. In the org, create an Account with Type `Partner` and an Opportunity with Amount 1,000. Run this anonymous Apex:

```apex
// Anonymous Apex
Opportunity o = [SELECT Id, Amount FROM Opportunity WHERE Account.Type = 'Partner' LIMIT 1];
Integer n = RenewalPricingService.reprice(new Set<Id>{ o.Id });
System.debug('Repriced: ' + n + ', new amount: ' + [SELECT Amount FROM Opportunity WHERE Id = :o.Id].Amount);
```

3. Expected: `Repriced: 1, new amount: 850`. Run it a second time and you will see `Repriced: 1, new amount: 722.50`, because the 15% discount is applied to the already discounted amount. That second run exposes a real design question: pricing must be idempotent. In a real system, store the list price and the discount in separate fields instead of overwriting `Amount`, so running the service twice gives the same result.
4. Add a fourth type: write a class `NonprofitDiscount implements DiscountStrategy`, add a `Nonprofit` metadata record, deploy, and confirm no other class was edited.

## Common mistakes and fixes

- **Symptom: `Type.forName` returns null.** Cause: a typo in the metadata value, or the class is in a managed package and needs a namespace prefix. Fix: validate on save in a flow or tests, and use the full name for namespaced classes.
- **Symptom: `System.TypeException: Invalid conversion from runtime type X to DiscountStrategy`.** Cause: the cast ran before the `instanceof` check. Fix: always check with `instanceof` first, as the factory does.
- **Symptom: a test cannot insert Custom Metadata.** Cause: Custom Metadata records cannot be created with DML in a test. Fix: add a `@TestVisible` cache or an interface seam, as the factory does.
- **Symptom: queries are copied into five services.** Cause: no selector. Fix: add a selector per object and call it from every service.
- **Symptom: a deep inheritance tree where every change breaks a subclass.** Cause: inheritance used for sharing code. Fix: prefer interfaces plus small helper classes, and keep abstract classes to workflows with a clear template.
- **Symptom: `without sharing` added "to make it work".** Cause: a user-mode query fails for a real permission gap. Fix: fix the permission set, or isolate the narrow case in a small, documented `without sharing` class.
- **Symptom: factory results leak between tests.** Cause: the static cache keeps its value. Fix: set `classByType` at the start of each test that uses it.

## Key takeaways

- Depend on interfaces, not concrete classes, so new behavior means new classes.
- Use an abstract class when many classes share one workflow with small differences.
- Drive variants from Custom Metadata, and always guard `Type.forName` with an `instanceof` check.
- Keep SOQL in selectors and business rules in services, and keep the core logic free of SOQL and DML so it is easy to test.
- Choose the sharing and access mode on purpose for every class.

## Where to go next

- [Apex classes from zero](/articles/apex-classes-zero-to-hero/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
- [Custom metadata, settings and labels](/articles/custom-metadata-settings-and-labels/)
- [Writing Apex tests that actually catch bugs](/articles/apex-test-classes-best-practices/)
