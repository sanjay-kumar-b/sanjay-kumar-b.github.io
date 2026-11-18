---
title: "Permission Sets vs Profiles: A Practical Way to Grant Access"
description: "Compare profiles and permission sets with a regulated onboarding org: groups, muting, custom permissions, Apex checks, tests and CLI deploys."
category: salesforce-administration
tags: [Permission Sets, Security, Custom Permissions, Apex]
publishedAt: 2026-11-01
updatedAt: 2026-11-13
cover: /images/covers/permission-sets-vs-profiles.jpg
sources:
  - title: "Salesforce Security Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/"
  - title: "FeatureManagement Class (Apex Reference Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.262.0.apexref.meta/apexref/apex_class_System_FeatureManagement.htm"
  - title: "Permission Set Groups in Apex tests (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/api/apex_permission_set_group_testing.htm"
  - title: "Assign a Permission Set (Salesforce DX Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.sfdx_dev.meta/sfdx_dev/sfdx_dev_assign_permset.htm"
  - title: "Triggers and Order of Execution (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_order_of_execution.htm"
  - title: "Salesforce Ben: Salesforce backtracks on permission retirement in profiles (third-party report)"
    url: "https://www.salesforceben.com/salesforce-backtracks-on-permission-retirement-in-profiles/"
---

Every Salesforce user has exactly one **profile** and any number of **permission sets**. A profile is the baseline: it is assigned to a user for life, and it carries settings such as login hours and IP ranges. A permission set is an add-on bundle of access. Permission sets only add access; they never take it away. Because they are additive, small and named, they are the unit you can review, test and deploy.

This article compares the two with one scenario, then builds the permission-set side in full: object and field metadata, permission sets, a permission set group with a muting set, a custom permission that Apex and a validation rule both check, tests with `System.runAs`, and the CLI to deploy and assign it.

A note on direction. Salesforce had announced that permissions on profiles would be retired in Spring '26. Third-party reporting (linked in the sources) says that enforcement date was dropped and no new date was set, and that Salesforce still recommends a permission-set-led model. Check the current Salesforce Help and release notes for your org. The design in this article works either way: a lean profile for the baseline, permission sets for everything else.

## The business scenario

Harbor Ridge Capital (a fictional wealth-management firm) onboards new clients through a custom object called **Onboarding Case**. Three groups of people touch a case:

- **Intake agents** create and edit cases. They must never see the client's source-of-funds text, which is sensitive.
- **KYC analysts** (know-your-customer reviewers) read the source of funds and set the risk rating.
- **Approvers** move a case to Approved. Approving a **High** risk case needs a second, stronger permission held by compliance managers.

Auditors ask two questions every quarter: who can see source-of-funds data, and who can approve high-risk clients? The answer must come from a short list of named permission sets, not from a dozen profile clones. The same rule must hold in the UI, in Apex and in the API.

| Job | Intake | KYC review | Approve | Approve high risk |
|---|---|---|---|---|
| Intake agent | yes | no | no | no |
| Onboarding officer | yes | yes | no | no |
| Standard approver | yes | yes | yes | no |
| Compliance manager | yes | yes | yes | yes |

With profiles, each row is a profile, and every new combination is another clone. With permission sets, each column is a set, and a row is a combination of them.

## Before you start: setup

This article needs no external system; everything runs inside Salesforce. Setup menu labels can differ slightly by release, so use Quick Find in Setup if a path has moved (see the Salesforce Help pages for your release).

### In Salesforce

1. **Get a safe org.** Use a scratch org (needs Dev Hub enabled: Setup, Dev Hub) or a Developer Edition or sandbox org. Why: you will deploy objects and assign access. Verify: `sf org list` shows the org.
2. **Confirm you can manage access.** Your user needs the permissions to assign permission sets and manage users (a System Administrator has them). Why: the CLI docs state that the target username must have permission to assign a permission set. Verify: Setup, Users, Permission Sets lists sets and lets you open Manage Assignments.
3. **Check the baseline profile.** Setup, Profiles, look for **Minimum Access - Salesforce**. Why: new users will get this lean profile, and all access will come from permission sets. If it is missing, the tests below fall back to Standard User. Verify: the profile opens.
4. **Deploy the object, fields and custom permissions** from the metadata files below. Why: the permission sets refer to them, and a deploy fails if a referenced field is missing. Verify: Setup, Object Manager shows Onboarding Case with four fields; Setup, Custom Permissions shows two entries.
5. **Deploy the permission sets, the muting set and the groups.** Verify: Setup, Permission Set Groups, each group shows status **Updated**. A group is recalculated after changes, and an **Outdated** group cannot be assigned until it finishes.
6. **Create three test users** (officer, approver, manager) and assign them as shown in the CLI section. Verify: Setup, Users, open a user, Permission Set Assignments (and Permission Set Group Assignments) lists the right entries.
7. **Decide record access separately.** Permissions decide which objects and fields a user can use. Sharing decides which records. To keep this article about permissions, the object uses the Public Read/Write default; in production tighten it as described in [Sharing model explained](/articles/sharing-model-explained/).

### On your machine

