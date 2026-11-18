---
title: "Apex Classes from Zero: Syntax, Methods, Access and Sharing"
description: "Learn Apex classes by building a B2B quote pricing service: methods, constructors, interfaces, access, sharing, user mode, tests and limits."
category: salesforce-development
tags: [Apex, Classes, Beginner]
publishedAt: 2026-11-08
updatedAt: 2026-11-13
cover: /images/covers/apex-classes-zero-to-hero.jpg
sources:
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
  - title: "Apex keywords: with sharing, without sharing, inherited sharing (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_classes_keywords.htm"
  - title: "Versioned behavior changes (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.262.0.apexref.meta/apexref/versioned_behavior_changes.htm"
  - title: "Execution governors and limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm"
---

Apex is Salesforce's strongly typed, Java-like language for server-side logic. It runs on the platform, next to your data, and every transaction is bound by governor limits. All Apex lives in a **class** (or a trigger, which is covered in the triggers articles).

A class is a blueprint. It groups data (fields and properties) with the code that works on that data (methods). Good classes are small, have one job and are easy to test. This article teaches the syntax by building one realistic thing: a pricing service that turns a list of requested products into a priced quote.

## The business scenario

Brightline Industrial Supply (a fictional distributor) sells fasteners and fittings to other businesses. Sales reps build quotes for bulk orders. The pricing rules are:

- The list price comes from the Standard Price Book.
- A **volume discount** applies by quantity: 5% from 10 units, 10% from 50 units, 15% from 100 units. Sales operations edits these tiers, so they must not be hard-coded.
- A **customer tier** discount applies on top: Silver accounts get 2%, Gold accounts get 5%.
- The total discount on one line is capped at 25%.

The pricing code will be used from an LWC quote screen, from a Flow and from other Apex. So it must be a service class with clear inputs and outputs, not logic buried in a button handler. The model has seven small pieces:

| Piece | Apex feature it teaches |
|---|---|
| `CustomerTier` | enum |
| `QuoteRequestLine`, `QuoteLine`, `QuoteResult` | plain classes, fields, constructors |
| `PricingRule` and two rules | interface and polymorphism |
| `DiscountTierProvider` | interface used to swap data sources in tests |
| `PricebookSelector`, `AccountSelector` | SOQL in one place, `WITH USER_MODE` |
| `QuotePricingService` | constructors, static constants, exceptions |
| `QuotePricingController` | `@AuraEnabled` entry point |

## Before you start: setup

This article needs no external system. Everything runs inside Salesforce. Setup menu labels can differ slightly by release, so use Setup's Quick Find box if a path has moved (see the Salesforce Help pages for your release).

### In Salesforce

1. **Get a safe org.** Use a Developer Edition org or a scratch org. Why: you will create fields and deploy code, and you do not want to do that in production. Verify: you can open Setup and the Developer Console (gear icon, then Developer Console).
2. **Confirm Products and the Standard Price Book exist.** In the App Launcher open Products. Why: the service reads `PricebookEntry` rows from the Standard Price Book. Verify: run `SELECT Id FROM Pricebook2 WHERE IsStandard = true` in the Developer Console Query Editor and get one row.
3. **Create the Account field `Customer Tier`.** Setup, Object Manager, Account, Fields & Relationships, New. Type Picklist, API name `Customer_Tier__c`, values `Standard`, `Silver`, `Gold`. Why: the customer tier rule reads it. Verify: the field appears on the Account page layout or in the field list.
4. **Create the Custom Metadata Type `Volume Discount Tier`.** Setup, Custom Metadata Types, New. API name `Volume_Discount_Tier__mdt`. Add two Number fields: `Min_Quantity__c` (scale 0) and `Discount_Percent__c` (scale 2). Why: tiers become data that admins edit and deploy, not code. Verify: Manage Records lets you add a row.
5. **Add three tier records:** 10 units at 5, 50 units at 10, 100 units at 15. Verify: `SELECT Min_Quantity__c, Discount_Percent__c FROM Volume_Discount_Tier__mdt` returns three rows.
6. **Create the permission set `Quote Pricing User`.** Give it Read on Product2 and PricebookEntry, Read on the field `Account.Customer_Tier__c`, and access to the Apex classes `QuotePricingService` and `QuotePricingController`. Assign it to your user. Why: the selectors run in user mode, so object and field permissions apply. Verify: Setup, Permission Sets, the set shows your user under Manage Assignments.
7. **Load sample data** with the script in the test section below (an Account on the Gold tier and two products). Verify: Products shows `BRG-100` and `BRG-200`.

