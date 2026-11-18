---
title: "The Salesforce Sharing Model Explained: OWD, Roles and Sharing Rules"
description: "How Salesforce decides who can see a record: OWD, roles, sharing rules and Apex managed sharing, with a working project-sharing example and tests."
category: salesforce-administration
tags: [Sharing, Security, Permission Sets]
publishedAt: 2026-10-29
updatedAt: 2026-11-15
cover: /images/covers/sharing-model-explained.jpg
sources:
  - title: "Salesforce Security Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.securityImplGuide.meta/securityImplGuide/"
  - title: "Apex Developer Guide: Sharing"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_sharing.htm"
---

Record access in Salesforce is built in layers. You start restrictive and open access up. You cannot use sharing to take away access that a higher layer grants. This article explains each layer, then builds one realistic example that uses every layer, including Apex managed sharing, and proves the result with tests.

## The business scenario

Meridian Consulting (a fictional firm) tracks client engagements in a custom object `Project__c`. Project records are confidential: only the owner should see them by default. Regional managers must see their team's projects. A support group for the West region must be able to read every West project. And when a project names an outside **reviewer**, that one person needs read access to that one project and nothing else.

## Before you start: setup

### In Salesforce

1. Create the custom object `Project__c` with fields `Region__c` (picklist: West, East) and `Reviewer__c` (lookup to User).
2. Set the object's **Default Internal Access** to **Private** under **Setup > Sharing Settings**. This is the organisation-wide default (OWD).
3. Build the role hierarchy: Regional Manager above Consultant, and assign test users to roles.
4. Create a public group `West_Support` and add the support users.
5. Create a permission set `Project_User` granting read, create and edit on `Project__c`. Object permission is needed *as well as* record access.
6. Create an **Apex sharing reason** on `Project__c` named `Reviewer`, which lets Apex managed sharing rows survive an owner change.
7. Work in a sandbox. After changing OWD or sharing rules Salesforce recalculates access, which can take time in large orgs.

### In the external system

None. Sharing is entirely inside Salesforce.

## How it works

The layers, in order:

1. **Object permissions** (profiles and permission sets): can the user read, create, edit or delete this object at all?
2. **Organization-wide defaults (OWD):** baseline access for users who do not own a record, such as Private, Public Read Only or Public Read/Write.
3. **Role hierarchy:** users higher in the hierarchy can access records owned by users below them. This can be turned off per object for custom objects.
4. **Sharing rules:** open access to groups of users based on ownership or criteria.
5. **Manual sharing and teams:** owners or others share single records, or add account and opportunity team members.
6. **Apex managed sharing:** code that creates share records when rules are not enough.

Access to a record needs **both** object permission and record access.

Design approach: set OWD to the most restrictive level any user group needs, open access with roles and sharing rules instead of loosening OWD, and keep the role hierarchy aligned with how data visibility really flows, not with the org chart for its own sake.

## Basic example

Sales reps see only their own opportunities, but managers see their team's. Set Opportunity OWD to **Private**. The role hierarchy gives managers visibility into their reports' records. If a support group also needs read access to all opportunities in one region, add a criteria-based sharing rule for that group. No code is needed for any of this.

## Advanced end-to-end example

**force-app/main/default/objects/Project__c/sharingReasons/Reviewer.sharingReason-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SharingReason xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Reviewer</fullName>
    <label>Reviewer</label>
</SharingReason>
```

**force-app/main/default/sharingRules/Project__c.sharingRules-meta.xml** (the declarative layer)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<SharingRules xmlns="http://soap.sforce.com/2006/04/metadata">
    <sharingCriteriaRules>
        <fullName>West_Projects_To_West_Support</fullName>
        <accessLevel>Read</accessLevel>
        <label>West Projects To West Support</label>
        <sharedTo>
            <group>West_Support</group>
        </sharedTo>
        <criteriaItems>
            <field>Region__c</field>
            <operation>equals</operation>
            <value>West</value>
        </criteriaItems>
        <includeRecordsOwnedByAll>true</includeRecordsOwnedByAll>
    </sharingCriteriaRules>
</SharingRules>
```

**force-app/main/default/classes/ProjectSharingService.cls** (the code layer)