1. Install the Salesforce CLI (`sf`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version`.
2. Authorize your Dev Hub: `sf org login web --set-default-dev-hub --alias devhub`. Verify: `sf org list` shows it.

## How it works

### What a user can do is a union

The platform combines everything assigned to a user. In plain terms:

```text
effective access = profile
                 + every directly assigned permission set
                 + every permission set inside an assigned permission set group
                 - permissions muted by the group's muting permission set
```

A **permission set group** (PSG) bundles permission sets so one assignment grants the whole job. A **muting permission set** sits inside a group and switches off chosen permissions, for users of that group only. The underlying permission sets stay untouched, so the same set can be strong in one group and weaker in another. A **custom permission** is a named yes/no flag you define. You grant it through a permission set, and code or formulas ask whether the current user has it. This is how you express "may approve" without checking a profile name.

Two layers are easy to confuse. **Object permissions** (create, read, edit, delete) and **field-level security** (FLS: read or edit per field) say what a user may do with an object or field. **Record access** (ownership, sharing) says which rows. All permissions are additive, so a single permission set that grants a permission wins over many that do not.

### Where each setting lives

| Setting | Profile | Permission set |
|---|---|---|
| Object and field access | yes | yes |
| Custom permissions, Apex class access | yes | yes |
| Login hours and login IP ranges | yes | no |
| Page layout assignment, default app and default record type | yes | no |

The last two rows are why profiles still exist. Salesforce Help lists exactly what each supports in your release, so confirm there before you move a setting.

### Profile approach versus permission-set approach

| Question | One profile per variation | Small sets plus groups |
|---|---|---|
| New job that mixes two existing jobs | Clone a profile, edit both copies later | Create a group of two sets |
| Remove an ability from one person | Move them to another profile | Unassign one set |
| Audit "who can approve high risk" | Inspect every profile | Query one custom permission |
| Deploy a change | Profile XML merges are fragile | One small file per set |

### How code asks

Apex calls `FeatureManagement.checkPermission('Approve_Onboarding')`, which returns `true` when the running user has that custom permission. Formulas use `$Permission.Approve_Onboarding`. An LWC can import `@salesforce/customPermission/Approve_Onboarding`. All three read the same flag, so one permission set controls the UI, the server and the data layer.

## Basic example

The smallest useful setup: one custom permission, one permission set that grants it, and a check in Apex.

**`force-app/main/default/customPermissions/Approve_Onboarding.customPermission-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>May move an onboarding case to Approved.</description>
    <isLicensed>false</isLicensed>
    <label>Approve Onboarding</label>
</CustomPermission>
```

**`force-app/main/default/permissionsets/PS_Demo_Approve.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <customPermissions>
        <enabled>true</enabled>
        <name>Approve_Onboarding</name>
    </customPermissions>
    <description>Demo set: grants only the Approve Onboarding flag.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Demo Approve</label>
</PermissionSet>
```

Deploy, assign to yourself and check:

```bash
sf project deploy start --source-dir force-app --target-org harborridge
sf org assign permset --name PS_Demo_Approve --target-org harborridge
```

```apex
// Anonymous Apex
System.debug('Can approve: ' + FeatureManagement.checkPermission('Approve_Onboarding'));
```

Expected result: `Can approve: true`. Unassign the set in Setup, run it again and the output is `false`.

Now the first lesson. Here is a **bad** version that checks who the user is instead of what they may do:

```apex
public with sharing class BadApprovalCheck {
    // BAD: ties security to a profile name. Renaming the profile, cloning it
    // or adding a second approver profile silently breaks or opens access.
    public static Boolean canApprove() {
        Profile p = [SELECT Name FROM Profile WHERE Id = :UserInfo.getProfileId()];
        return p.Name == 'System Administrator' || p.Name == 'Approver Profile';
    }
}
```

The **fixed** version asks about the capability. It is one line, uses no SOQL and works with any assignment route (profile, set or group):

```apex
public with sharing class GoodApprovalCheck {
    // GOOD: ask for the capability, not the job title.
    public static Boolean canApprove() {
        return FeatureManagement.checkPermission('Approve_Onboarding');
    }
}
```

## Advanced end-to-end example

The files below build the full Harbor Ridge design. Design rule: **permission sets grant, code and formulas check the custom permission, and the server never trusts the UI.**

### The profile approach, for comparison

This is what the same four jobs look like as profiles. It deploys, but you would need one file per row of the table above, and each file repeats the same permission blocks.

**`force-app/main/default/profiles/Onboarding_Officer.profile-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <custom>true</custom>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Status__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Risk_Rating__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Onboarding_Case__c.Source_Of_Funds__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Onboarding_Case__c</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <userLicense>Salesforce</userLicense>
</Profile>
```

The permission-set version splits that into reusable pieces. Everything from here on is that version.

### Object, fields and custom permissions

**`force-app/main/default/objects/Onboarding_Case__c/Onboarding_Case__c.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Onboarding Case</label>
    <pluralLabel>Onboarding Cases</pluralLabel>
    <nameField>
        <displayFormat>ONB-{00000}</displayFormat>
        <label>Case Number</label>
        <type>AutoNumber</type>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
    <enableHistory>true</enableHistory>
    <enableReports>true</enableReports>
    <enableSearch>true</enableSearch>
    <enableBulkApi>true</enableBulkApi>
    <enableSharing>true</enableSharing>
    <enableStreamingApi>true</enableStreamingApi>
</CustomObject>
```

**`force-app/main/default/objects/Onboarding_Case__c/fields/Status__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <required>false</required>
    <trackHistory>true</trackHistory>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Draft</fullName><default>true</default><label>Draft</label></value>
            <value><fullName>In Review</fullName><default>false</default><label>In Review</label></value>
            <value><fullName>Approved</fullName><default>false</default><label>Approved</label></value>
            <value><fullName>Rejected</fullName><default>false</default><label>Rejected</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Onboarding_Case__c/fields/Risk_Rating__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Risk_Rating__c</fullName>
    <label>Risk Rating</label>
    <type>Picklist</type>
    <required>false</required>
    <trackHistory>true</trackHistory>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Low</fullName><default>true</default><label>Low</label></value>
            <value><fullName>Medium</fullName><default>false</default><label>Medium</label></value>
            <value><fullName>High</fullName><default>false</default><label>High</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Onboarding_Case__c/fields/Source_Of_Funds__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Source_Of_Funds__c</fullName>
    <label>Source Of Funds</label>
    <type>Text</type>
    <length>255</length>
    <required>false</required>
    <trackHistory>false</trackHistory>
    <inlineHelpText>Sensitive. Visible to KYC review only.</inlineHelpText>
</CustomField>
```

**`force-app/main/default/objects/Onboarding_Case__c/fields/Approved_Limit__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Approved_Limit__c</fullName>
    <label>Approved Limit</label>
    <type>Currency</type>
    <precision>18</precision>
    <scale>2</scale>
    <required>false</required>
    <trackHistory>true</trackHistory>
</CustomField>
```

**`force-app/main/default/customPermissions/Approve_High_Risk_Onboarding.customPermission-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomPermission xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>May approve onboarding cases rated High risk.</description>
    <isLicensed>false</isLicensed>
    <label>Approve High Risk Onboarding</label>
</CustomPermission>
```

The `Approve_Onboarding` custom permission is the file from the basic example.

### Last line of defense: a validation rule

Field-level security lets intake agents edit `Status__c` (they must, to move a case to In Review). Without a guard, an agent could also set it to Approved from a list view or the API. A validation rule that reads the custom permission closes that gap for every entry point.

**`force-app/main/default/objects/Onboarding_Case__c/validationRules/Approval_Requires_Permission.validationRule-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ValidationRule xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Approval_Requires_Permission</fullName>
    <active>true</active>
    <description>Only holders of the approval custom permissions may set Approved.</description>
    <errorConditionFormula>AND(
  OR(ISNEW(), ISCHANGED(Status__c)),
  ISPICKVAL(Status__c, "Approved"),
  OR(
    NOT($Permission.Approve_Onboarding),
    AND(
      ISPICKVAL(Risk_Rating__c, "High"),
      NOT($Permission.Approve_High_Risk_Onboarding)
    )
  )
)</errorConditionFormula>
    <errorDisplayField>Status__c</errorDisplayField>
    <errorMessage>You do not have the permission to approve this case. High risk cases need a compliance manager.</errorMessage>
</ValidationRule>
```

### Permission sets

**`force-app/main/default/permissionsets/PS_Onboarding_Intake.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <classAccesses>
        <apexClass>OnboardingController</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <description>Create and edit onboarding cases. No access to source-of-funds data.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Status__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Onboarding_Case__c.Risk_Rating__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Onboarding Intake</label>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Onboarding_Case__c</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>
```

**`force-app/main/default/permissionsets/PS_KYC_Review.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Read and edit source of funds, set the risk rating. Read the limit.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Risk_Rating__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Source_Of_Funds__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Onboarding_Case__c.Approved_Limit__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>KYC Review</label>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Onboarding_Case__c</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>
```

**`force-app/main/default/permissionsets/PS_Onboarding_Approver.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <customPermissions>
        <enabled>true</enabled>
        <name>Approve_Onboarding</name>
    </customPermissions>
    <description>May approve standard-risk cases and set the approved limit.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Approved_Limit__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <hasActivationRequired>false</hasActivationRequired>
    <label>Onboarding Approver</label>
</PermissionSet>
```

**`force-app/main/default/permissionsets/PS_High_Risk_Approver.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <customPermissions>
        <enabled>true</enabled>
        <name>Approve_High_Risk_Onboarding</name>
    </customPermissions>
    <description>Adds the flag needed to approve High risk cases. Use with Approver.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <label>High Risk Approver</label>
</PermissionSet>
```

### Muting set and groups

The officers' group reuses `PS_KYC_Review` but must not be able to change the source of funds. Rather than clone the set, mute the edit permission inside their group. In a muting set, a permission set to `true` is the one being switched off. Verify the result in a sandbox before you rely on it.

**`force-app/main/default/mutingpermissionsets/MPS_Officer_Funds_Read_Only.mutingpermissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<MutingPermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Officers can read source of funds but not change it.</description>
    <fieldPermissions>
        <editable>true</editable>
        <field>Onboarding_Case__c.Source_Of_Funds__c</field>
        <readable>false</readable>
    </fieldPermissions>
    <label>Officer Funds Read Only</label>
</MutingPermissionSet>
```

**`force-app/main/default/permissionsetgroups/PSG_Onboarding_Officer.permissionsetgroup-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSetGroup xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Intake plus KYC review, with source of funds read-only.</description>
    <label>Onboarding Officer</label>
    <mutingPermissionSets>MPS_Officer_Funds_Read_Only</mutingPermissionSets>
    <permissionSets>PS_Onboarding_Intake</permissionSets>
    <permissionSets>PS_KYC_Review</permissionSets>
    <status>Updated</status>
</PermissionSetGroup>
```

**`force-app/main/default/permissionsetgroups/PSG_Compliance_Manager.permissionsetgroup-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSetGroup xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Everything an officer has, plus both approval permissions.</description>
    <label>Compliance Manager</label>
    <permissionSets>PS_Onboarding_Intake</permissionSets>
    <permissionSets>PS_KYC_Review</permissionSets>
    <permissionSets>PS_Onboarding_Approver</permissionSets>
    <permissionSets>PS_High_Risk_Approver</permissionSets>
    <status>Updated</status>
</PermissionSetGroup>
```

### Apex: check the permission on the server

**`force-app/main/default/classes/OnboardingException.cls`**

```apex
public class OnboardingException extends Exception {
}
```

**`force-app/main/default/classes/OnboardingAccess.cls`**

```apex
public with sharing class OnboardingAccess {
    public static final String APPROVE = 'Approve_Onboarding';
    public static final String APPROVE_HIGH_RISK = 'Approve_High_Risk_Onboarding';

    public static Boolean canApprove() {
        return FeatureManagement.checkPermission(APPROVE);
    }

    // High risk needs both flags, matching the validation rule.
    public static Boolean canApproveHighRisk() {
        return canApprove() && FeatureManagement.checkPermission(APPROVE_HIGH_RISK);
    }

    public static void requireApprover() {
        if (!canApprove()) {
            throw new OnboardingException(
                'You need the Approve Onboarding permission to do this.'
            );
        }
    }
}
```

**`force-app/main/default/classes/OnboardingCaseSelector.cls`**

```apex
public with sharing class OnboardingCaseSelector {
    // User mode: object permission, FLS and sharing are all enforced.
    public List<Onboarding_Case__c> byIds(Set<Id> ids) {
        return [
            SELECT Id, Name, Status__c, Risk_Rating__c, Approved_Limit__c
            FROM Onboarding_Case__c
            WHERE Id IN :ids
            WITH USER_MODE
        ];
    }
}
```

**`force-app/main/default/classes/OnboardingApprovalService.cls`**

```apex
public with sharing class OnboardingApprovalService {
    public class Outcome {
        @AuraEnabled public Id caseId;
        @AuraEnabled public Boolean success;
        @AuraEnabled public String message;

        public Outcome(Id caseId, Boolean success, String message) {
            this.caseId = caseId;
            this.success = success;
            this.message = message;
        }
    }

    // One query and one DML statement for any number of cases.
    public static List<Outcome> approve(Set<Id> caseIds) {
        OnboardingAccess.requireApprover();
        if (caseIds == null || caseIds.isEmpty()) {
            throw new OnboardingException('Select at least one case.');
        }

        Boolean highRiskOk = OnboardingAccess.canApproveHighRisk();
        List<Outcome> outcomes = new List<Outcome>();
        List<Onboarding_Case__c> toUpdate = new List<Onboarding_Case__c>();

        for (Onboarding_Case__c c : new OnboardingCaseSelector().byIds(caseIds)) {
            String problem = problemWith(c, highRiskOk);
            if (problem != null) {
                outcomes.add(new Outcome(c.Id, false, problem));
            } else {
                toUpdate.add(new Onboarding_Case__c(Id = c.Id, Status__c = 'Approved'));
            }
        }

        // allOrNone = false: one bad row does not block the rest.
        List<Database.SaveResult> results = Database.update(
            toUpdate, false, AccessLevel.USER_MODE
        );
        for (Integer i = 0; i < results.size(); i++) {
            Database.SaveResult sr = results[i];
            String msg = sr.isSuccess() ? 'Approved' : sr.getErrors()[0].getMessage();
            outcomes.add(new Outcome(toUpdate[i].Id, sr.isSuccess(), msg));
        }
        return outcomes;
    }

    private static String problemWith(Onboarding_Case__c c, Boolean highRiskOk) {
        if (c.Status__c != 'In Review') {
            return 'Only cases In Review can be approved.';
        }
        if (c.Approved_Limit__c == null || c.Approved_Limit__c <= 0) {
            return 'Set an approved limit first.';
        }
        if (c.Risk_Rating__c == 'High' && !highRiskOk) {
            return 'High risk cases need the Approve High Risk Onboarding permission.';
        }
        return null;
    }
}
```

**`force-app/main/default/classes/OnboardingIntakeService.cls`**

```apex
public with sharing class OnboardingIntakeService {
    public class SaveResult {
        @AuraEnabled public Id caseId;
        @AuraEnabled public List<String> removedFields = new List<String>();
    }

    // Saves a draft. Fields the user may not write are removed instead of
    // failing the whole save, and the caller is told which ones were dropped.
    public static SaveResult saveDraft(Onboarding_Case__c draft) {
        Boolean isNew = draft.Id == null;
        SObjectAccessDecision decision = Security.stripInaccessible(
            isNew ? AccessType.CREATABLE : AccessType.UPDATABLE,
            new List<Onboarding_Case__c>{ draft }
        );
        List<SObject> clean = decision.getRecords();
        if (isNew) {
            insert as user clean;
        } else {
            update as user clean;
        }

        SaveResult result = new SaveResult();
        result.caseId = clean[0].Id;
        Set<String> removed = decision.getRemovedFields().get('Onboarding_Case__c');
        if (removed != null) {
            result.removedFields.addAll(removed);
        }
        return result;
    }
}
```

**`force-app/main/default/classes/OnboardingController.cls`**

```apex
public with sharing class OnboardingController {
    @AuraEnabled(cacheable=true)
    public static Boolean canApprove() {
        return OnboardingAccess.canApprove();
    }

    @AuraEnabled
    public static List<OnboardingApprovalService.Outcome> approve(List<Id> caseIds) {
        try {
            return OnboardingApprovalService.approve(new Set<Id>(caseIds));
        } catch (OnboardingException e) {
            AuraHandledException ex = new AuraHandledException(e.getMessage());
            ex.setMessage(e.getMessage());
            throw ex;
        }
    }

    @AuraEnabled
    public static OnboardingIntakeService.SaveResult saveDraft(Onboarding_Case__c draft) {
        return OnboardingIntakeService.saveDraft(draft);
    }
}
```

Each class needs a sibling `.cls-meta.xml`. This is the one for the service; use your org's current API version (68.0 is Winter '27 at the time of writing).

**`force-app/main/default/classes/OnboardingApprovalService.cls-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>68.0</apiVersion>
    <status>Active</status>
</ApexClass>
```

### LWC: show the button only to approvers

Hiding a button is a courtesy, not security. The Apex and the validation rule above are the real gates.

**`force-app/main/default/lwc/onboardingApprovalPanel/onboardingApprovalPanel.html`**

```html
<template>
    <lightning-card title="Approval" icon-name="standard:approval">
        <div class="slds-var-p-around_medium">
            <template lwc:if={hasApprovePermission}>
                <lightning-button
                    variant="brand"
                    label="Approve case"
                    onclick={handleApprove}
                    disabled={busy}
                ></lightning-button>
            </template>
            <template lwc:else>
                <p>Only approvers can approve this case.</p>
            </template>
        </div>
    </lightning-card>
</template>
```

**`force-app/main/default/lwc/onboardingApprovalPanel/onboardingApprovalPanel.js`**

```javascript
import { LightningElement, api } from 'lwc';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { notifyRecordUpdateAvailable } from 'lightning/uiRecordApi';
import hasApprovePermission from '@salesforce/customPermission/Approve_Onboarding';
import approve from '@salesforce/apex/OnboardingController.approve';

export default class OnboardingApprovalPanel extends LightningElement {
    @api recordId;
    busy = false;
    hasApprovePermission = hasApprovePermission;

    async handleApprove() {
        this.busy = true;
        try {
            const outcomes = await approve({ caseIds: [this.recordId] });
            const first = outcomes[0];
            this.toast(first.success ? 'Approved' : 'Not approved', first.message,
                first.success ? 'success' : 'error');
            if (first.success) {
                await notifyRecordUpdateAvailable([{ recordId: this.recordId }]);
            }
        } catch (e) {
            this.toast('Error', e.body ? e.body.message : e.message, 'error');
        } finally {
            this.busy = false;
        }
    }

    toast(title, message, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message, variant }));
    }
}
```

**`force-app/main/default/lwc/onboardingApprovalPanel/onboardingApprovalPanel.js-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<LightningComponentBundle xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>68.0</apiVersion>
    <isExposed>true</isExposed>
    <masterLabel>Onboarding approval panel</masterLabel>
    <targets>
        <target>lightning__RecordPage</target>
    </targets>
    <targetConfigs>
        <targetConfig targets="lightning__RecordPage">
            <objects>
                <object>Onboarding_Case__c</object>
            </objects>
        </targetConfig>
    </targetConfigs>
