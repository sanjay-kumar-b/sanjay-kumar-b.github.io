---
title: "Validation Rule Patterns Every Admin Should Know"
description: "Reusable validation rule formulas for opportunities, a bypass switch for data loads, an Apex addError twin and tests that prove both layers."
category: salesforce-administration
tags: [Validation Rules, Formulas, Data Quality, Apex]
publishedAt: 2026-10-30
updatedAt: 2026-11-13
cover: /images/covers/validation-rule-patterns.jpg
sources:
  - title: "Validation Rules (Salesforce Help)"
    url: "https://help.salesforce.com/s/products/platform"
  - title: "Trailhead: Bypass Your Validation Rules"
    url: "https://trailhead.salesforce.com/content/learn/modules/validation-rules/bypass-your-validation-rules"
  - title: "Trailhead: Implement Validation Rule Best Practices"
    url: "https://trailhead.salesforce.com/content/learn/modules/validation-rules/implement-best-practices"
  - title: "Trailhead: Use Custom Metadata Types in Formulas, Default Values, and Validation Rules"
    url: "https://trailhead.salesforce.com/content/learn/modules/custom_metadata_types_dec/cmt_formulas"
  - title: "Sample Opportunity Management Validation Rules (Salesforce Help)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.usefulValidationRules.meta/usefulValidationRules/fields_useful_validation_formulas_oppty_mgmt.htm"
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
  - title: "FeatureManagement Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.262.0.apexref.meta/apexref/apex_class_System_FeatureManagement.htm"
  - title: "SObject Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexref.meta/apexref/apex_methods_system_sobject.htm"
---

A **validation rule** is a formula that Salesforce evaluates when a record is saved. If the formula returns **true**, the save is blocked and your error message is shown. That is the opposite of how many people first think about it, so write every rule as the question "what is wrong with this record?" and not "what must be true?".

Validation rules are the cheapest data-quality control in the platform. They need no code, they run for every save path (UI, API, Flow, Apex, data loads) and an admin can change them without a deployment. They also have limits. A formula cannot read child records, cannot call a service, and can lock out an integration the day you activate it. This article gives you eight reusable patterns, a two-switch bypass design, an Apex `addError` twin for the rules a formula cannot express, tests that prove both layers, and a safe way to load data.

## The business scenario

Larkspur Packaging (a fictional B2B packaging distributor) runs order-to-cash on the Opportunity object. A won opportunity becomes a purchase order, a shipment and an invoice, so bad data on a won deal is expensive. Sales operations and finance agree on these guards:

1. A deal closed as **lost** must carry a loss reason, so win/loss reports are usable.
2. A deal closed as **won** must carry a customer PO number.
3. The PO number must match the format `PO-` plus six digits, because the ERP rejects anything else.
4. After a deal is won, its **amount is locked**.
5. A won deal cannot be **reopened**.
6. A deal cannot be won while the customer's credit status is **Hold**.
7. A deal cannot be won above the account's **credit limit**, unless the payment terms are Prepaid.
8. A discount above the company limit needs a **Discount Approved** tick from the deal desk. The limit lives in Custom Metadata so finance can change it.
9. A deal cannot be won while the account has an **open high-priority support case**. A formula cannot see child records, so this one needs Apex.

Two operational needs complete the picture. The nightly ERP integration and one-off data migrations must be able to skip the guards, and an admin must be able to switch the whole set off during an incident without deploying anything.

| Piece | Layer | Job |
|---|---|---|
| Eight `OPP00x` validation rules | Declarative | Rules 1 to 8 |
| Custom Permission `Bypass_Order_Guards` | Both | Per-person switch |
| Custom Metadata `Order_Guard_Setting__mdt` | Both | Org-wide switch and discount limit |
| `WonDealGuard` plus trigger | Apex | Rule 9 and the same switches |
| Two test classes | Tests | Prove both layers and the bypass |

## Before you start: setup

Everything runs inside Salesforce. The only outside piece is the file or tool you use to load data. Menu labels can differ slightly by release, so use the Quick Find box in Setup if a path has moved.

### In Salesforce

1. **Use a safe org.** A Developer Edition or scratch org, never production. Why: you will create fields, rules and a trigger. Verify: you can open Setup and Object Manager.
2. **Create two Account fields.** `Credit_Status__c` (Picklist: Good, Watch, Hold) and `Credit_Limit__c` (Currency, 16 digits, 2 decimals). Why: rules 6 and 7 read them through the Account lookup. Verify: both appear on Account.
3. **Create five Opportunity fields.** `Loss_Reason__c` (Picklist: Price, Competitor, No budget, Timing, Other), `PO_Number__c` (Text, 20), `Payment_Terms__c` (Picklist: Net 15, Net 30, Net 60, Prepaid), `Discount_Percent__c` (Percent) and `Discount_Approved__c` (Checkbox). Verify: all five appear on Opportunity. XML for steps 2 to 5 is in the advanced section.
4. **Create the Custom Metadata Type `Order Guard Setting`.** Setup, Custom Metadata Types, New, API name `Order_Guard_Setting__mdt`. Add `Is_Enforced__c` (Checkbox, default checked) and `Max_Discount_Percent__c` (Percent). Why: finance changes the limit and flips the switch without a deployment. Verify: Manage Records opens an empty list.
5. **Add one record.** Label and name `Default`, Is Enforced checked, Max Discount Percent 15. Verify: `SELECT DeveloperName, Is_Enforced__c, Max_Discount_Percent__c FROM Order_Guard_Setting__mdt` returns one row.
6. **Create the Custom Permission `Bypass Order Guards`** (API name `Bypass_Order_Guards`) and a permission set `Order Guard Bypass` that contains it. Do not assign it yet. Verify: Setup, Permission Sets, Order Guard Bypass, Custom Permissions shows it enabled.
7. **Check standard values.** Opportunity stages `Closed Won`, `Closed Lost` and `Prospecting`, and Case priority `High`. Why: the rules and tests compare these exact labels. Verify: Object Manager, Opportunity, Fields, Stage (and Case, Priority).
8. **Give yourself field access.** Make the new fields visible to your profile or a permission set. Why: the UI hides fields you cannot see, and your tests in the UI would show nothing. Verify: add the fields to the Opportunity page layout and open a record.
9. **Prepare a loader user.** Create or pick a user that stands in for the ERP integration. Why: you will give that user the bypass permission set. Verify: you know the username.
10. **Set the debug log level.** Setup, Debug Logs, New trace flag for your user, and use a debug level with the **Validation** category at INFO or higher. Why: the log then names each rule that ran. Verify: the trace flag has a future expiry.

