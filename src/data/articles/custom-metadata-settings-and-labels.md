---
title: "Custom Metadata Types, Custom Settings and Custom Labels: Configuration Without Code Changes"
description: "Choose between custom metadata, custom settings and custom labels, deploy configuration, read it in Apex and LWC, and test code that depends on it."
category: salesforce-development
tags: [Custom Metadata, Custom Settings, Custom Labels, Apex, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Custom Metadata Types Implementation Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.custMetadata.meta/custMetadata/"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Hard-coded values are the enemy of change. A discount limit, an endpoint, a feature switch, an error message: if they live inside Apex, every change needs a developer and a deployment. Salesforce gives you three tools to move them out: custom metadata types, custom settings and custom labels. Knowing which to use is the whole skill.

## The business scenario

Juniper Consulting sells to three customer tiers (Standard, Gold, Platinum), each with its own maximum discount and approval threshold. Finance changes these every quarter. A regional team also needs a switch to turn the new discount engine on for one profile at a time, and support wants the error message shown to reps to be editable and translatable. Today all of it is hard-coded in an Apex class, so each change is a release. You will move the tiers to custom metadata, the on/off switch to a hierarchy custom setting, and the message to a custom label.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox, with the Salesforce CLI and VS Code connected.
2. **Create the custom metadata type** `Discount_Tier__mdt` (Setup, Custom Metadata Types, New). Add fields: `Max_Discount_Percent__c` (Number 5,2), `Approval_Threshold__c` (Currency 16,2), and `Active__c` (Checkbox). Visibility: Public.
3. **Create records** for the type: Standard (10, 5000), Gold (15, 20000), Platinum (20, 50000), with `Active__c` checked.
4. **Create a hierarchy custom setting** `Discount_Settings__c` with a checkbox field `Engine_Enabled__c`. Hierarchy settings can be set for the whole org, a profile or a single user. Create an org-default record with the box checked.
5. **Create a custom label** `Discount_Too_High` with the value "The discount is above the allowed limit for this customer tier." (Setup, Custom Labels). Add a translation if you use translation workbench.
6. Add a **Tier** text field `Customer_Tier__c` to Account (or a picklist with the same three values).
7. Decide who may edit configuration. Custom metadata records are editable by admins with the "Customize Application" permission; custom settings use the setting's own permission and sharing.

### In the external system

None, unless your configuration is also needed outside Salesforce. In that case expose it through a read-only Apex REST resource, and do not duplicate the values into another system's config files, or the two will drift.

## How it works

| Tool | Holds | Changes by | Deployable | In tests |
|---|---|---|---|---|
| **Custom metadata type** | Rows of config, a record per row | Admin in Setup; metadata deploy | Yes, records deploy as metadata | Records are visible to tests |
| **Custom setting** (list or hierarchy) | Data rows | Admin or code (it is data) | Definition deploys, **data does not** | You create rows in the test |
| **Custom label** | A single text string | Admin; translatable | Yes | Readable |

Use **custom metadata** for configuration that is the same in every environment and should deploy with your code: tiers, mappings, endpoints, feature definitions. Use a **hierarchy custom setting** when the value must **vary by profile or user**, or when code needs to write it. Use a **custom label** for user-facing text that must be translatable.

Reading them:

- Custom metadata: `Discount_Tier__mdt.getAll()` returns a map by developer name; `getInstance('Gold')` returns one. Neither uses a SOQL query, so they do not count against the query limit.
- Hierarchy setting: `Discount_Settings__c.getInstance()` returns the most specific record for the running user (user, then profile, then org).
- Label: `System.Label.Discount_Too_High` in Apex, `@salesforce/label/c.Discount_Too_High` in LWC.

## Basic example

```apex
public with sharing class BasicConfig {
    public static Decimal maxDiscountFor(String tier) {
        Discount_Tier__mdt rule = Discount_Tier__mdt.getInstance(tier);
        return rule == null ? 0 : rule.Max_Discount_Percent__c;
    }

    public static Boolean engineOn() {
        Discount_Settings__c s = Discount_Settings__c.getInstance();
        return s != null && s.Engine_Enabled__c == true;
    }

    public static String tooHighMessage() {
        return System.Label.Discount_Too_High;
    }
}
```

In a Lightning web component the label is imported, not queried:

```javascript
import tooHigh from '@salesforce/label/c.Discount_Too_High';

export default class DiscountBanner extends LightningElement {
    label = { tooHigh };
}
```

## Advanced end-to-end example

A discount validator that reads all three, supports test overrides (custom metadata records cannot be inserted in tests, so you inject them), and caches configuration for the transaction.

**force-app/main/default/customMetadata/Discount_Tier.Gold.md-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Gold</label>
    <protected>false</protected>
    <values>
        <field>Active__c</field>
        <value xsi:type="xsd:boolean">true</value>
    </values>
    <values>
        <field>Approval_Threshold__c</field>
        <value xsi:type="xsd:double">20000.0</value>
    </values>
    <values>
        <field>Max_Discount_Percent__c</field>
        <value xsi:type="xsd:double">15.0</value>
    </values>
</CustomMetadata>
```

**force-app/main/default/classes/DiscountConfig.cls**

```apex
public with sharing class DiscountConfig {

    public class Tier {
        public String name;
        public Decimal maxPercent;
        public Decimal approvalThreshold;
        public Boolean active;
    }

    // Tests set this instead of relying on the org's configuration.
    @TestVisible private static Map<String, Tier> testTiers;
    private static Map<String, Tier> cache;

    public static Map<String, Tier> tiers() {
        if (testTiers != null) {
            return testTiers;
        }
        if (cache == null) {
            cache = new Map<String, Tier>();
            for (Discount_Tier__mdt row : Discount_Tier__mdt.getAll().values()) {
                Tier t = new Tier();
                t.name = row.DeveloperName;
                t.maxPercent = row.Max_Discount_Percent__c;
                t.approvalThreshold = row.Approval_Threshold__c;
                t.active = row.Active__c;
                cache.put(t.name, t);
            }
        }
        return cache;
    }

    public static Tier forTier(String name) {
        Tier t = tiers().get(name);
        if (t == null || t.active != true) {
            throw new DiscountException('No active discount tier named ' + name);
        }
        return t;
    }

    @TestVisible private static Boolean testEngine;

    public static Boolean engineEnabled() {
        if (testEngine != null) {
            return testEngine;
        }
        Discount_Settings__c setting = Discount_Settings__c.getInstance();
        return setting != null && setting.Engine_Enabled__c == true;
    }
}
```

**force-app/main/default/classes/DiscountException.cls**

```apex
public class DiscountException extends Exception {}
```

**force-app/main/default/classes/DiscountValidator.cls**

```apex
public with sharing class DiscountValidator {

    public class Result {
        @AuraEnabled public Boolean allowed;
        @AuraEnabled public Boolean needsApproval;
        @AuraEnabled public String message;
    }

    public static Result check(String tierName, Decimal discountPercent, Decimal orderAmount) {
        Result result = new Result();
        result.allowed = true;
        result.needsApproval = false;

        if (!DiscountConfig.engineEnabled()) {
            result.message = 'Discount engine is off for your profile.';
            return result;
        }
        if (discountPercent == null || discountPercent < 0) {
            throw new DiscountException('Discount must be zero or more.');
        }

        DiscountConfig.Tier tier = DiscountConfig.forTier(tierName);
        if (discountPercent > tier.maxPercent) {
            result.allowed = false;
            result.message = System.Label.Discount_Too_High;
            return result;
        }
        if (orderAmount != null && orderAmount >= tier.approvalThreshold) {
            result.needsApproval = true;
            result.message = 'Orders of ' + tier.approvalThreshold + ' or more need approval.';
        }
        return result;
    }

    @AuraEnabled(cacheable=true)
    public static Result checkForAccount(Id accountId, Decimal discountPercent, Decimal orderAmount) {
        Account account = [SELECT Customer_Tier__c FROM Account WHERE Id = :accountId WITH USER_MODE LIMIT 1];
        try {
            return check(account.Customer_Tier__c, discountPercent, orderAmount);
        } catch (DiscountException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }
}
```

**force-app/main/default/classes/DiscountValidatorTest.cls**

```apex
@IsTest
private class DiscountValidatorTest {

    private static DiscountConfig.Tier tier(String name, Decimal max, Decimal threshold, Boolean active) {
        DiscountConfig.Tier t = new DiscountConfig.Tier();
        t.name = name;
        t.maxPercent = max;
        t.approvalThreshold = threshold;
        t.active = active;
        return t;
    }

    @TestSetup
    static void setup() {
        // Hierarchy settings are data, so each test class creates its own.
        insert new Discount_Settings__c(SetupOwnerId = UserInfo.getOrganizationId(), Engine_Enabled__c = true);
    }

    private static void setupData() {
        DiscountConfig.testTiers = new Map<String, DiscountConfig.Tier>{
            'Gold' => tier('Gold', 15, 20000, true),
            'Retired' => tier('Retired', 5, 100, false)
        };
    }

    @IsTest
    static void allowsADiscountWithinTheTierLimit() {
        setupData();
        DiscountValidator.Result r = DiscountValidator.check('Gold', 10, 1000);
        System.assertEquals(true, r.allowed);
        System.assertEquals(false, r.needsApproval);
    }

    @IsTest
    static void blocksADiscountAboveTheLimitWithTheLabelText() {
        setupData();
        DiscountValidator.Result r = DiscountValidator.check('Gold', 16, 1000);
        System.assertEquals(false, r.allowed);
        System.assertEquals(System.Label.Discount_Too_High, r.message);
    }

    @IsTest
    static void requiresApprovalAtOrAboveTheThreshold() {
        setupData();
        DiscountValidator.Result r = DiscountValidator.check('Gold', 5, 20000);
        System.assertEquals(true, r.allowed);
        System.assertEquals(true, r.needsApproval);
    }

    @IsTest
    static void rejectsInactiveOrUnknownTiers() {
        setupData();
        for (String name : new List<String>{ 'Retired', 'Nope' }) {
            try {
                DiscountValidator.check(name, 1, 1);
                System.assert(false, 'Expected an exception for ' + name);
            } catch (DiscountException e) {
                System.assert(e.getMessage().contains('No active discount tier'));
            }
        }
    }

    @IsTest
    static void doesNothingWhenTheEngineIsSwitchedOff() {
        setupData();
        DiscountConfig.testEngine = false;
        DiscountValidator.Result r = DiscountValidator.check('Gold', 99, 1);
        System.assertEquals(true, r.allowed);
        System.assert(r.message.contains('off'));
    }

    @IsTest
    static void readsTheRealHierarchySettingWhenNotOverridden() {
        System.assertEquals(true, DiscountConfig.engineEnabled());
        Discount_Settings__c userRow = new Discount_Settings__c(
            SetupOwnerId = UserInfo.getUserId(), Engine_Enabled__c = false);
        insert userRow;
        System.assertEquals(false, DiscountConfig.engineEnabled(), 'The user row is more specific');
    }
}
```

Deploy and verify:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names DiscountValidatorTest --result-format human --wait 10 --target-org dev
```

## What happens behind the scenes

Custom metadata types are **metadata**, not data, even though each record looks like a row. The platform loads them into a cache with the rest of the org's metadata, which is why `getAll()` and `getInstance()` need no SOQL and cost nothing against query limits. It is also why records move with a deployment and appear identically in every sandbox, and why developers cannot insert them in a test: the test would be altering metadata. That is the reason `DiscountConfig` has a `@TestVisible testTiers`. A test substitutes a controlled map, so tests do not break when finance changes a percentage.

Custom settings are **data** with a special cache. A hierarchy setting resolves like this: if there is a row for the running user, use it; else a row for the user's profile; else the org default. `getInstance()` performs that lookup in memory, again without a query. Because they are data, the *definition* of the setting deploys but the *values* do not, so you create the values in each org, and in tests.

A custom label is a named string in the metadata. Apex reads it through `System.Label`, which also picks the translation that matches the running user's language. In LWC the `@salesforce/label` import is resolved by the platform at load time, so the component receives the translated text with no server call.

The validator caches the converted tiers in a static variable. Statics live for one transaction, so the cache is rebuilt on the next request and always reflects the latest configuration, with no stale data between users.

## Test it and verify

1. Run the six tests and confirm they pass.
2. Change `Max_Discount_Percent__c` for Gold in Setup and re-run an anonymous call; the new limit applies immediately, with no deployment.
3. Create a profile-level `Discount_Settings__c` row with the box unchecked and log in as a user of that profile; confirm that the validator reports "engine is off".
4. Edit the custom label text and reload the page; the message changes.
5. Deploy to a second sandbox and confirm the tiers arrived but the custom setting row did not, so create it there.

## Common mistakes and fixes

- **Expecting custom setting values to deploy.** Only the definition deploys; load data separately.
- **Trying to insert custom metadata in a test.** Inject test data through a `@TestVisible` hook, or use the Metadata API only where unavoidable.
- **Using custom settings for deployable configuration.** Use custom metadata.
- **Using a custom label for large content.** Labels hold up to 1,000 characters; use a custom object or static resource for more.
- **Querying custom metadata with SOQL everywhere.** `getAll()` and `getInstance()` are cheaper.
- **Treating `getInstance` as never null.** Handle a missing record.
- **Hiding sensitive values in unprotected metadata.** Mark records protected or use a Named Credential for secrets.

## Key takeaways

- Custom metadata for deployable configuration, custom settings for per-user or per-profile values, labels for translatable text.
- Reading them does not cost SOQL queries.
- Values must be injectable so tests are stable.
- Configuration changes should not need code releases.
- Keep secrets out of all three; use Named Credentials.

## Where to go next

- Read [Apex classes zero to hero](/articles/apex-classes-zero-to-hero/) for the class structure used here.
- Read [Apex test classes best practices](/articles/apex-test-classes-best-practices/) for injecting configuration in tests.
- Read [Named Credentials and external callouts](/articles/rest-callouts-named-credentials/) for storing secrets properly.