</LightningComponentBundle>
```

### Test class

Tests run as real users with `System.runAs`. Creating users and permission set assignments in one transaction causes a mixed DML error, so setup runs inside a `runAs` block for the current user.

**`force-app/main/default/classes/OnboardingAccessTest.cls`**

```apex
@IsTest
private class OnboardingAccessTest {
    @TestSetup
    static void setup() {
        Id profileId = [
            SELECT Id FROM Profile
            WHERE Name IN ('Minimum Access - Salesforce', 'Standard User')
            ORDER BY Name LIMIT 1
        ].Id;

        List<User> users = new List<User>();
        for (String alias : new List<String>{ 'intake1', 'officer1', 'approver', 'manager1', 'nobody1' }) {
            users.add(buildUser(alias, profileId));
        }

        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert users;

            // A group must be calculated before it can be assigned.
            for (PermissionSetGroup g : [
                SELECT Id, Status FROM PermissionSetGroup
                WHERE DeveloperName IN ('PSG_Onboarding_Officer', 'PSG_Compliance_Manager')
            ]) {
                if (g.Status != 'Updated') {
                    Test.calculatePermissionSetGroup(g.Id);
                }
            }

            List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
            assignments.addAll(setsFor('intake1', new List<String>{ 'PS_Onboarding_Intake' }));
            assignments.addAll(setsFor('approver', new List<String>{
                'PS_Onboarding_Intake', 'PS_KYC_Review', 'PS_Onboarding_Approver'
            }));
            assignments.add(groupFor('officer1', 'PSG_Onboarding_Officer'));
            assignments.add(groupFor('manager1', 'PSG_Compliance_Manager'));
            insert assignments;
        }

