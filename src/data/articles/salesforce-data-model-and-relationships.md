---
title: "Salesforce Data Model and Relationships: Lookup, Master-Detail, Junction Objects and Roll-ups"
description: "Design a Salesforce data model: objects, fields, lookup vs master-detail, many-to-many junction objects and roll-ups, deployed as metadata and proven by tests."
category: salesforce-administration
tags: [Data Model, Objects, Relationships, Beginner, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Object Reference for Salesforce"
    url: "https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/"
  - title: "Salesforce Help: Object Relationships Overview"
    url: "https://help.salesforce.com/s/articleView?id=sf.overview_of_custom_object_relationships.htm"
---

Everything in Salesforce sits on its data model: the objects (tables), the fields (columns) and the relationships between them. A good model makes reports, security and code simple. A weak one causes duplicate data, slow queries and painful rework. This article teaches the building blocks, then builds a small model, deploys it as metadata and proves its behaviour with tests.

## The business scenario

Juniper Consulting runs client projects. A **Project** has many **Tasks**, and each task has estimated hours. Staff members are **Resources**, and one resource can work on many projects while one project has many resources, so they need an **Assignment** for each pairing, with the role and allocation percent. Managers want the total estimated hours on each project, deleting a project should delete its tasks and assignments, and nobody should be assigned to the same project twice.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or a sandbox. Do not build experiments in production.
2. Install the Salesforce CLI and VS Code with the Salesforce extensions; connect: `sf org login web --alias dev`.
3. Create a DX project: `sf project generate --name project-model`, and set `"sourceApiVersion": "67.0"`.
4. Decide naming up front. Use singular labels (Project, Task), API names ending in `__c`, and a consistent prefix for fields.
5. Know which tool to use: **Setup, Object Manager** is quickest for exploring; **metadata in source control** (below) is how teams keep environments identical.
6. Plan security with the model: objects need permission set access, and a **master-detail** child inherits sharing from its parent.

### In the external system

If another system sends projects or tasks, give each object an **External ID** field (for example `External_Ref__c`, marked External ID and Unique) so that integrations can **upsert** without knowing Salesforce ids. Agree the key with the other system before loading data.

## How it works

**Objects** hold records. Standard objects (Account, Contact, Opportunity, Case) come with Salesforce; **custom objects** end in `__c`.

**Field types** include Text, Number, Currency, Date, Checkbox, Picklist, Formula, Roll-up Summary, Lookup and Master-Detail. Choose the narrowest type that fits, because it determines validation, reports and storage.

**Relationships:**

| Type | Meaning | Parent required? | Delete behaviour | Sharing | Roll-up summaries |
|---|---|---|---|---|---|
| **Lookup** | A loose link to another record | No (can be empty) | Choose: clear the link, restrict deletion, or cascade (limited) | Independent | Not available natively (use Flow or Apex) |
| **Master-Detail** | The child cannot exist without its parent | Yes | Deleting the parent deletes the children | Child inherits from parent | Yes |
| **Many-to-many** | A **junction object** with two master-detail fields | Both | Deleting either parent deletes the junction records | Inherits from both | Yes, on each parent |
| **Hierarchical** | Lookup from an object to itself (User, Account via Parent) | No | Per setting | Independent | No |

**Roll-up summary fields** live on the master and calculate COUNT, SUM, MIN or MAX over the detail records.

The questions that choose the type: Can the child exist alone? (Lookup if yes.) Should security follow the parent? (Master-detail.) Do I need totals on the parent without code? (Master-detail.) Do two parents share many children? (Junction.)

## Basic example

The simplest model: a Task that must belong to a Project.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!-- force-app/main/default/objects/Task__c/fields/Project__c.field-meta.xml -->
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Project__c</fullName>
    <label>Project</label>
    <type>MasterDetail</type>
    <referenceTo>Project__c</referenceTo>
    <relationshipName>Tasks</relationshipName>
    <relationshipLabel>Tasks</relationshipLabel>
    <reparentableMasterDetail>false</reparentableMasterDetail>
    <writeRequiresMasterRead>false</writeRequiresMasterRead>
</CustomField>
```

Once this exists, SOQL can walk the link both ways:

```apex
List<Project__c> projects = [
    SELECT Name, (SELECT Name, Hours__c FROM Tasks__r)
    FROM Project__c LIMIT 5
];
```

The child-relationship name comes from the relationship name you chose, with `__r` appended in SOQL. In this model the relationship is named `Tasks`, so the subquery uses `Tasks__r`.

## Advanced end-to-end example

Five objects' worth of metadata, a service that keeps the junction clean, and tests that prove the rules. All files live under `force-app/main/default/objects/`.

**Project__c/Project__c.object-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Project</label>
    <pluralLabel>Projects</pluralLabel>
    <nameField>
        <label>Project Name</label>
        <type>Text</type>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>Private</sharingModel>
    <enableActivities>true</enableActivities>
    <enableReports>true</enableReports>
</CustomObject>
```

**Task__c/Task__c.object-meta.xml** (a detail object inherits sharing, so the sharing model is `ControlledByParent`)

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Task</label>
    <pluralLabel>Tasks</pluralLabel>
    <nameField>
        <label>Task Name</label>
        <type>Text</type>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ControlledByParent</sharingModel>
    <enableReports>true</enableReports>
</CustomObject>
```

**Task__c/fields/Hours__c.field-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Hours__c</fullName>
    <label>Estimated Hours</label>
    <type>Number</type>
    <precision>6</precision>
    <scale>1</scale>
    <required>false</required>
</CustomField>
```

**Project__c/fields/Total_Hours__c.field-meta.xml** is a roll-up summary on the master.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Total_Hours__c</fullName>
    <label>Total Estimated Hours</label>
    <type>Summary</type>
    <summaryOperation>sum</summaryOperation>
    <summarizedField>Task__c.Hours__c</summarizedField>
    <summaryForeignKey>Task__c.Project__c</summaryForeignKey>
    <precision>8</precision>
    <scale>1</scale>
</CustomField>
```

**Resource__c/Resource__c.object-meta.xml** and the **Assignment__c** junction with its two master-detail fields:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Resource</label>
    <pluralLabel>Resources</pluralLabel>
    <nameField>
        <label>Resource Name</label>
        <type>Text</type>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Assignment</label>
    <pluralLabel>Assignments</pluralLabel>
    <nameField>
        <label>Assignment Number</label>
        <type>AutoNumber</type>
        <displayFormat>A-{0000}</displayFormat>
        <startingNumber>1</startingNumber>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ControlledByParent</sharingModel>
</CustomObject>
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Project__c</fullName>
    <label>Project</label>
    <type>MasterDetail</type>
    <referenceTo>Project__c</referenceTo>
    <relationshipName>Assignments</relationshipName>
    <relationshipLabel>Assignments</relationshipLabel>
    <relationshipOrder>0</relationshipOrder>
    <reparentableMasterDetail>false</reparentableMasterDetail>
</CustomField>
```

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Resource__c</fullName>
    <label>Resource</label>
    <type>MasterDetail</type>
    <referenceTo>Resource__c</referenceTo>
    <relationshipName>Assignments</relationshipName>
    <relationshipLabel>Assignments</relationshipLabel>
    <relationshipOrder>1</relationshipOrder>
    <reparentableMasterDetail>false</reparentableMasterDetail>
</CustomField>
```

The first master-detail field on the junction object (`relationshipOrder` 0) is the **primary** parent: it decides the junction record's owner and sharing. Add `Role__c` (Picklist) and `Allocation_Percent__c` (Percent) to Assignment as ordinary fields in the same way as `Hours__c`.

**force-app/main/default/classes/AssignmentService.cls** keeps the junction free of duplicates.

```apex
public with sharing class AssignmentService {

    public class AssignmentException extends Exception {}

    public static List<Assignment__c> assign(Id projectId, Set<Id> resourceIds) {
        if (projectId == null || resourceIds == null || resourceIds.isEmpty()) {
            throw new AssignmentException('A project and at least one resource are required.');
        }

        // One query finds the pairs that already exist.
        Set<Id> already = new Set<Id>();
        for (Assignment__c a : [
            SELECT Resource__c FROM Assignment__c
            WHERE Project__c = :projectId AND Resource__c IN :resourceIds
            WITH USER_MODE
        ]) {
            already.add(a.Resource__c);
        }

        List<Assignment__c> toInsert = new List<Assignment__c>();
        for (Id resourceId : resourceIds) {
            if (!already.contains(resourceId)) {
                toInsert.add(new Assignment__c(Project__c = projectId, Resource__c = resourceId));
            }
        }
        insert as user toInsert;
        return toInsert;
    }
}
```

**force-app/main/default/classes/ProjectModelTest.cls**

```apex
@IsTest
private class ProjectModelTest {

    @TestSetup
    static void setup() {
        Project__c project = new Project__c(Name = 'Website rebuild');
        insert project;
        insert new List<Task__c>{
            new Task__c(Name = 'Design', Project__c = project.Id, Hours__c = 12.5),
            new Task__c(Name = 'Build', Project__c = project.Id, Hours__c = 30)
        };
        insert new List<Resource__c>{
            new Resource__c(Name = 'Asha'), new Resource__c(Name = 'Ravi')
        };
    }

    private static Project__c project() {
        return [SELECT Id, Total_Hours__c FROM Project__c LIMIT 1];
    }

    @IsTest
    static void rollUpSummaryTotalsTheTasks() {
        System.assertEquals(42.5, project().Total_Hours__c);
    }

    @IsTest
    static void rollUpUpdatesWhenATaskChanges() {
        Task__c build = [SELECT Id FROM Task__c WHERE Name = 'Build'];
        build.Hours__c = 10;
        update build;
        System.assertEquals(22.5, project().Total_Hours__c);
    }

    @IsTest
    static void aTaskCannotExistWithoutAProject() {
        try {
            insert new Task__c(Name = 'Orphan');
            System.assert(false, 'Expected a required-field error');
        } catch (DmlException e) {
            System.assertEquals(StatusCode.REQUIRED_FIELD_MISSING, e.getDmlType(0));
        }
    }

    @IsTest
    static void deletingTheProjectDeletesItsTasksAndAssignments() {
        Project__c p = project();
        AssignmentService.assign(p.Id, new Map<Id, Resource__c>([SELECT Id FROM Resource__c]).keySet());
        System.assertEquals(2, [SELECT COUNT() FROM Assignment__c]);

        delete p;

        System.assertEquals(0, [SELECT COUNT() FROM Task__c]);
        System.assertEquals(0, [SELECT COUNT() FROM Assignment__c]);
        System.assertEquals(2, [SELECT COUNT() FROM Resource__c], 'Resources are independent of projects');
    }

    @IsTest
    static void assigningTwiceDoesNotCreateDuplicates() {
        Project__c p = project();
        Set<Id> resources = new Map<Id, Resource__c>([SELECT Id FROM Resource__c]).keySet();
        AssignmentService.assign(p.Id, resources);
        List<Assignment__c> second = AssignmentService.assign(p.Id, resources);
        System.assertEquals(0, second.size());
        System.assertEquals(2, [SELECT COUNT() FROM Assignment__c]);
    }

    @IsTest
    static void manyToManyCanBeQueriedFromEitherSide() {
        Project__c p = project();
        AssignmentService.assign(p.Id, new Map<Id, Resource__c>([SELECT Id FROM Resource__c]).keySet());
        Resource__c asha = [SELECT Id, (SELECT Project__r.Name FROM Assignments__r) FROM Resource__c WHERE Name = 'Asha'];
        System.assertEquals('Website rebuild', asha.Assignments__r[0].Project__r.Name);
    }

    @IsTest
    static void requiresAProjectAndResources() {
        try {
            AssignmentService.assign(null, new Set<Id>());
            System.assert(false, 'Expected an exception');
        } catch (AssignmentService.AssignmentException e) {
            System.assert(e.getMessage().contains('required'));
        }
    }
}
```

Deploy and test:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names ProjectModelTest --result-format human --wait 10 --target-org dev
```

Fields on the junction can also be loaded from an external file using the External ID upsert, for example `sf data upsert bulk --sobject Project__c --external-id External_Ref__c --file projects.csv --target-org dev`. Confirm the command's options with `sf data upsert bulk --help`, because CLI flags change.

## What happens behind the scenes

Salesforce stores all objects in a shared multi-tenant database and keeps your object and field definitions as **metadata**. Each record has an 18-character Id; a relationship field simply stores the Id of the other record. The platform, not the database, enforces the rules: a master-detail field is required, and the platform refuses to save a Task with no Project (the test checks for `REQUIRED_FIELD_MISSING`).

For master-detail relationships the platform also manages **cascade delete** and **roll-ups**. Deleting a Project deletes its Tasks and Assignments in the same transaction; a roll-up summary is recalculated whenever a detail record is inserted, updated or deleted, so a query immediately after the DML sees the new total. A lookup does none of this by default; you would need a Flow or trigger to get a total, and a deletion setting to decide what happens to the children.

Sharing follows the relationship as well. A Task has no sharing of its own: `ControlledByParent` means that anyone who can see (or edit) the Project can do the same on its Tasks. This is why master-detail is the right choice when the detail has no meaning alone, and why a lookup is better when the child needs its own owner and sharing.

A junction object is simply a record with two master-detail fields. Salesforce treats the **first** as primary, and the junction inherits ownership and sharing from it. Because each assignment is an ordinary record, it can carry its own fields (role, allocation) and appear in reports. Nothing in the platform stops two identical assignments, so `AssignmentService` checks first. A more robust approach adds a **unique text field** made from both ids by a trigger or Flow, so duplicates are rejected even from imports.

## Test it and verify

1. Deploy the metadata and run the tests; confirm all six pass.
2. In **Object Manager, Project**, open **Fields & Relationships** and confirm `Total_Hours__c` is a Roll-Up Summary. Open **Schema Builder** to see the relationship lines.
3. Create a project, two tasks and two assignments through the UI. Confirm the total updates on the project page.
4. Delete the project and confirm that tasks and assignments disappear and the resources remain.
5. Create a report type "Projects with Tasks" and confirm tasks appear because they are children.
6. Log in as a user with access to Resource but not Project and confirm they cannot see assignments, because the junction inherits from the primary master.

## Common mistakes and fixes

- **Choosing master-detail when the child can exist alone.** Use a lookup; master-detail cannot be empty and cascades deletes.
- **Choosing lookup and then needing totals.** Either change to master-detail (only possible before data has empty parents) or use Flow or Apex.
- **A junction without two master-details.** That is just a lookup pair; sharing and cascade will not behave as expected.
- **Forgetting the primary master.** The first master-detail field decides the owner and sharing of junction records.
- **Too many fields on one object.** Split into related objects.
- **Using text where a picklist fits.** Picklists keep reporting clean.
- **No External ID for integrations.** Add one early; adding it after data is loaded is harder.
- **Building only in the UI.** Keep metadata in source control so sandboxes match production.

## Key takeaways

- Objects, fields and relationships are the foundation; design them before code or screens.
- Lookup is loose; master-detail is strict and gives cascade delete, shared security and roll-ups.
- Many-to-many needs a junction object with two master-detail fields.
- External IDs make integrations safe.
- Prove the model with tests, not assumptions.

## Where to go next

- Read [SOQL relationships and aggregate queries](/articles/soql-relationships-and-aggregate-queries/) to query the model.
- Read [The Salesforce sharing model explained](/articles/sharing-model-explained/) to see how access follows relationships.
- Read [Flow vs Apex](/articles/flow-vs-apex/) for logic on lookup relationships.