```apex
public with sharing class ProjectSharingService {

    // Runs in system context on purpose: creating share rows needs "Modify All"-like rights.
    public without sharing class ShareWriter {
        public void sync(List<Project__c> projects, Map<Id, Project__c> oldMap) {
            List<Project__Share> toInsert = new List<Project__Share>();
            Set<Id> changed = new Set<Id>();

            for (Project__c p : projects) {
                Project__c old = oldMap == null ? null : oldMap.get(p.Id);
                Id oldReviewer = old == null ? null : old.Reviewer__c;
                if (p.Reviewer__c == oldReviewer) {
                    continue;
                }
                changed.add(p.Id);
                if (p.Reviewer__c != null && p.Reviewer__c != p.OwnerId) {
                    toInsert.add(new Project__Share(
                        ParentId = p.Id,
                        UserOrGroupId = p.Reviewer__c,
                        AccessLevel = 'Read',
                        RowCause = Schema.Project__Share.RowCause.Reviewer__c
                    ));
                }
            }

            if (!changed.isEmpty()) {
                // Remove only our own rows so manual and rule-based sharing is untouched.
                delete [
                    SELECT Id FROM Project__Share
                    WHERE ParentId IN :changed
                    AND RowCause = 'Reviewer__c'
                ];
            }
            if (!toInsert.isEmpty()) {
                insert toInsert;
            }
        }
    }

    public static void sync(List<Project__c> projects, Map<Id, Project__c> oldMap) {
        new ShareWriter().sync(projects, oldMap);
    }
}
```

**force-app/main/default/triggers/ProjectTrigger.trigger**

```apex
trigger ProjectTrigger on Project__c (after insert, after update) {
    ProjectSharingService.sync(Trigger.new, Trigger.oldMap);
}
```

**force-app/main/default/classes/ProjectSharingTest.cls**

```apex
@IsTest
private class ProjectSharingTest {

    private static User makeUser(String alias) {
        Profile p = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
        return new User(
            Alias = alias, LastName = alias, Email = alias + '@example.com',
            Username = alias + System.now().getTime() + '@example.com',
            ProfileId = p.Id, TimeZoneSidKey = 'America/Los_Angeles',
            LocaleSidKey = 'en_US', EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US'
        );
    }

    private static void grantProjectAccess(List<User> users) {
        PermissionSet ps = new PermissionSet(Name = 'Project_Test_Access', Label = 'Project Test Access');
        insert ps;
        insert new ObjectPermissions(
            ParentId = ps.Id, SobjectType = 'Project__c',
            PermissionsRead = true, PermissionsCreate = true, PermissionsEdit = true
        );
        List<PermissionSetAssignment> assignments = new List<PermissionSetAssignment>();
        for (User u : users) {
            assignments.add(new PermissionSetAssignment(AssigneeId = u.Id, PermissionSetId = ps.Id));
        }
        insert assignments;
    }

    private static Boolean canRead(User u, Id recordId) {
        UserRecordAccess a = [
            SELECT HasReadAccess FROM UserRecordAccess
            WHERE UserId = :u.Id AND RecordId = :recordId
        ];
        return a.HasReadAccess;
    }

    @IsTest
    static void reviewerGetsReadAndStrangerDoesNot() {
        User owner = makeUser('own');
        User reviewer = makeUser('rev');
        User stranger = makeUser('str');
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert new List<User>{ owner, reviewer, stranger };
            grantProjectAccess(new List<User>{ owner, reviewer, stranger });
        }

        Project__c project;
        System.runAs(owner) {
            project = new Project__c(Name = 'Atlas', Region__c = 'East', Reviewer__c = reviewer.Id);
            insert project;
        }

        System.assert(canRead(owner, project.Id), 'Owner reads own record');
        System.assert(canRead(reviewer, project.Id), 'Reviewer gets Apex managed read access');
        System.assert(!canRead(stranger, project.Id), 'Private OWD hides it from others');
    }

    @IsTest
    static void changingReviewerMovesAccess() {
        User owner = makeUser('own');
        User first = makeUser('fir');
        User second = makeUser('sec');
        System.runAs(new User(Id = UserInfo.getUserId())) {
            insert new List<User>{ owner, first, second };
            grantProjectAccess(new List<User>{ owner, first, second });
        }

        Project__c project;
        System.runAs(owner) {
            project = new Project__c(Name = 'Borealis', Region__c = 'East', Reviewer__c = first.Id);
            insert project;
            project.Reviewer__c = second.Id;
            update project;
        }

        System.assert(!canRead(first, project.Id), 'Old reviewer loses access');
        System.assert(canRead(second, project.Id), 'New reviewer gains access');
        System.assertEquals(1, [SELECT COUNT() FROM Project__Share WHERE ParentId = :project.Id AND RowCause = 'Reviewer__c']);
    }
}
```