The XML for steps 3 to 6 is in the advanced section, so you can deploy it instead of clicking.

### On your machine

1. Install the Salesforce CLI (`sf`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version` prints a version.
2. Authorize your org: `sf org login web --alias brightline`. Verify: `sf org list` shows it.

## How it works

### Class, object, member

A **class** is the blueprint. An **object** (instance) is one thing built from it with `new`. A **member** is anything inside the class: a **field** (stored value), a **property** (a field with a getter and setter) or a **method** (code). A **constructor** is a special method with the class name that runs on `new` and sets up the object.

### Instance versus static

Instance members belong to one object. **Static** members belong to the class and exist once per transaction. Call a static member as `ClassName.member`. Static variables reset when the transaction ends, so they are not a place to store data between requests.

### Access modifiers

| Modifier | Visible to |
|---|---|
| `private` | Only the defining class (the default for members) |
| `protected` | The class and its subclasses |
| `public` | All Apex in your namespace |
| `global` | Everywhere, including other namespaces (managed packages) |

Start with the narrowest access that works. A top-level class must be `public` or `global`. Use `@TestVisible` to let a test reach a private member without widening it for everyone.

### Interfaces and inheritance

An **interface** lists method signatures with no code. Any class that `implements` it must supply them. Code that depends on the interface does not care which class it receives. That is how our service can use any list of `PricingRule` objects. A class marked `virtual` or `abstract` can be extended with `extends`; use it when classes share real code, not just a shape.

### Sharing and user mode

Sharing decides which **records** the code can see. Field-level and object permissions decide which **fields and objects** it can use. These are separate things.

| Keyword | Effect |
|---|---|
| `with sharing` | Enforces the running user's record access |
| `without sharing` | Ignores record sharing |
| `inherited sharing` | Uses the caller's mode |

Apex also has **access modes** for database work: `WITH USER_MODE` on a query, or `as user` / `AccessLevel.USER_MODE` on DML, enforce sharing, object permissions and field-level security together. `WITH SYSTEM_MODE` skips them.

The defaults changed at API version 67.0 (Summer '26). The Apex Reference Guide's versioned behavior page says that from 67.0, Apex runs in user context by default, a class with no sharing declaration runs in the current user context, and `WITH SECURITY_ENFORCED` is no longer supported in SOQL (use `WITH USER_MODE`). In 66.0 and earlier, system mode was the default. Do not rely on defaults. Write the sharing keyword and the access mode every time, so the class behaves the same on any API version.

### Shape of the call

```text
LWC / Flow / Apex caller
        |
        v
QuotePricingController.priceQuote()      @AuraEnabled, thin, catches errors
        |
        v
QuotePricingService.price()              orchestrates, 2 queries total
   |-- AccountSelector.tierFor()         1 SOQL, user mode
   |-- PricebookSelector.activeEntries() 1 SOQL, user mode
   '-- for each line: PricingRule[]      pure logic, no SOQL, no DML
```

## Basic example

First, the shape of a class on its own. This class has a field, a constructor, an instance method, a static method and a property. It has no database access, so you can run it anywhere.

```apex
public with sharing class LineCalculator {
    // Property: a field with a built-in getter and setter
    public Integer quantity { get; set; }
    // Private field: only this class can touch it
    private final Decimal unitPrice;

    // Constructor: runs on "new LineCalculator(...)"
    public LineCalculator(Decimal unitPrice, Integer quantity) {
        this.unitPrice = unitPrice;
        this.quantity = quantity;
    }

    // Instance method: uses this object's data
    public Decimal total(Decimal discountPercent) {
        Decimal gross = unitPrice * quantity;
        return (gross * (100 - discountPercent) / 100).setScale(2, RoundingMode.HALF_UP);
    }

    // Static method: needs no object, called as LineCalculator.cap(...)
    public static Decimal cap(Decimal percent, Decimal maxPercent) {
        return Math.min(percent, maxPercent);
    }
}
```

Run it in the Developer Console (Debug, Open Execute Anonymous Window):

```apex
// Anonymous Apex
LineCalculator calc = new LineCalculator(19.99, 3);
System.debug(calc.total(10));                    // 53.97
System.debug(LineCalculator.cap(30, 25));        // 25
```

Expected debug output: `53.97` and `25`. Use `Decimal`, never `Double`, for money. `Double` is binary floating point and gives results such as `0.30000000000000004`.

Now the first lesson about real classes. Here is a **bad** version that looks fine and fails in production:

```apex
public with sharing class NaivePricing {
    // BAD: one SOQL query per line. 101 lines throws
    // "Too many SOQL queries: 101".
    public static Decimal totalFor(List<String> productCodes) {
        Decimal sum = 0;
        for (String code : productCodes) {
            PricebookEntry pbe = [
                SELECT UnitPrice FROM PricebookEntry
                WHERE Product2.ProductCode = :code AND Pricebook2.IsStandard = true
                LIMIT 1
            ];
            sum += pbe.UnitPrice;
        }
        return sum;
    }
}
```

The **fixed** version collects the codes first, queries once and looks prices up in a `Map`. That is exactly what `PricebookSelector` does below.

```apex
public with sharing class BetterPricing {
    // GOOD: one query for all codes, then a map lookup per line.
    public static Decimal totalFor(List<String> productCodes) {
        Map<String, Decimal> priceByCode = new Map<String, Decimal>();
        for (PricebookEntry pbe : [
            SELECT UnitPrice, Product2.ProductCode FROM PricebookEntry
            WHERE Product2.ProductCode IN :productCodes AND Pricebook2.IsStandard = true
            WITH USER_MODE
        ]) {
            priceByCode.put(pbe.Product2.ProductCode, pbe.UnitPrice);
        }
        Decimal sum = 0;
        for (String code : productCodes) {
            sum += priceByCode.get(code) ?? 0;   // ?? gives a default when null
        }
        return sum;
    }
}
```

## Advanced end-to-end example

The files below are the full pricing service. The design rule is: rules contain pure logic, selectors contain SOQL, the service orchestrates, the controller translates errors for the UI.

### Value types and the enum

**`force-app/main/default/classes/CustomerTier.cls`**

```apex
public enum CustomerTier { STANDARD, SILVER, GOLD }
```

**`force-app/main/default/classes/PricingException.cls`**

```apex
public class PricingException extends Exception {
}
```

**`force-app/main/default/classes/QuoteRequestLine.cls`**

```apex
public class QuoteRequestLine {
    @AuraEnabled public String productCode;
    @AuraEnabled public Integer quantity;

    // No-argument constructor: the Lightning runtime needs it to
    // deserialize this type when it is a parameter of an @AuraEnabled method.
    public QuoteRequestLine() {
    }

    public QuoteRequestLine(String productCode, Integer quantity) {
        this.productCode = productCode;
        this.quantity = quantity;
    }
}
```

**`force-app/main/default/classes/QuoteLine.cls`**

```apex
public class QuoteLine {
    @AuraEnabled public String productCode;
    @AuraEnabled public String productName;
    @AuraEnabled public Integer quantity;
    @AuraEnabled public Decimal listPrice;
    @AuraEnabled public Decimal discountPercent;
    @AuraEnabled public Decimal lineTotal;
}
```

**`force-app/main/default/classes/QuoteResult.cls`**

```apex
public class QuoteResult {
    @AuraEnabled public List<QuoteLine> lines = new List<QuoteLine>();
    @AuraEnabled public List<String> unknownProducts = new List<String>();
    @AuraEnabled public Decimal subtotal = 0;
    @AuraEnabled public Decimal discountTotal = 0;
    @AuraEnabled public Decimal total = 0;

    public void addLine(QuoteLine line) {
        lines.add(line);
        subtotal += line.listPrice * line.quantity;
        total += line.lineTotal;
        discountTotal = subtotal - total;
    }
}
```

**`force-app/main/default/classes/PricingContext.cls`**

```apex
public with sharing class PricingContext {
    public final Id accountId;
    public final CustomerTier tier;

    public PricingContext(Id accountId, String tierLabel) {
        this.accountId = accountId;
        this.tier = parseTier(tierLabel);
    }

    @TestVisible
    private static CustomerTier parseTier(String label) {
        if (String.isBlank(label)) {
            return CustomerTier.STANDARD;
        }
        switch on label.toUpperCase() {
            when 'GOLD' {
                return CustomerTier.GOLD;
            }
            when 'SILVER' {
                return CustomerTier.SILVER;
            }
            when else {
                return CustomerTier.STANDARD;
            }
        }
    }
}
```

### Rules and tiers

**`force-app/main/default/classes/DiscountTier.cls`**

```apex
public class DiscountTier implements Comparable {
    public final Integer minQuantity;
    public final Decimal percent;

    public DiscountTier(Integer minQuantity, Decimal percent) {
        this.minQuantity = minQuantity;
        this.percent = percent;
    }

    // Sorts highest minimum quantity first, so the first match wins.
    public Integer compareTo(Object other) {
        DiscountTier o = (DiscountTier) other;
        return o.minQuantity - minQuantity;
    }
}
```

**`force-app/main/default/classes/DiscountTierProvider.cls`**

```apex
public interface DiscountTierProvider {
    List<DiscountTier> tiers();
}
```

**`force-app/main/default/classes/MetadataDiscountTierProvider.cls`**

```apex
public with sharing class MetadataDiscountTierProvider implements DiscountTierProvider {
    // getAll() reads Custom Metadata from the platform cache.
    // It does not count against the SOQL query limit.
    public List<DiscountTier> tiers() {
        List<DiscountTier> result = new List<DiscountTier>();
        for (Volume_Discount_Tier__mdt row : Volume_Discount_Tier__mdt.getAll().values()) {
            result.add(new DiscountTier(Integer.valueOf(row.Min_Quantity__c), row.Discount_Percent__c));
        }
        result.sort();
        return result;
    }
}
```

**`force-app/main/default/classes/PricingRule.cls`**

```apex
public interface PricingRule {
    // Returns the discount, in percent, that this rule grants for one line.
    Decimal discountPercent(PricingContext ctx, QuoteRequestLine line);
}
```

**`force-app/main/default/classes/VolumeDiscountRule.cls`**

```apex
public with sharing class VolumeDiscountRule implements PricingRule {
    private final List<DiscountTier> tiers;

    public VolumeDiscountRule(DiscountTierProvider provider) {
        this.tiers = provider.tiers();   // read once, reused for every line
    }

    public Decimal discountPercent(PricingContext ctx, QuoteRequestLine line) {
        for (DiscountTier tier : tiers) {
            if (line.quantity >= tier.minQuantity) {
                return tier.percent;
            }
        }
        return 0;
    }
}
```

**`force-app/main/default/classes/CustomerTierRule.cls`**

```apex
public with sharing class CustomerTierRule implements PricingRule {
    private static final Map<CustomerTier, Decimal> EXTRA_PERCENT = new Map<CustomerTier, Decimal>{
        CustomerTier.STANDARD => 0,
        CustomerTier.SILVER => 2,
        CustomerTier.GOLD => 5
    };

    public Decimal discountPercent(PricingContext ctx, QuoteRequestLine line) {
        return EXTRA_PERCENT.get(ctx.tier);
    }
}
```

### Selectors and the service

**`force-app/main/default/classes/PricebookSelector.cls`**

```apex
public with sharing class PricebookSelector {
    // One query for any number of product codes. User mode enforces
    // object permissions, field-level security and sharing.
    public Map<String, PricebookEntry> activeEntriesByCode(Set<String> codes) {
        Map<String, PricebookEntry> result = new Map<String, PricebookEntry>();
        for (PricebookEntry pbe : [
            SELECT Id, UnitPrice, Product2.ProductCode, Product2.Name
            FROM PricebookEntry
            WHERE Pricebook2.IsStandard = true
              AND IsActive = true
              AND Product2.ProductCode IN :codes
            WITH USER_MODE
        ]) {
            result.put(pbe.Product2.ProductCode, pbe);
        }
        return result;
    }
}
```

**`force-app/main/default/classes/AccountSelector.cls`**

```apex
public with sharing class AccountSelector {
    public Account tierFor(Id accountId) {
        List<Account> rows = [
            SELECT Id, Name, Customer_Tier__c
            FROM Account
            WHERE Id = :accountId
            WITH USER_MODE
            LIMIT 1
        ];
        return rows.isEmpty() ? null : rows[0];
    }
}
```

**`force-app/main/default/classes/QuotePricingService.cls`**

```apex
public with sharing class QuotePricingService {
    public static final Decimal MAX_DISCOUNT_PERCENT = 25;
    public static final Integer MAX_LINES = 500;

    private final List<PricingRule> rules;
    private final PricebookSelector pricebook = new PricebookSelector();
    private final AccountSelector accounts = new AccountSelector();

    // Production constructor: rules come from Custom Metadata.
    public QuotePricingService() {
        this(new List<PricingRule>{
            new VolumeDiscountRule(new MetadataDiscountTierProvider()),
            new CustomerTierRule()
        });
    }

    // Tests pass their own rules. Private, but visible to test classes only.
    @TestVisible
    private QuotePricingService(List<PricingRule> rules) {
        this.rules = rules;
    }

    public QuoteResult price(Id accountId, List<QuoteRequestLine> requested) {
        validate(accountId, requested);

        Set<String> codes = new Set<String>();
        for (QuoteRequestLine req : requested) {
            codes.add(req.productCode);
        }
        Map<String, PricebookEntry> entries = pricebook.activeEntriesByCode(codes);

        Account acct = accounts.tierFor(accountId);
        if (acct == null) {
            throw new PricingException('Account not found or not visible: ' + accountId);
        }
        PricingContext ctx = new PricingContext(accountId, acct.Customer_Tier__c);

        QuoteResult result = new QuoteResult();
        for (QuoteRequestLine req : requested) {
            PricebookEntry entry = entries.get(req.productCode);
            if (entry == null) {
                result.unknownProducts.add(req.productCode);
                continue;
            }
            result.addLine(buildLine(ctx, req, entry));
        }
        return result;
    }

    private QuoteLine buildLine(PricingContext ctx, QuoteRequestLine req, PricebookEntry entry) {
        Decimal percent = 0;
        for (PricingRule rule : rules) {
            percent += rule.discountPercent(ctx, req);
        }
        percent = Math.min(percent, MAX_DISCOUNT_PERCENT);

        QuoteLine line = new QuoteLine();
        line.productCode = req.productCode;
        line.productName = entry.Product2.Name;
        line.quantity = req.quantity;
        line.listPrice = entry.UnitPrice;
        line.discountPercent = percent;
        line.lineTotal = (entry.UnitPrice * req.quantity * (100 - percent) / 100)
            .setScale(2, RoundingMode.HALF_UP);
        return line;
    }

    private static void validate(Id accountId, List<QuoteRequestLine> requested) {
        if (accountId == null) {
            throw new PricingException('An account is required.');
        }
        if (requested == null || requested.isEmpty()) {
            throw new PricingException('Add at least one line.');
        }
        if (requested.size() > MAX_LINES) {
            throw new PricingException('A quote can have at most ' + MAX_LINES + ' lines.');
        }
        for (QuoteRequestLine req : requested) {
            if (String.isBlank(req.productCode) || req.quantity == null || req.quantity <= 0) {
                throw new PricingException('Each line needs a product code and a quantity above 0.');
            }
        }
    }
}
```

**`force-app/main/default/classes/QuotePricingController.cls`**

```apex
public with sharing class QuotePricingController {
    @AuraEnabled
    public static QuoteResult priceQuote(Id accountId, List<QuoteRequestLine> lines) {
        try {
            return new QuotePricingService().price(accountId, lines);
        } catch (PricingException e) {
            // Without setMessage, the UI shows "Script-thrown exception".
            AuraHandledException ex = new AuraHandledException(e.getMessage());
            ex.setMessage(e.getMessage());
            throw ex;
        }
    }
}
```

Every class and trigger needs a sibling `.cls-meta.xml` file with its API version. `sf apex generate class` creates it. Use your org's current API version (the Apex guide lists Winter '27 as API 68.0 at the time of writing).

### Metadata to deploy

**`force-app/main/default/objects/Account/fields/Customer_Tier__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Customer_Tier__c</fullName>
    <label>Customer Tier</label>
    <type>Picklist</type>
    <required>false</required>
    <trackTrending>false</trackTrending>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Standard</fullName><default>true</default><label>Standard</label></value>
            <value><fullName>Silver</fullName><default>false</default><label>Silver</label></value>
            <value><fullName>Gold</fullName><default>false</default><label>Gold</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Volume_Discount_Tier__mdt/Volume_Discount_Tier__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Volume Discount Tier</label>
    <pluralLabel>Volume Discount Tiers</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/Volume_Discount_Tier__mdt/fields/Min_Quantity__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Min_Quantity__c</fullName>
    <fieldManageability>DeveloperControlled</fieldManageability>
    <label>Min Quantity</label>
    <precision>18</precision>
    <scale>0</scale>
    <type>Number</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/objects/Volume_Discount_Tier__mdt/fields/Discount_Percent__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Discount_Percent__c</fullName>
    <fieldManageability>DeveloperControlled</fieldManageability>
    <label>Discount Percent</label>
    <precision>5</precision>
    <scale>2</scale>
    <type>Number</type>
    <unique>false</unique>
</CustomField>
```

**`force-app/main/default/customMetadata/Volume_Discount_Tier.Tier_10.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Tier 10</label>
    <protected>false</protected>
    <values>
        <field>Min_Quantity__c</field>
        <value xsi:type="xsd:double">10.0</value>
    </values>
    <values>
        <field>Discount_Percent__c</field>
        <value xsi:type="xsd:double">5.0</value>
    </values>
</CustomMetadata>
```

Create `Tier_50` (50 and 10) and `Tier_100` (100 and 15) the same way, changing the file name, label and values.

**`force-app/main/default/permissionsets/Quote_Pricing_User.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Quote Pricing User</label>
    <hasActivationRequired>false</hasActivationRequired>
    <classAccesses>
        <apexClass>QuotePricingController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>QuotePricingService</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <fieldPermissions>
        <field>Account.Customer_Tier__c</field>
        <editable>false</editable>
        <readable>true</readable>
    </fieldPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Product2</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>PricebookEntry</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>
```

### Sample data script

**`scripts/apex/seed-quote-data.apex`**

```apex
// Anonymous Apex
Id standardId = [SELECT Id FROM Pricebook2 WHERE IsStandard = true LIMIT 1].Id;
insert new Account(Name = 'Brightline Demo Buyer', Customer_Tier__c = 'Gold');

List<Product2> products = new List<Product2>{
    new Product2(Name = 'Hex bolt M8 (box)', ProductCode = 'BRG-100', IsActive = true),
    new Product2(Name = 'Flat washer M8 (box)', ProductCode = 'BRG-200', IsActive = true)
};
insert products;

insert new List<PricebookEntry>{
    new PricebookEntry(Pricebook2Id = standardId, Product2Id = products[0].Id,
                       UnitPrice = 40.00, IsActive = true),
    new PricebookEntry(Pricebook2Id = standardId, Product2Id = products[1].Id,
                       UnitPrice = 15.50, IsActive = true)
};
System.debug('Seeded demo data');
```

### Test class

**`force-app/main/default/classes/QuotePricingServiceTest.cls`**

```apex
@IsTest
private class QuotePricingServiceTest {
    // Test double: fixed tiers, so the test does not depend on org metadata.
    private class FixedTiers implements DiscountTierProvider {
        private final List<DiscountTier> rows;
        FixedTiers(List<DiscountTier> rows) {
            this.rows = rows;
        }
        public List<DiscountTier> tiers() {
            List<DiscountTier> copy = rows.clone();
            copy.sort();
            return copy;
        }
    }

    private static QuotePricingService serviceWith(List<DiscountTier> tiers) {
        return new QuotePricingService(new List<PricingRule>{
            new VolumeDiscountRule(new FixedTiers(tiers)),
            new CustomerTierRule()
        });
    }

    @TestSetup
    static void makeData() {
        insert new Account(Name = 'Test Buyer', Customer_Tier__c = 'Gold');
        List<Product2> products = new List<Product2>();
        products.add(new Product2(Name = 'Single', ProductCode = 'T-100', IsActive = true));
        for (Integer i = 0; i < 200; i++) {
            products.add(new Product2(Name = 'Bulk ' + i, ProductCode = 'BULK-' + i, IsActive = true));
        }
        insert products;

        Id standardId = Test.getStandardPricebookId();
        List<PricebookEntry> entries = new List<PricebookEntry>();
        for (Product2 p : products) {
            Decimal price = p.ProductCode == 'T-100' ? 19.99 : 10.00;
            entries.add(new PricebookEntry(Pricebook2Id = standardId, Product2Id = p.Id,
                                           UnitPrice = price, IsActive = true));
        }
        insert entries;
    }

    private static Id buyerId() {
        return [SELECT Id FROM Account WHERE Name = 'Test Buyer' LIMIT 1].Id;
    }

    @IsTest
    static void appliesVolumeAndTierDiscountAndRounds() {
        List<QuoteRequestLine> lines = new List<QuoteRequestLine>{ new QuoteRequestLine('T-100', 3) };
        QuoteResult result = serviceWith(new List<DiscountTier>{ new DiscountTier(1, 5) })
            .price(buyerId(), lines);

        // 5% volume + 5% Gold = 10%. 19.99 * 3 * 0.90 = 53.973, rounded to 53.97.
        Assert.areEqual(1, result.lines.size());
        Assert.areEqual(10, result.lines[0].discountPercent);
        Assert.areEqual(53.97, result.lines[0].lineTotal);
    }

    @IsTest
    static void capsTheTotalDiscount() {
        List<QuoteRequestLine> lines = new List<QuoteRequestLine>{ new QuoteRequestLine('T-100', 1) };
        QuoteResult result = serviceWith(new List<DiscountTier>{ new DiscountTier(1, 30) })
            .price(buyerId(), lines);
        Assert.areEqual(QuotePricingService.MAX_DISCOUNT_PERCENT, result.lines[0].discountPercent);
    }

    @IsTest
    static void pricesTwoHundredLinesWithTwoQueries() {
        List<QuoteRequestLine> lines = new List<QuoteRequestLine>();
        for (Integer i = 0; i < 200; i++) {
            lines.add(new QuoteRequestLine('BULK-' + i, 10));
        }
        QuotePricingService svc = serviceWith(new List<DiscountTier>{ new DiscountTier(10, 5) });

        Test.startTest();
        QuoteResult result = svc.price(buyerId(), lines);
        Integer queries = Limits.getQueries();
        Test.stopTest();

        // Each line: 10 * 10.00 = 100.00, minus 10% = 90.00.
        Assert.areEqual(200, result.lines.size());
        Assert.areEqual(20000, result.subtotal);
        Assert.areEqual(18000, result.total);
        // 2 selector queries plus the buyerId() lookup in this test.
        Assert.isTrue(queries <= 3, 'Queries used: ' + queries);
    }

    @IsTest
    static void reportsUnknownProductsInsteadOfFailing() {
        List<QuoteRequestLine> lines = new List<QuoteRequestLine>{
            new QuoteRequestLine('T-100', 1), new QuoteRequestLine('NOPE', 1)
        };
        QuoteResult result = serviceWith(new List<DiscountTier>()).price(buyerId(), lines);
        Assert.areEqual(1, result.lines.size());
        Assert.areEqual(new List<String>{ 'NOPE' }, result.unknownProducts);
    }

    @IsTest
    static void rejectsBadInput() {
        QuotePricingService svc = serviceWith(new List<DiscountTier>());
        try {
            svc.price(buyerId(), new List<QuoteRequestLine>{ new QuoteRequestLine('T-100', 0) });
            Assert.fail('Expected a PricingException for quantity 0');
        } catch (PricingException e) {
            Assert.isTrue(e.getMessage().contains('quantity above 0'), e.getMessage());
        }
    }

    @IsTest
    static void failsWhenTheAccountIsMissing() {
        Id missing = Id.valueOf('001000000000001');
        try {
            serviceWith(new List<DiscountTier>())
                .price(missing, new List<QuoteRequestLine>{ new QuoteRequestLine('T-100', 1) });
            Assert.fail('Expected a PricingException for a missing account');
        } catch (PricingException e) {
            Assert.isTrue(e.getMessage().contains('not found'), e.getMessage());
        }
    }

    @IsTest
    static void controllerTurnsErrorsIntoAuraHandledException() {
        try {
            QuotePricingController.priceQuote(buyerId(), new List<QuoteRequestLine>());
            Assert.fail('Expected an AuraHandledException');
        } catch (AuraHandledException e) {
            Assert.isTrue(e.getMessage().contains('at least one line'), e.getMessage());
        }
    }

    @IsTest
    static void unknownTierLabelFallsBackToStandard() {
        Assert.areEqual(CustomerTier.STANDARD, PricingContext.parseTier('Platinum'));
        Assert.areEqual(CustomerTier.STANDARD, PricingContext.parseTier(null));
        Assert.areEqual(CustomerTier.GOLD, PricingContext.parseTier('gold'));
    }
}
```

### Deploy and run

```bash
sf project generate --name brightline-pricing && cd brightline-pricing
sf apex generate class --name QuotePricingService --output-dir force-app/main/default/classes
sf project deploy start --source-dir force-app --target-org brightline
sf org assign permset --name Quote_Pricing_User --target-org brightline
sf apex run --file scripts/apex/seed-quote-data.apex --target-org brightline
sf apex run test --class-names QuotePricingServiceTest --code-coverage \
  --result-format human --wait 10 --target-org brightline
```

The `sf apex generate class` line shows how a meta file is created. For the other classes, run it once per class name and then replace the generated bodies with the code above, or copy each `.cls-meta.xml` and edit nothing else.

## What happens behind the scenes

1. **Compile.** On deploy, the platform compiles each class and stores it as metadata. A compile error in any class blocks the deployment. Dependencies such as `Volume_Discount_Tier__mdt` and `Account.Customer_Tier__c` must exist first.
2. **Request.** An LWC calls `priceQuote`. The platform creates a transaction, deserializes the JSON arguments into `QuoteRequestLine` objects (this is why the no-argument constructor exists) and calls the method.
3. **Constructors.** `new QuotePricingService()` runs the field initializers (selectors), then the public constructor, which chains to the private one with `this(...)`. `MetadataDiscountTierProvider.tiers()` reads Custom Metadata through `getAll()`, which does not use a SOQL query.
4. **Queries.** The service runs exactly two SOQL queries however many lines the quote has: one on `PricebookEntry`, one on `Account`. The synchronous limit is 100 queries and 50,000 returned rows per transaction. The naive version would use one query per line and fail at line 101.
5. **Rules.** The loop calls each `PricingRule` through the interface. This is plain CPU work. The synchronous CPU limit is 10 seconds; 200 lines with two rules use a few milliseconds.
6. **Security.** `WITH USER_MODE` makes the platform check Read on `PricebookEntry`, field-level security on every field in the query, and record sharing on `Account`. A user without access gets a `System.QueryException` that names the problem.
7. **Return.** The result is serialized to JSON, and the heap (6 MB synchronous) is released with the transaction. Static variables disappear too.

In a debug log (Setup, Debug Logs, or `sf apex tail log`) look for these events:

```text
CODE_UNIT_STARTED|[EXTERNAL]|01p...|QuotePricingController.priceQuote
SOQL_EXECUTE_BEGIN|[34]|Aggregations:0|SELECT Id, UnitPrice, Product2.ProductCode ...
SOQL_EXECUTE_END|[34]|Rows:200
SOQL_EXECUTE_BEGIN|[8]|Aggregations:0|SELECT Id, Name, Customer_Tier__c FROM Account ...
LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 2 out of 100
  Number of DML statements: 0 out of 150
```

## Test it and verify

1. Run the tests: `sf apex run test --class-names QuotePricingServiceTest --code-coverage --result-format human --wait 10`. Expect all 8 tests to pass.
2. Run the demo in Execute Anonymous after seeding data:

```apex
// Anonymous Apex
Account buyer = [SELECT Id FROM Account WHERE Name = 'Brightline Demo Buyer' LIMIT 1];
List<QuoteRequestLine> lines = new List<QuoteRequestLine>{
    new QuoteRequestLine('BRG-100', 12),
    new QuoteRequestLine('BRG-200', 60),
    new QuoteRequestLine('NOPE-1', 1)
};
QuoteResult r = new QuotePricingService().price(buyer.Id, lines);
System.debug(JSON.serializePretty(r));
```

3. Expected values: `BRG-100` at 12 units gets 5% volume plus 5% Gold, so 10%: `40.00 * 12 * 0.90 = 432.00`. `BRG-200` at 60 units gets 10% plus 5%, so 15%: `15.50 * 60 * 0.85 = 790.50`. Subtotal 1410, total 1222.50, discount 187.50, and `NOPE-1` listed under `unknownProducts`.
4. Edit a tier in Setup, Custom Metadata Types, Manage Records, and run the script again. The prices change with no code deploy.
5. Log in as a user without the permission set and call the controller. You should see a user-mode access error, not data.

## Common mistakes and fixes

- **Symptom: "Too many SOQL queries: 101."** Cause: a query inside a loop. Fix: collect keys, query once, use a `Map` (the basic example above).
- **Symptom: a rep sees different prices than an admin.** Cause: user mode and sharing are working as designed; the rep cannot see some records or fields. Fix: grant access with a permission set. Do not switch to `without sharing` to hide the problem.
- **Symptom: behavior changes after raising a class's API version to 67.0 or higher.** Cause: user-context defaults and the removal of `WITH SECURITY_ENFORCED`. Fix: write sharing keywords and `WITH USER_MODE` or `WITH SYSTEM_MODE` explicitly, and re-run tests when you raise the version.
- **Symptom: "Script-thrown exception" in the LWC.** Cause: an `AuraHandledException` without `setMessage`. Fix: call `setMessage` as the controller does.
- **Symptom: the LWC fails to deserialize a parameter.** Cause: a wrapper class used as an `@AuraEnabled` parameter has no no-argument constructor or its members lack `@AuraEnabled`. Fix: add both.
- **Symptom: money totals like `53.97300000000001`.** Cause: `Double`. Fix: `Decimal` and `setScale(2, RoundingMode.HALF_UP)`.
- **Symptom: a test cannot insert Custom Metadata records.** Cause: Custom Metadata cannot be created by DML in tests. Fix: put the data behind an interface (`DiscountTierProvider`) and pass a test double.
- **Symptom: `NullPointerException` on `entry.Product2.Name`.** Cause: the field was not in the query. Fix: select every field you read, including relationship fields.

## Key takeaways

- A class groups data and behavior; keep each class small with one job.
- Constructors, static members and access modifiers are about control: who can create it, who can see it.
- Interfaces let you swap behavior, including swapping in a test double.
- Always write the sharing keyword and the access mode. Do not trust defaults, which changed at API 67.0.
- Query once per transaction step, then use maps. Put SOQL in selector classes.

## Where to go next

- [Apex classes: advanced patterns](/articles/apex-classes-advanced-patterns/)
- [Apex test classes: best practices](/articles/apex-test-classes-best-practices/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
- [Apex triggers from scratch](/articles/apex-triggers-from-scratch/)
- [Custom metadata, settings and labels](/articles/custom-metadata-settings-and-labels/)