        List<Onboarding_Case__c> cases = new List<Onboarding_Case__c>();
        for (Integer i = 0; i < 200; i++) {
            cases.add(new Onboarding_Case__c(
                Status__c = 'In Review', Risk_Rating__c = 'Low', Approved_Limit__c = 5000
            ));
        }
        cases.add(new Onboarding_Case__c(
            Status__c = 'In Review', Risk_Rating__c = 'High', Approved_Limit__c = 50000
        ));
        insert cases;
    }

    private static User buildUser(String alias, Id profileId) {
        return new User(
            Alias = alias, LastName = alias, ProfileId = profileId,
            Email = alias + '@harborridge.test',
            Username = alias + '.' + UserInfo.getOrganizationId() + '@harborridge.test',
            EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US',
            LocaleSidKey = 'en_US', TimeZoneSidKey = 'America/New_York'
        );
    }

    private static Id userId(String alias) {
        return [SELECT Id FROM User WHERE Alias = :alias LIMIT 1].Id;
    }

    private static List<PermissionSetAssignment> setsFor(String alias, List<String> names) {
        List<PermissionSetAssignment> result = new List<PermissionSetAssignment>();
        for (PermissionSet ps : [SELECT Id FROM PermissionSet WHERE Name IN :names]) {
            result.add(new PermissionSetAssignment(
                AssigneeId = userId(alias), PermissionSetId = ps.Id
            ));
        }
        return result;
    }

    private static PermissionSetAssignment groupFor(String alias, String groupName) {
        Id groupId = [
            SELECT Id FROM PermissionSetGroup WHERE DeveloperName = :groupName
        ].Id;
        return new PermissionSetAssignment(
            AssigneeId = userId(alias), PermissionSetGroupId = groupId
        );
    }

    private static Set<Id> caseIds(String risk, Integer maxRows) {
        return new Map<Id, Onboarding_Case__c>([
            SELECT Id FROM Onboarding_Case__c WHERE Risk_Rating__c = :risk LIMIT :maxRows
        ]).keySet();
    }

    // True when the save throws or comes back with errors.
    private static Boolean saveIsBlocked(Onboarding_Case__c record) {
        try {
            List<Database.SaveResult> r = Database.update(
                new List<Onboarding_Case__c>{ record }, false, AccessLevel.USER_MODE
            );
            return !r[0].isSuccess();
        } catch (Exception e) {
            return true;
        }
    }

    @IsTest
    static void customPermissionFollowsTheAssignment() {
        System.runAs(new User(Id = userId('nobody1'))) {
            Assert.isFalse(OnboardingAccess.canApprove());
        }
        System.runAs(new User(Id = userId('approver'))) {
            Assert.isTrue(OnboardingAccess.canApprove());
            Assert.isFalse(OnboardingAccess.canApproveHighRisk());
        }
        System.runAs(new User(Id = userId('manager1'))) {
            Assert.isTrue(OnboardingAccess.canApproveHighRisk());
        }
    }

    @IsTest
    static void officerCannotApprove() {
        System.runAs(new User(Id = userId('officer1'))) {
            try {
                OnboardingApprovalService.approve(caseIds('Low', 1));
                Assert.fail('Expected an OnboardingException');
            } catch (OnboardingException e) {
                Assert.isTrue(e.getMessage().contains('Approve Onboarding'), e.getMessage());
            }
        }
    }

    @IsTest
    static void standardApproverIsStoppedOnHighRisk() {
        Set<Id> ids = caseIds('Low', 1);
        ids.addAll(caseIds('High', 1));
        List<OnboardingApprovalService.Outcome> outcomes;
        System.runAs(new User(Id = userId('approver'))) {
            outcomes = OnboardingApprovalService.approve(ids);
        }
        Integer ok = 0;
        Integer blocked = 0;
        for (OnboardingApprovalService.Outcome o : outcomes) {
            if (o.success) {
                ok++;
            } else {
                blocked++;
                Assert.isTrue(o.message.contains('High risk'), o.message);
            }
        }
        Assert.areEqual(1, ok);
        Assert.areEqual(1, blocked);
    }

    @IsTest
    static void complianceManagerApprovesTwoHundredAndOneCases() {
        Set<Id> ids = caseIds('Low', 200);
        ids.addAll(caseIds('High', 1));
        List<OnboardingApprovalService.Outcome> outcomes;

        Test.startTest();
        System.runAs(new User(Id = userId('manager1'))) {
            outcomes = OnboardingApprovalService.approve(ids);
        }
        Integer dml = Limits.getDmlStatements();
        Integer queries = Limits.getQueries();
        Test.stopTest();

        Assert.areEqual(201, outcomes.size());
        for (OnboardingApprovalService.Outcome o : outcomes) {
            Assert.isTrue(o.success, o.message);
        }
        Assert.areEqual(201, [SELECT COUNT() FROM Onboarding_Case__c WHERE Status__c = 'Approved']);
        Assert.isTrue(dml <= 1, 'DML statements: ' + dml);
        Assert.isTrue(queries < 10, 'Queries do not grow with the batch: ' + queries);
    }

    @IsTest
    static void validationRuleBlocksADirectStatusEditByAnOfficer() {
        Id oneCase = new List<Id>(caseIds('Low', 1))[0];
        System.runAs(new User(Id = userId('officer1'))) {
            Assert.isTrue(saveIsBlocked(new Onboarding_Case__c(Id = oneCase, Status__c = 'Approved')));
        }
    }

    @IsTest
    static void mutingKeepsSourceOfFundsReadOnlyForOfficers() {
        Id oneCase = new List<Id>(caseIds('Low', 1))[0];
        System.runAs(new User(Id = userId('officer1'))) {
            Assert.isTrue(saveIsBlocked(new Onboarding_Case__c(Id = oneCase, Source_Of_Funds__c = 'Salary')));
            // Reading is still allowed: this query would throw otherwise.
            Database.query('SELECT Source_Of_Funds__c FROM Onboarding_Case__c LIMIT 1', AccessLevel.USER_MODE);
        }
    }

    @IsTest
    static void intakeAgentCannotQuerySourceOfFunds() {
        System.runAs(new User(Id = userId('intake1'))) {
            try {
                Database.query('SELECT Source_Of_Funds__c FROM Onboarding_Case__c', AccessLevel.USER_MODE);
                Assert.fail('Expected a QueryException');
            } catch (QueryException e) {
                Assert.isTrue(e.getMessage().contains('Source_Of_Funds__c'), e.getMessage());
            }
        }
    }

    @IsTest
    static void saveDraftDropsFieldsTheUserCannotWrite() {
        OnboardingIntakeService.SaveResult result;
        System.runAs(new User(Id = userId('intake1'))) {
            result = OnboardingIntakeService.saveDraft(
                new Onboarding_Case__c(Source_Of_Funds__c = 'Inheritance')
            );
        }
        Assert.isNotNull(result.caseId);
        Assert.isTrue(result.removedFields.contains('Source_Of_Funds__c'));
        Assert.isNull([SELECT Source_Of_Funds__c FROM Onboarding_Case__c WHERE Id = :result.caseId].Source_Of_Funds__c);
    }
}
```

### Deploy, assign and audit

**`scripts/apex/assign-psgs.apex`**

```apex
// Anonymous Apex
// Assigns each permission set group to a test user. Groups cannot be assigned
// while they are Outdated, so the script checks the status first.
Map<String, String> groupByUser = new Map<String, String>{
    'officer1@harborridge.test%' => 'PSG_Onboarding_Officer',
    'manager1@harborridge.test%' => 'PSG_Compliance_Manager'
};
List<PermissionSetAssignment> toInsert = new List<PermissionSetAssignment>();
for (String pattern : groupByUser.keySet()) {
    PermissionSetGroup g = [
        SELECT Id, Status FROM PermissionSetGroup
        WHERE DeveloperName = :groupByUser.get(pattern)
    ];
    if (g.Status != 'Updated') {
        System.debug(LoggingLevel.WARN, 'Group not ready: ' + g.Status);
        continue;
    }
    User u = [SELECT Id FROM User WHERE Username LIKE :pattern LIMIT 1];
    toInsert.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetGroupId = g.Id));
}
insert toInsert;
System.debug('Assigned ' + toInsert.size() + ' groups');
```

```bash
# 1. Scratch org and deploy
sf org create scratch --definition-file config/project-scratch-def.json \
  --alias harborridge --set-default --duration-days 7 --target-dev-hub devhub