### In the external system

There is no third-party service. If you load data with Data Loader or another tool, install it and log in as the loader user, then confirm you can reach the org. The command line examples use the Salesforce CLI instead.

### On your machine

1. Install the Salesforce CLI (`sf`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version` prints a version.
2. Authorize the org: `sf org login web --alias larkspur`. Verify: `sf org list` shows it.

## How it works

### Terms

A **validation rule** has an **error condition formula**, an **error message** and an optional **error location** (a field, or the top of the page). A **custom permission** is a named yes/no flag that you assign through a permission set and read in formulas as `$Permission.Name` and in Apex with `FeatureManagement.checkPermission`. **Custom Metadata** is configuration stored as deployable records, readable in formulas as `$CustomMetadata.Type__mdt.Record.Field__c`. A **bypass** is a deliberate way to skip a rule for a person or for the whole org.

### Where rules run

Validation rules run in the order of execution after before triggers and before the record is saved, as the order of execution page in the sources shows:

```text
Request (UI, API, Flow, Apex, data load)
   |
   v
Before-save flows -> BEFORE TRIGGERS (WonDealGuard: rule 9)
   |
   v
Custom validation rules (OPP001 ... OPP008)      <- see the values your trigger wrote
   |
   v
Duplicate rules -> save (not committed) -> after triggers -> commit
```

Because rules run after before triggers, a trigger can set a default that a rule then checks. Rules also fire when automation saves a record, for example a Flow that updates an Opportunity, so an error can appear for a user who never touched the field.

### Formula functions and their Apex twins

Every rule here has an Apex equivalent. Knowing the mapping tells you what the platform does for you.

| Formula | Apex equivalent |
|---|---|
| `ISBLANK(PO_Number__c)` | `String.isBlank(opp.PO_Number__c)` |
| `ISPICKVAL(StageName, "Closed Won")` | `opp.StageName == 'Closed Won'` |
| `ISNEW()` | `Trigger.isInsert`, or an old map that is `null` |
| `ISCHANGED(Amount)` | `opp.Amount != oldMap.get(opp.Id).Amount` |
| `PRIORVALUE(StageName)` | `oldMap.get(opp.Id).StageName` |
| `REGEX(text, "PO-[0-9]{6}")` | `Pattern.matches('PO-[0-9]{6}', text)` |
| `Account.Credit_Status__c` | A query on Account, collected in bulk |
| `$Permission.Bypass_Order_Guards` | `FeatureManagement.checkPermission('Bypass_Order_Guards')` |
| `$CustomMetadata.T__mdt.Default.F__c` | `T__mdt.getInstance('Default').F__c` |

Two facts about `REGEX` matter. It must match the **whole** value, so no anchors are needed, and it is case sensitive. And picklists need special handling: `ISBLANK` does not accept a picklist field, so write `ISPICKVAL(Loss_Reason__c, "")` or `ISBLANK(TEXT(Loss_Reason__c))`.

### Formula or Apex

Use a validation rule when the data is on the record or on a parent reached through a lookup. Use Apex when you need child records, a callout, a calculation across many records, or logic that must live in version control with unit tests. Many teams use both for the same business rule. The formula is the visible, admin-owned layer. The Apex layer covers what formulas cannot see.

## Basic example

One rule, in both layers. Opportunities closed as lost must have a loss reason. In the UI: Setup, Object Manager, Opportunity, Validation Rules, New.

- **Rule name:** `OPP001_Loss_Reason_Required`
- **Error condition formula:**

```text
AND(
  ISPICKVAL(StageName, "Closed Lost"),
  ISPICKVAL(Loss_Reason__c, "")
)
```

- **Error message:** `OPP001: Choose a loss reason before closing an opportunity as lost.`
- **Error location:** Field, `Loss_Reason__c`.

Or deploy it as metadata. The file name gives the rule its name:

**`force-app/main/default/objects/Opportunity/validationRules/OPP001_Loss_Reason_Required.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>A lost deal must say why it was lost.</description>
    <errorConditionFormula>AND(
  ISPICKVAL(StageName, "Closed Lost"),
  ISPICKVAL(Loss_Reason__c, "")
)</errorConditionFormula>
    <errorDisplayField>Loss_Reason__c</errorDisplayField>
    <errorMessage>OPP001: Choose a loss reason before closing an opportunity as lost.</errorMessage>
</ValidationRule>
```

Now the same check in Apex. This trigger is a teaching twin and you would not deploy both in production, because the user would see two errors.

```apex
trigger OpportunityTrigger on Opportunity (before insert, before update) {
    for (Opportunity opp : Trigger.new) {
        // Same condition as the formula: it describes what is WRONG, then rejects.
        if (opp.StageName == 'Closed Lost' && String.isBlank(opp.Loss_Reason__c)) {
            opp.Loss_Reason__c.addError(
                'OPP001: Choose a loss reason before closing an opportunity as lost.'
            );
        }
    }
}
```

Try it in Execute Anonymous:

```apex
// Anonymous Apex
Opportunity opp = new Opportunity(
    Name = 'Basic test', StageName = 'Closed Lost', CloseDate = Date.today()
);
Database.SaveResult result = Database.insert(opp, false);
System.debug('Saved: ' + result.isSuccess());
System.debug('Message: ' + result.getErrors()[0].getMessage());
```

Expected output: `Saved: false` and `Message: OPP001: Choose a loss reason before closing an opportunity as lost.` With the rule active, the platform returns the same error even if you delete the trigger. Add `Loss_Reason__c = 'Price'` and the insert succeeds.

The most common first mistake is a condition that looks right and does not even save. Picklists cannot go through `ISBLANK`:

```text
// BAD: the editor refuses this with an error that picklist fields are only
// supported in certain functions.
AND(ISPICKVAL(StageName, "Closed Lost"), ISBLANK(Loss_Reason__c))

// FIXED: compare the picklist with an empty value, or convert it to text first.
AND(ISPICKVAL(StageName, "Closed Lost"), ISBLANK(TEXT(Loss_Reason__c)))
```

The second mistake only shows up after go-live. This rule runs on every save of every won deal, including old ones:

```text
// BAD: every won deal in the org that has no PO number now blocks ANY edit,
// including a change of owner by someone who cannot see the PO field.
AND(ISPICKVAL(StageName, "Closed Won"), ISBLANK(PO_Number__c))

// FIXED: only judge the record when it becomes won or is created won.
AND(
  ISPICKVAL(StageName, "Closed Won"),
  OR(ISNEW(), ISCHANGED(StageName)),
  ISBLANK(PO_Number__c)
)
```

This is the best-practice point in the Trailhead page in the sources: use `ISNEW()` and `ISCHANGED()` so a rule fires only for new records or relevant changes.

## Advanced end-to-end example

The files below deploy the whole Larkspur design: fields, the Custom Metadata type, the two bypass pieces, eight validation rules, the Apex guard for rule 9, a data-load script and tests for both layers. If you deployed the basic trigger above, replace it with the `OpportunityTrigger` below, because an object should have one trigger.

### Metadata: fields

**`force-app/main/default/objects/Account/fields/Credit_Status__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Credit_Status__c</fullName>
    <label>Credit Status</label>
    <required>false</required>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Good</fullName><default>true</default><label>Good</label></value>
            <value><fullName>Watch</fullName><default>false</default><label>Watch</label></value>
            <value><fullName>Hold</fullName><default>false</default><label>Hold</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Account/fields/Credit_Limit__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Credit_Limit__c</fullName>
    <label>Credit Limit</label>
    <precision>16</precision>
    <scale>2</scale>
    <required>false</required>
    <type>Currency</type>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Loss_Reason__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Loss_Reason__c</fullName>
    <label>Loss Reason</label>
    <required>false</required>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Price</fullName><default>false</default><label>Price</label></value>
            <value><fullName>Competitor</fullName><default>false</default><label>Competitor</label></value>
            <value><fullName>No budget</fullName><default>false</default><label>No budget</label></value>
            <value><fullName>Timing</fullName><default>false</default><label>Timing</label></value>
            <value><fullName>Other</fullName><default>false</default><label>Other</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/Payment_Terms__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Payment_Terms__c</fullName>
    <label>Payment Terms</label>
    <required>false</required>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Net 15</fullName><default>false</default><label>Net 15</label></value>
            <value><fullName>Net 30</fullName><default>false</default><label>Net 30</label></value>
            <value><fullName>Net 60</fullName><default>false</default><label>Net 60</label></value>
            <value><fullName>Prepaid</fullName><default>false</default><label>Prepaid</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Opportunity/fields/PO_Number__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>PO_Number__c</fullName>
    <label>PO Number</label>
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

**`force-app/main/default/objects/Opportunity/fields/Discount_Approved__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Discount_Approved__c</fullName>
    <defaultValue>false</defaultValue>
    <label>Discount Approved</label>
    <type>Checkbox</type>
</CustomField>
```

### Metadata: the two bypass switches

**`force-app/main/default/objects/Order_Guard_Setting__mdt/Order_Guard_Setting__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Order Guard Setting</label>
    <pluralLabel>Order Guard Settings</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/Order_Guard_Setting__mdt/fields/Is_Enforced__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Is_Enforced__c</fullName>
    <defaultValue>true</defaultValue>
    <fieldManageability>SubscriberControlled</fieldManageability>
    <label>Is Enforced</label>
    <type>Checkbox</type>
</CustomField>
```

**`force-app/main/default/objects/Order_Guard_Setting__mdt/fields/Max_Discount_Percent__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Max_Discount_Percent__c</fullName>
    <fieldManageability>SubscriberControlled</fieldManageability>
    <label>Max Discount Percent</label>
    <precision>5</precision>
    <scale>2</scale>
    <required>false</required>
    <type>Percent</type>
</CustomField>
```

**`force-app/main/default/customMetadata/Order_Guard_Setting.Default.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
    xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
    xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Is_Enforced__c</field>
        <value xsi:type="xsd:boolean">true</value>
    </values>
    <values>
        <field>Max_Discount_Percent__c</field>
        <value xsi:type="xsd:double">15.0</value>
    </values>
</CustomMetadata>
```

**`force-app/main/default/customPermissions/Bypass_Order_Guards.customPermission-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">
    <isLicensed>false</isLicensed>
    <label>Bypass Order Guards</label>
</CustomPermission>
```

**`force-app/main/default/permissionsets/Order_Guard_Bypass.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Order Guard Bypass</label>
    <description>Skips the order guard validation rules and the WonDealGuard trigger.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <customPermissions>
        <enabled>true</enabled>
        <name>Bypass_Order_Guards</name>
    </customPermissions>
</PermissionSet>
```

### Metadata: the eight validation rules

Every rule starts with the same **guard**. It means "the org switch is on, and this user does not hold the bypass permission, and the real condition is true":

```text
AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  /* the real condition */
)
```

Each rule covers one scenario so that its message is exact and the error lands on the right field. XML needs `&gt;` and `&lt;` in place of `>` and `<`. Error codes (`OPP001` and so on) let a user quote the rule to support, as the Trailhead best-practice page in the sources suggests.

**`force-app/main/default/objects/Opportunity/validationRules/OPP001_Loss_Reason_Required.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Required-when: a lost deal must say why. Fires on create or stage change.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  ISPICKVAL(StageName, "Closed Lost"),
  OR(ISNEW(), ISCHANGED(StageName), ISCHANGED(Loss_Reason__c)),
  ISPICKVAL(Loss_Reason__c, "")
)</errorConditionFormula>
    <errorDisplayField>Loss_Reason__c</errorDisplayField>
    <errorMessage>OPP001: Choose a loss reason before closing an opportunity as lost.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP002_PO_Required_When_Won.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Required-when: a won deal needs the customer PO number.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  ISPICKVAL(StageName, "Closed Won"),
  OR(ISNEW(), ISCHANGED(StageName), ISCHANGED(PO_Number__c)),
  ISBLANK(PO_Number__c)
)</errorConditionFormula>
    <errorDisplayField>PO_Number__c</errorDisplayField>
    <errorMessage>OPP002: Enter the customer PO number before closing the deal as won.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP003_PO_Format.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Format: PO numbers look like PO-123456. REGEX matches the whole value.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  OR(ISNEW(), ISCHANGED(PO_Number__c)),
  NOT(ISBLANK(PO_Number__c)),
  NOT(REGEX(PO_Number__c, "PO-[0-9]{6}"))
)</errorConditionFormula>
    <errorDisplayField>PO_Number__c</errorDisplayField>
    <errorMessage>OPP003: Use the PO format PO- followed by six digits, for example PO-104522.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP004_Won_Amount_Locked.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Change-only: once won, the amount cannot change. Uses PRIORVALUE.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  NOT(ISNEW()),
  ISCHANGED(Amount),
  ISPICKVAL(PRIORVALUE(StageName), "Closed Won")
)</errorConditionFormula>
    <errorDisplayField>Amount</errorDisplayField>
    <errorMessage>OPP004: The amount of a won deal is locked. Ask Finance to adjust it.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP005_Won_Cannot_Reopen.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Change-only: a won deal cannot move back to an open or lost stage.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  NOT(ISNEW()),
  ISCHANGED(StageName),
  ISPICKVAL(PRIORVALUE(StageName), "Closed Won"),
  NOT(ISPICKVAL(StageName, "Closed Won"))
)</errorConditionFormula>
    <errorDisplayField>StageName</errorDisplayField>
    <errorMessage>OPP005: A won deal cannot be reopened. Create a new opportunity instead.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP006_Credit_Hold.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Cross-object: blocks a win while the Account credit status is Hold.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  ISPICKVAL(StageName, "Closed Won"),
  OR(ISNEW(), ISCHANGED(StageName)),
  ISPICKVAL(Account.Credit_Status__c, "Hold")
)</errorConditionFormula>
    <errorDisplayField>StageName</errorDisplayField>
    <errorMessage>OPP006: This account is on credit hold. Ask Finance to release it first.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP007_Credit_Limit.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Cross-object: a won, non-prepaid deal cannot exceed the Account credit limit.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  ISPICKVAL(StageName, "Closed Won"),
  OR(ISNEW(), ISCHANGED(StageName), ISCHANGED(Amount)),
  NOT(ISPICKVAL(Payment_Terms__c, "Prepaid")),
  NOT(ISBLANK(Amount)),
  NOT(ISBLANK(Account.Credit_Limit__c)),
  Amount &gt; Account.Credit_Limit__c
)</errorConditionFormula>
    <errorDisplayField>Amount</errorDisplayField>
    <errorMessage>OPP007: The amount is above the credit limit. Use Prepaid terms or ask Finance to raise the limit.</errorMessage>
</ValidationRule>
```

**`force-app/main/default/objects/Opportunity/validationRules/OPP008_Discount_Approval.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <active>true</active>
    <description>Config-driven: the discount limit comes from Custom Metadata, not the formula.</description>
    <errorConditionFormula>AND(
  $CustomMetadata.Order_Guard_Setting__mdt.Default.Is_Enforced__c,
  NOT($Permission.Bypass_Order_Guards),
  OR(ISNEW(), ISCHANGED(Discount_Percent__c), ISCHANGED(Discount_Approved__c)),
  NOT(ISBLANK(Discount_Percent__c)),
  Discount_Percent__c &gt; $CustomMetadata.Order_Guard_Setting__mdt.Default.Max_Discount_Percent__c,
  NOT(Discount_Approved__c)
)</errorConditionFormula>
    <errorDisplayField>Discount_Approved__c</errorDisplayField>
    <errorMessage>OPP008: This discount is above the company limit. Get Deal Desk approval first.</errorMessage>
</ValidationRule>
```

Rule OPP008 compares a Percent field with a Percent Custom Metadata field, so both sides use the same scale. If you ever compare a Percent field with a typed number, test it on a record first, because formulas treat percent values as fractions.

### Apex: the same switches and rule 9

**`force-app/main/default/classes/OrderGuardBypass.cls`**

```apex
public inherited sharing class OrderGuardBypass {
    // Custom Metadata records are readable in tests, but a test cannot change them,
    // so tests flip this override to prove the switch works.
    @TestVisible
    private static Boolean enforcedOverride;

    // Org switch: the same Is_Enforced__c flag the validation rules read.
    public static Boolean isEnforced() {
        if (enforcedOverride != null) {
            return enforcedOverride;
        }
        // getInstance reads cached metadata and does not use a SOQL query.
        Order_Guard_Setting__mdt setting = Order_Guard_Setting__mdt.getInstance('Default');
        // A missing record means "enforced", so a lost record never turns the guard off.
        return setting == null || setting.Is_Enforced__c;
    }

    // Person switch: the same custom permission the validation rules read.
    public static Boolean userMayBypass() {
        return FeatureManagement.checkPermission('Bypass_Order_Guards');
    }

    public static Boolean shouldRun() {
        return isEnforced() && !userMayBypass();
    }
}
```

**`force-app/main/default/classes/OpenCaseLookup.cls`**

```apex
// Deliberately without sharing and in system mode. A rep cannot see every support case,
// and a guard that only checks what the rep can see would let a risky deal through.
public without sharing class OpenCaseLookup {
    public Set<Id> accountsWithOpenHighPriorityCases(Set<Id> accountIds) {
        Set<Id> result = new Set<Id>();
        for (AggregateResult row : [
            SELECT AccountId acct
            FROM Case
            WHERE AccountId IN :accountIds AND IsClosed = false AND Priority = 'High'
            WITH SYSTEM_MODE
            GROUP BY AccountId
        ]) {
            result.add((Id) row.get('acct'));
        }
        return result;
    }
}
```

**`force-app/main/default/classes/WonDealGuard.cls`**

```apex
public with sharing class WonDealGuard {
    private static final String CLOSED_WON = 'Closed Won';

    // previousById is null on insert. On update it holds the old versions by Id.
    public static void beforeSave(List<Opportunity> opps, Map<Id, Opportunity> previousById) {
        if (!OrderGuardBypass.shouldRun()) {
            return;
        }
        List<Opportunity> becomingWon = new List<Opportunity>();
        Set<Id> accountIds = new Set<Id>();
        for (Opportunity opp : opps) {
            Opportunity previous = previousById == null ? null : previousById.get(opp.Id);
            Boolean justWon = opp.StageName == CLOSED_WON
                && (previous == null || previous.StageName != CLOSED_WON);
            if (justWon && opp.AccountId != null) {
                becomingWon.add(opp);
                accountIds.add(opp.AccountId);
            }
        }
        if (becomingWon.isEmpty()) {
            return;
        }
        // One query for the whole chunk, never one per opportunity.
        Set<Id> blocked = new OpenCaseLookup().accountsWithOpenHighPriorityCases(accountIds);
        for (Opportunity opp : becomingWon) {
            if (blocked.contains(opp.AccountId)) {
                opp.StageName.addError(
                    'OPP009: This account has an open high-priority case. '
                    + 'Support must resolve it before the deal can close.'
                );
            }
        }
    }
}
```

**`force-app/main/default/triggers/OpportunityTrigger.trigger`**

```apex
trigger OpportunityTrigger on Opportunity (before insert, before update) {
    switch on Trigger.operationType {
        when BEFORE_INSERT {
            WonDealGuard.beforeSave(Trigger.new, null);
        }
        when BEFORE_UPDATE {
            WonDealGuard.beforeSave(Trigger.new, (Map<Id, Opportunity>) Trigger.oldMap);
        }
    }
}
```

### Tests: both layers

The validation rule tests do not need a trigger. The platform enforces the rules inside the test, so a `Database.insert` with `allOrNone` false returns the rule's message. The deployed Custom Metadata record (`Is_Enforced__c` true, limit 15) is what these tests read.

**`force-app/main/default/classes/ValidationRulesTest.cls`**

```apex
@IsTest
private class ValidationRulesTest {
    private static Account makeAccount(String creditStatus, Decimal creditLimit) {
        Account acct = new Account(
            Name = 'Guard Co ' + System.currentTimeMillis(),
            Credit_Status__c = creditStatus,
            Credit_Limit__c = creditLimit
        );
        insert acct;
        return acct;
    }

    private static Opportunity makeOpp(Id accountId, String stage) {
        return new Opportunity(
            Name = 'Guard deal', AccountId = accountId, StageName = stage,
            CloseDate = Date.today().addDays(30), Amount = 1000
        );
    }

    private static Opportunity makeWon(Id accountId) {
        Opportunity opp = makeOpp(accountId, 'Closed Won');
        opp.PO_Number__c = 'PO-123456';
        opp.Payment_Terms__c = 'Net 30';
        return opp;
    }

    private static void assertRejected(Database.SaveResult result, String code) {
        Assert.isFalse(result.isSuccess(), 'Expected ' + code + ' to reject the save');
        Database.Error error = result.getErrors()[0];
        Assert.areEqual(StatusCode.FIELD_CUSTOM_VALIDATION_EXCEPTION, error.getStatusCode());
        Assert.isTrue(error.getMessage().startsWith(code), 'Got: ' + error.getMessage());
    }

    @IsTest
    static void lostDealNeedsAReason() {
        Opportunity opp = makeOpp(null, 'Closed Lost');
        assertRejected(Database.insert(opp, false), 'OPP001');
        opp.Loss_Reason__c = 'Price';
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void wonDealNeedsAPoNumber() {
        Opportunity opp = makeWon(null);
        opp.PO_Number__c = null;
        assertRejected(Database.insert(opp, false), 'OPP002');
    }

    @IsTest
    static void poNumberMustMatchTheWholeFormat() {
        for (String bad : new List<String>{ 'PO-12345', 'PO-1234567', 'po-123456', 'X PO-123456' }) {
            Opportunity opp = makeWon(null);
            opp.PO_Number__c = bad;
            assertRejected(Database.insert(opp, false), 'OPP003');
        }
        Assert.isTrue(Database.insert(makeWon(null), false).isSuccess());
    }

    @IsTest
    static void wonAmountIsLockedAndTheDealCannotReopen() {
        Opportunity opp = makeWon(null);
        insert opp;

        opp.Amount = 2000;
        assertRejected(Database.update(opp, false), 'OPP004');

        opp.Amount = 1000;
        opp.StageName = 'Prospecting';
        assertRejected(Database.update(opp, false), 'OPP005');
    }

    @IsTest
    static void editingOtherFieldsOfAWonDealStillWorks() {
        Opportunity opp = makeWon(null);
        insert opp;
        opp.Description = 'Shipped to the Reno warehouse';
        Assert.isTrue(Database.update(opp, false).isSuccess());
    }

    @IsTest
    static void creditHoldBlocksTheWin() {
        Account held = makeAccount('Hold', null);
        assertRejected(Database.insert(makeWon(held.Id), false), 'OPP006');

        held.Credit_Status__c = 'Good';
        update held;
        Assert.isTrue(Database.insert(makeWon(held.Id), false).isSuccess());
    }

    @IsTest
    static void creditLimitBlocksTheWinUnlessPrepaid() {
        Account acct = makeAccount('Good', 500);
        Opportunity opp = makeWon(acct.Id);                    // amount 1000 > limit 500
        assertRejected(Database.insert(opp, false), 'OPP007');

        opp.Payment_Terms__c = 'Prepaid';
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void discountAboveTheMetadataLimitNeedsApproval() {
        Decimal limitValue = Order_Guard_Setting__mdt.getInstance('Default').Max_Discount_Percent__c;
        Opportunity opp = makeOpp(null, 'Prospecting');
        opp.Discount_Percent__c = limitValue + 5;
        assertRejected(Database.insert(opp, false), 'OPP008');

        opp.Discount_Approved__c = true;
        Assert.isTrue(Database.insert(opp, false).isSuccess());
    }

    @IsTest
    static void aBadRecordInABulkLoadDoesNotStopTheGoodOnes() {
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            Opportunity opp = makeOpp(null, 'Closed Lost');
            opp.Loss_Reason__c = Math.mod(i, 10) == 0 ? null : 'Timing';   // 20 bad rows
            opps.add(opp);
        }
        List<Database.SaveResult> results = Database.insert(opps, false);

        Integer failures = 0;
        for (Database.SaveResult result : results) {
            if (!result.isSuccess()) {
                failures++;
            }
        }
        Assert.areEqual(20, failures);
        Assert.areEqual(180, [SELECT COUNT() FROM Opportunity WHERE Loss_Reason__c = 'Timing']);
    }
}
```

**`force-app/main/default/classes/WonDealGuardTest.cls`**

```apex
@IsTest
private class WonDealGuardTest {
    private static Opportunity makeWon(Id accountId) {
        return new Opportunity(
            Name = 'Won deal', AccountId = accountId, StageName = 'Closed Won',
            CloseDate = Date.today().addDays(5), Amount = 1000,
            PO_Number__c = 'PO-123456', Payment_Terms__c = 'Net 30'
        );
    }

    private static Account makeAccountWithCase(String priority, String status) {
        Account acct = new Account(Name = 'Case Co ' + System.currentTimeMillis());
        insert acct;
        insert new Case(AccountId = acct.Id, Priority = priority, Status = status, Subject = 'Line down');
        return acct;
    }

    // Setup objects (User, PermissionSetAssignment) go in their own context
    // to avoid a mixed DML error.
    private static User bypassUser() {
        Profile standard = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Order_Guard_Bypass' LIMIT 1];
        User u = new User(
            Alias = 'bypass', Email = 'bypass.guard@example.com', LastName = 'Bypass',
            Username = 'bypass.' + System.currentTimeMillis() + '@example.com',
            ProfileId = standard.Id, TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'
        );
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert u;
            insert new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id);
        }
        return u;
    }

    @IsTest
    static void anOpenHighPriorityCaseBlocksTheWin() {
        Account acct = makeAccountWithCase('High', 'New');
        Database.SaveResult result = Database.insert(makeWon(acct.Id), false);
        Assert.isFalse(result.isSuccess());
        Assert.isTrue(result.getErrors()[0].getMessage().startsWith('OPP009'));
    }

    @IsTest
    static void aClosedOrLowPriorityCaseDoesNotBlock() {
        Account closedCase = makeAccountWithCase('High', 'Closed');
        Account lowCase = makeAccountWithCase('Low', 'New');
        Assert.isTrue(Database.insert(makeWon(closedCase.Id), false).isSuccess());
        Assert.isTrue(Database.insert(makeWon(lowCase.Id), false).isSuccess());
    }

    @IsTest
    static void otherStagesAreNeverChecked() {
        Account acct = makeAccountWithCase('High', 'New');
        Opportunity open = new Opportunity(
            Name = 'Open deal', AccountId = acct.Id, StageName = 'Prospecting',
            CloseDate = Date.today().addDays(30)
        );
        Assert.isTrue(Database.insert(open, false).isSuccess());
    }

    @IsTest
    static void twoHundredDealsCostOneQuery() {
        Account acct = makeAccountWithCase('High', 'New');
        List<Opportunity> opps = new List<Opportunity>();
        for (Integer i = 0; i < 200; i++) {
            opps.add(makeWon(acct.Id));
        }

        Test.startTest();
        List<Database.SaveResult> results = Database.insert(opps, false);
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Integer failures = 0;
        for (Database.SaveResult result : results) {
            if (!result.isSuccess()) {
                failures++;
            }
        }
        Assert.areEqual(200, failures);
        Assert.isTrue(queries <= 1, 'Queries used: ' + queries);
    }

    @IsTest
    static void theOrgSwitchTurnsTheApexGuardOff() {
        Account acct = makeAccountWithCase('High', 'New');
        OrderGuardBypass.enforcedOverride = false;
        Assert.isTrue(Database.insert(makeWon(acct.Id), false).isSuccess());

        OrderGuardBypass.enforcedOverride = true;
        Assert.isFalse(Database.insert(makeWon(acct.Id), false).isSuccess());
    }

    @IsTest
    static void theDeployedMetadataRecordMeansEnforced() {
        Assert.isTrue(OrderGuardBypass.isEnforced());
    }

    @IsTest
    static void thePermissionSetSkipsBothLayers() {
        Account acct = makeAccountWithCase('High', 'New');
        User loader = bypassUser();

        System.runAs(loader) {
            Assert.isTrue(OrderGuardBypass.userMayBypass());

            // Apex layer (open case) and validation rule layer (no PO, bad format).
            Opportunity opp = makeWon(acct.Id);
            opp.PO_Number__c = 'legacy-77';
            Assert.isTrue(Database.insert(opp, false).isSuccess());

            // A lost deal without a reason is also accepted for this user.
            Opportunity lost = new Opportunity(
                Name = 'Legacy lost', StageName = 'Closed Lost', CloseDate = Date.today()
            );
            Assert.isTrue(Database.insert(lost, false).isSuccess());
        }
    }

    @IsTest
    static void anOrdinaryUserIsNotBypassed() {
        Assert.isFalse(OrderGuardBypass.userMayBypass());
    }
}
```

### Data loading: the safe way

Validation rules apply to Data Loader, the Bulk API and the Data Import Wizard exactly as they apply to the UI. Do not deactivate rules before a load, because a deployment is slow, it also changes the rules for every live user, and people forget to turn them back on. Give the loader user the bypass permission set for the length of the load instead.

**`data/legacy-opps.csv`**

```csv
Name,StageName,CloseDate,Amount,PO_Number__c,Loss_Reason__c
Legacy lost 1,Closed Lost,2025-03-01,1200,,
Legacy won 1,Closed Won,2025-04-15,5400,4411-A,
Legacy lost 2,Closed Lost,2025-05-20,800,,Price
```

**`scripts/apex/remove-bypass.apex`**

```apex
// Anonymous Apex
// Removes the bypass permission set from the loader user after the load.
String loaderUsername = 'loader@larkspur.example.com';
List<PermissionSetAssignment> assignments = [
    SELECT Id FROM PermissionSetAssignment
    WHERE Assignee.Username = :loaderUsername AND PermissionSet.Name = 'Order_Guard_Bypass'
];
delete assignments;
System.debug('Removed ' + assignments.size() + ' bypass assignment(s)');
```

```bash
# 1. Deploy everything (copy the files above into the project first).
sf project deploy start --source-dir force-app --target-org larkspur

# 2. Prove the rules work: this load should reject the lost deals without a reason
#    and the PO number that does not match the format.
sf data import bulk --sobject Opportunity --file data/legacy-opps.csv --wait 10 \
  --target-org larkspur

# 3. Give the loader the bypass for the migration only, load, then remove it.
sf org assign permset --name Order_Guard_Bypass \
  --on-behalf-of loader@larkspur.example.com --target-org larkspur
# ...run the load as the loader user (Data Loader, or the CLI logged in as that user)...
sf apex run --file scripts/apex/remove-bypass.apex --target-org larkspur

# 4. Run both test classes.
sf apex run test --class-names ValidationRulesTest --class-names WonDealGuardTest \
  --code-coverage --result-format human --wait 10 --target-org larkspur
```

Every class and trigger needs a `-meta.xml` file that holds an API version. `sf apex generate class` and `sf apex generate trigger` create them with your project's current API version. Use your org's current API version, and check `sf data import bulk --help` for the options in your CLI version.

## What happens behind the scenes

Take a rep who changes a deal from Negotiation to Closed Won in the UI. The account has Credit Status Hold and an open high-priority case.

1. **Request.** The UI sends the new `StageName`. The platform loads the original record and overlays the incoming values.
2. **Before-save flows**, if you have any, run first.
3. **Before trigger.** `OpportunityTrigger` runs `WonDealGuard.beforeSave`. `shouldRun()` reads the cached Custom Metadata record and calls `FeatureManagement.checkPermission`. Neither costs a query. The deal is becoming won, so there is **one** aggregate query against Case, and `addError` marks the record with `OPP009`.
4. **Validation rules.** The platform then evaluates the active Opportunity rules. For each one it resolves `$CustomMetadata` and `$Permission`, and follows the lookup to read `Account.Credit_Status__c`. OPP006 is true, so its message is reported on the Stage field. The cross-object read is done by the platform and does not use your Apex queries.
5. **Result.** The save is rejected and nothing is written. In the UI the user sees both messages next to the Stage field. Through the API the response carries `FIELD_CUSTOM_VALIDATION_EXCEPTION` with the message text.
6. **Bulk or partial.** A Bulk API job with 10,000 rows runs in batches of 200. A rejected row is reported in the failed-results file with its rule message, and the others are saved. Your Apex runs once per batch, so it must stay at one query per batch.

For limits, use the synchronous numbers from the governor limits page: this transaction used 1 of 100 SOQL queries and 0 DML statements for the guard. The limit to watch is the Case query. It returns one row per account at most, far below the 50,000 row limit. The risk in this design is not volume. It is a rule that reads a field the rule's author cannot see, which is why the lookup runs in system mode.

In the debug log (with the Validation category on) you will see lines like these:

```text
CODE_UNIT_STARTED|[EXTERNAL]|01q...|OpportunityTrigger on Opportunity trigger event BeforeUpdate
SOQL_EXECUTE_BEGIN|[18]|Aggregations:1|FROM Case WHERE AccountId IN :accountIds ...
SOQL_EXECUTE_END|[18]|Rows:1
VALIDATION_RULE|03d...|OPP006_Credit_Hold
VALIDATION_FORMULA|formula=AND( ... )|$Permission.Bypass_Order_Guards=false
VALIDATION_FAIL
```

Search for `VALIDATION_FAIL` to find the rule that blocked a save, and for `VALIDATION_PASS` to see a rule that ran and did not fire.

## Test it and verify

1. Run the tests: `sf apex run test --class-names ValidationRulesTest --class-names WonDealGuardTest --code-coverage --result-format human --wait 10`. Expect 17 passing tests. A failure on a picklist value means setup step 7 does not match your org.
2. Open an Opportunity and set Stage to Closed Lost with no loss reason. The error `OPP001` appears under Loss Reason. Choose Price and save.
3. Set Stage to Closed Won with no PO number. `OPP002` appears. Enter `PO 1234`. `OPP003` appears. Enter `PO-104522` and save.
4. Edit the Amount of that won deal. `OPP004` appears. Edit the Description instead. It saves.
5. Set the Account credit status to Hold, then close another deal as won. `OPP006` appears. Set the credit status back to Good, open a High priority Case on the Account, and close another deal as won. Now `OPP009` appears.
6. Set a discount above 15 percent. `OPP008` appears. Tick Discount Approved and save.
7. Org switch: Setup, Custom Metadata Types, Order Guard Setting, Manage Records, Default, Edit, untick Is Enforced, save. All nine checks stop. Tick it again afterwards.
8. Person switch: assign `Order Guard Bypass` to your loader user, run the CSV load as that user, and confirm every row loads. Remove the assignment with `scripts/apex/remove-bypass.apex`.

## Common mistakes and fixes

- **Symptom: users cannot edit any old won deal.** Cause: a rule without `ISNEW()` or `ISCHANGED()` judges every save, so existing records that break the rule block unrelated edits. Fix: wrap the condition in `OR(ISNEW(), ISCHANGED(field))`, as every rule above does.
- **Symptom: the formula editor says picklist fields are only supported in certain functions.** Cause: `ISBLANK`, `=` or `LEN` used on a picklist. Fix: `ISPICKVAL(field, "")` for a blank check, `ISPICKVAL(field, "Value")` for a value, or `TEXT(field)` inside other functions.
- **Symptom: `REGEX` never matches although the text looks right.** Cause: the match must cover the whole value and is case sensitive, and a hidden space or lowercase letter breaks it. Fix: test the exact string, and trim values in the loader or a before trigger.
- **Symptom: the nightly integration starts failing the day a rule is activated.** Cause: rules apply to API saves too. Fix: assign the bypass permission set to the integration user before activating, and rehearse the load in a sandbox first.
- **Symptom: someone deactivated rules for a load and nobody turned them back on.** Cause: deactivation is org-wide and manual. Fix: use the custom permission for the person and the Custom Metadata switch for the whole org, and review who holds the permission set.
- **Symptom: a cross-object rule did not fire after the Account changed.** Cause: a rule on Opportunity is evaluated only when the Opportunity is saved. Changing the Account's credit status does not re-check its deals. Fix: accept that, or add automation that touches the related deals, and say so in the rule description.
- **Symptom: the error appears at the top of the page and users cannot tell which field is wrong.** Cause: no error location, or a rule that checks several things at once. Fix: one scenario per rule with an error location on the field to change.
- **Symptom: a validation rule blocks a Flow or a roll-up that the user did not start.** Cause: rules fire when automation saves the record. Fix: use the error code to find the rule, and let the automation's user hold the bypass permission if the rule is not meant for it.
- **Symptom: a test passes in a scratch org and fails in a sandbox.** Cause: the test depends on org data, such as a stage or a Custom Metadata value that differs. Fix: read the metadata value in the test, as `discountAboveTheMetadataLimitNeedsApproval` does, and keep test data self-contained.

## Key takeaways

- A validation rule returns true when the record is wrong. Write the condition as "what is wrong?" and keep one scenario per rule.
- Use `ISNEW()` and `ISCHANGED()` so a rule judges only new records and relevant changes, never every legacy save.
- Build two bypass switches in front of every rule: a custom permission for people and a Custom Metadata flag for the whole org. Do not deactivate rules for a load.
- Use Apex `addError` for what a formula cannot see, such as child records, and read the same two switches there so one bypass covers both layers.
- Test both layers with real saves: a rejected save, an accepted save, a bulk load with a few bad rows, and a bypass user.

## Where to go next

- [Permission sets vs profiles](/articles/permission-sets-vs-profiles/)
- [Apex triggers from scratch](/articles/apex-triggers-from-scratch/)
- [Custom metadata, settings and labels](/articles/custom-metadata-settings-and-labels/)
- [Data import, export and duplicate management](/articles/data-import-export-and-duplicate-management/)
- [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/)
- [Flow vs Apex](/articles/flow-vs-apex/)
- [Apex test classes: best practices](/articles/apex-test-classes-best-practices/)