## What happens behind the scenes

For every object with sharing, Salesforce keeps a hidden **share table** (for custom objects it is `Project__Share`). Each row says "this user or group has this access level to this record, for this reason". When a user queries or opens a record, the platform checks object permissions first, then looks for any route to access: ownership, role hierarchy, a row in the share table, or a team membership.

Sharing rules and manual shares create share rows with their own row causes, which Salesforce maintains. Apex managed sharing writes rows with a custom **Apex sharing reason**. That reason matters: when the record's owner changes, Salesforce removes rows whose reason is `Manual`, but keeps rows with an Apex sharing reason, so the reviewer does not lose access by surprise. It also lets the code delete only its own rows.

The `ShareWriter` is `without sharing` because writing share rows requires rights an ordinary user does not have. Keep such a class tiny and called from a trusted place, as here, so the elevated code does only one job.

## Choosing the right layer

When someone asks for "access to X", walk down the layers and stop at the first one that fits. If the person needs the object at all, grant it with a permission set. If everyone should see everything, raise the OWD, but only when that is truly acceptable. If a manager should see a team's records, the role hierarchy already does it. If a group needs records that match a rule, such as a region, write a sharing rule. If one person needs one record, share it manually. Only when the rule depends on data that no criteria can express, such as "the reviewer named on this project", reach for Apex.

Each step down costs more to maintain. A sharing rule is visible to every admin in Setup; Apex managed sharing is visible only to developers, and it must be tested and kept up to date. Document why the code exists so the next admin does not delete the share rows by hand.

Also remember performance: every extra sharing rule and every deep role chain adds recalculation work when records or users move, so review the model before a big data migration, not after.

## Test it and verify

1. Deploy everything to a sandbox and run `ProjectSharingTest`.
2. Create a West project owned by a consultant. Log in as a West Support user using **Login As** and confirm it appears in list views.
3. Log in as the Regional Manager and confirm visibility through the role hierarchy.
4. Set a reviewer on a project and confirm the reviewer can open that project but not another one.
5. On the project, click **Sharing** and confirm the reviewer row shows the reason `Reviewer`.
6. Use **Setup > Sharing Settings** to check that the OWD still says Private.

## Common mistakes and fixes

- **"I can't see it."** Check object permission first, then OWD, then role and sharing rules.
- **Loosening OWD to fix one case.** It opens everything. Use a rule or Apex sharing for the exception.
- **Role hierarchy copied from the org chart.** Build it for data visibility, not titles.
- **Too many sharing rules and a huge hierarchy.** Recalculation becomes slow. Plan before large data loads.
- **Over-granting with profiles.** Prefer permission sets for additive access.
- **Using the `Manual` row cause in code.** Rows disappear on owner change. Define an Apex sharing reason.

## Key takeaways

- Access needs object permission and record access.
- Start with the most restrictive OWD and open up with roles, rules, manual sharing and teams.
- Apex managed sharing handles exceptions the declarative tools cannot express.
- Use an Apex sharing reason and delete only your own rows.
- Always verify what a real user sees, with Login As or `UserRecordAccess`.

## Where to go next

- Read [Permission sets vs profiles](/articles/permission-sets-vs-profiles/) for the object-permission layer.
- Read [Apex security and user mode](/articles/apex-security-and-user-mode/) for how code respects sharing.
- Read [Apex trigger handler pattern](/articles/trigger-handler-pattern/) to structure the trigger properly.