sf project deploy start --source-dir force-app --target-org harborridge

# 2. Test users (scratch orgs only). Add permission sets with permsets=.
sf org create user --set-alias officer1 --set-unique-username --target-org harborridge \
  username=officer1@harborridge.test profileName='Minimum Access - Salesforce'
sf org create user --set-alias manager1 --set-unique-username --target-org harborridge \
  username=manager1@harborridge.test profileName='Minimum Access - Salesforce'

# 3. Permission sets by CLI, groups by script
sf org assign permset --name PS_Onboarding_Intake --name PS_KYC_Review \
  --on-behalf-of officer1 --target-org harborridge
sf apex run --file scripts/apex/assign-psgs.apex --target-org harborridge

# 4. Tests
sf apex run test --class-names OnboardingAccessTest --code-coverage \
  --result-format human --wait 10 --target-org harborridge
```

The CLI reference documents `sf org assign permset` for permission sets. It does not say that groups are supported, so this article assigns groups with Apex. In step 3, the officer receives the two sets directly and then the group; in a real org assign only the group.

Audit queries that answer the auditors' two questions:

```soql
SELECT Assignee.Username, PermissionSet.Name, PermissionSetGroup.DeveloperName
FROM PermissionSetAssignment
WHERE PermissionSet.Name != null
  AND Assignee.IsActive = true
ORDER BY Assignee.Username
```

```soql
SELECT Parent.Name, Parent.IsOwnedByProfile, Parent.Profile.Name, PermissionsRead, PermissionsEdit
FROM FieldPermissions
WHERE Field = 'Onboarding_Case__c.Source_Of_Funds__c'
```

```soql
SELECT Parent.Name, Parent.Profile.Name
FROM SetupEntityAccess
WHERE SetupEntityType = 'CustomPermission'
  AND SetupEntityId IN (
    SELECT Id FROM CustomPermission WHERE DeveloperName = 'Approve_High_Risk_Onboarding'
  )
```

The first query lists each assignment. The second shows every profile or set that touches the sensitive field (profile-owned rows have `IsOwnedByProfile = true`). The third lists everything that grants the high-risk flag. Permission sets inside a group show up as their own rows in the second and third queries.

## What happens behind the scenes

1. **Deploy.** The platform saves the object and fields first, then the custom permissions, then the permission sets, because the sets refer to them. A missing field or class makes the whole deployment fail. After the groups arrive, the platform recalculates each group. Its status moves from Outdated to Updated, and the group cannot be assigned until then.
2. **Assignment.** `PermissionSetAssignment` rows link a user to a set or group. They are setup data, which is why a test that inserts both a `User` and an assignment hits a mixed DML error unless one of them runs inside `System.runAs`. Assigning a group that is not Updated fails, which is why the tests call `Test.calculatePermissionSetGroup`. The Apex guide warns that this call consumes CPU time, so run it once in `@TestSetup`.
3. **Calculation.** For each request the platform works out the union of the profile, direct sets and group sets, minus muted permissions. The custom permission is part of that result, so `FeatureManagement.checkPermission` is an in-memory answer about the running user. The Apex Reference Guide documents it only as returning true or false; look at your debug log if you need to prove it costs no query.
4. **Request.** An approver clicks the button. The LWC imported the flag at load time to decide whether to show it. The click calls `OnboardingController.approve`, and the platform checks that the user's sets include access to that Apex class.
5. **Service.** `requireApprover` checks the flag again on the server. `byIds` runs one SOQL query in user mode: object read, FLS on the four fields and sharing are all checked. The synchronous limit is 100 queries, and this uses one however many cases are selected.
6. **DML in user mode.** `Database.update(..., false, AccessLevel.USER_MODE)` is one DML statement (limit 150) for the whole list. With `allOrNone` set to false, each failing row gets its own error and the others still commit.
7. **Order of execution.** For each saved case the platform runs before-save flows, then before triggers, then **custom validation rules**, then saves, then after triggers. This is where `Approval_Requires_Permission` runs. It evaluates `$Permission` for the running user, so even a record changed by an import, an API client or a list-view edit cannot reach Approved without the flag.
8. **Result.** Outcomes are returned as JSON. The LWC shows a toast and calls `notifyRecordUpdateAvailable` so the page refreshes.

In a debug log (Setup, Debug Logs, or `sf apex tail log`) look for the validation events. A blocked save shows the failing rule:

```text
VALIDATION_RULE|[EXTERNAL]|Approval_Requires_Permission
VALIDATION_FORMULA|AND( OR(ISNEW(), ISCHANGED(Status__c)), ...|Status__c=Approved
VALIDATION_FAIL
...
LIMIT_USAGE_FOR_NS|(default)|
  Number of SOQL queries: 1 out of 100
  Number of DML statements: 1 out of 150
```

## Test it and verify

1. Run the Apex tests: `sf apex run test --class-names OnboardingAccessTest --code-coverage --result-format human --wait 10 --target-org harborridge`. Expect all 8 tests to pass.
2. In Setup, Permission Set Groups, open `Onboarding Officer`. Expect the status **Updated**, two permission sets and one muting set.
3. Log in as the officer (Setup, Users, Login, or `sf org open --target-org officer1`). Open an Onboarding Case. Expect to see Source Of Funds but not be able to edit it. Try to change Status to Approved. Expect the validation message.
4. Log in as the manager. Add an approved limit, move the case to In Review, and click Approve. Expect the toast "Approved". Repeat on a High risk case; it also works because the manager holds both flags.
5. Remove `PS_High_Risk_Approver` from the manager's group assignment path (use a user with only `PS_Onboarding_Approver`) and approve a High risk case. Expect "High risk cases need the Approve High Risk Onboarding permission".
6. Run the three audit queries in the Developer Console Query Editor. Expect the manager and approver users in the third query only if their sets hold the flag.

## Common mistakes and fixes

- **Symptom: one clone of System Administrator per team.** Cause: copying a profile for convenience hands out far more access than needed. Fix: start from a minimal profile and grant access with named sets.
- **Symptom: a change meant for one person changes access for everyone.** Cause: you edited a shared profile. Fix: put the new access in a permission set and assign it to that person.
- **Symptom: code checks `Profile.Name`.** Cause: security tied to a label that can be renamed or cloned. Fix: define a custom permission and use `FeatureManagement.checkPermission` (see the bad and fixed examples).
- **Symptom: the button is hidden, but a direct API call still works.** Cause: the UI was the only check. Fix: check the custom permission in Apex and add a validation rule, as above. Treat the UI as a convenience.
- **Symptom: "MIXED_DML_OPERATION" in a test.** Cause: inserting a `User` and a `PermissionSetAssignment` (setup objects) with other records. Fix: wrap the setup-object DML in `System.runAs(new User(Id = UserInfo.getUserId()))`.
- **Symptom: a test cannot assign a permission set group.** Cause: the group is Outdated. Fix: call `Test.calculatePermissionSetGroup(groupId)` once in `@TestSetup`.
- **Symptom: a user gets less access than the set grants.** Cause: the set sits in a group with a muting set, or the user lacks a license the set needs. Fix: inspect the group's muting sets, and check the set's license requirements.
- **Symptom: `QueryException` naming a field in a user-mode query.** Cause: the running user has no FLS read on that field. Fix: grant it in the right set. Do not widen the query to system mode.

## Key takeaways

- A profile is the baseline; permission sets and groups are where access lives. They add access and never remove it.
- Name sets by job function or feature, group them for common roles, and use muting sets for per-group exceptions.
- Express capabilities as custom permissions. Check them with `FeatureManagement.checkPermission`, `$Permission` and `@salesforce/customPermission` so the UI, Apex and data layer agree.
- Never rely on hidden buttons. Enforce on the server and, for data, with a validation rule.
- Test with `System.runAs` and real assignments, and deploy permission sets as small metadata files.

## Where to go next

- [Sharing model explained](/articles/sharing-model-explained/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
- [Validation rule patterns](/articles/validation-rule-patterns/)
- [Apex test classes: best practices](/articles/apex-test-classes-best-practices/)
- [Salesforce DX, scratch orgs and packages](/articles/salesforce-dx-scratch-orgs-and-packages/)
