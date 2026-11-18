---
title: "SOQL Relationships and Aggregate Queries: Parent, Child, Semi-Joins and GROUP BY"
description: "Learn SOQL relationship queries, subqueries, semi and anti-joins, polymorphic fields and aggregates with a tested Apex pipeline report, setup steps and limits."
category: salesforce-development
tags: [SOQL, Apex, Data Model, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "SOQL and SOSL Reference"
    url: "https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Salesforce data is a set of linked objects. Accounts have Contacts, Contacts have Cases, Opportunities belong to Accounts. SOQL, the Salesforce Object Query Language, lets you follow those links inside one query instead of running many. This article teaches the relationship syntax, aggregates and the join-like filters, then builds a tested pipeline report in Apex.

## The business scenario

Juniper Consulting's sales director wants a weekly report: for every account in a region, the open pipeline amount, how many opportunities are open, and the largest one; a list of accounts that have no open opportunity at all; and the contacts for each top account. Doing this with a query per account would hit governor limits quickly. You need three well-shaped queries, run once, with the results turned into a clean structure that a Lightning component or a scheduled email can use.

## Before you start: setup

### In Salesforce

1. Use a **Developer Edition org** or a sandbox. Never experiment in production.
2. Install the Salesforce CLI and Visual Studio Code with the Salesforce Extension Pack, then connect: `sf org login web --alias dev --set-default`.
3. Create a project: `sf project generate --name pipeline-report`, and set `"sourceApiVersion": "67.0"` in `sfdx-project.json`.
4. Make sure your user can read Account, Contact and Opportunity. The System Administrator profile can; for a normal user add a permission set with those object permissions.
5. Create test data. Open **Developer Console, Debug, Open Execute Anonymous Window** (or run with `sf apex run`) and run this script, which also shows the code style used later:

```apex
List<Account> accounts = new List<Account>();
for (Integer i = 1; i <= 4; i++) {
    accounts.add(new Account(Name = 'Demo Account ' + i, BillingCountry = 'India'));
}
insert accounts;

List<Opportunity> opps = new List<Opportunity>{
    new Opportunity(Name = 'Demo A1', AccountId = accounts[0].Id, StageName = 'Prospecting',
        CloseDate = Date.today().addDays(30), Amount = 10000),
    new Opportunity(Name = 'Demo A2', AccountId = accounts[0].Id, StageName = 'Negotiation/Review',
        CloseDate = Date.today().addDays(10), Amount = 25000),
    new Opportunity(Name = 'Demo B1', AccountId = accounts[1].Id, StageName = 'Closed Won',
        CloseDate = Date.today().addDays(-5), Amount = 8000),
    new Opportunity(Name = 'Demo C1', AccountId = accounts[2].Id, StageName = 'Qualification',
        CloseDate = Date.today().addDays(45), Amount = 5000)
};
insert opps;
insert new Contact(FirstName = 'Asha', LastName = 'Rao', AccountId = accounts[0].Id);
```

### In the external system

None is needed. If the report is later shown in an external dashboard, add an integration user with read access and call an Apex REST method; see the inbound REST article.

## How it works

**Child-to-parent** (up the relationship): use a dot and the relationship name, up to five levels. For a standard lookup the name is the field name without `Id` (`Opportunity.Account.Name`). For a custom lookup `Region__c` the name is `Region__r`.

**Parent-to-child** (down): use a **subquery** in the `SELECT` list with the child's **plural relationship name**, such as `Contacts` or `Opportunities`. The result is a list on each parent record.

**Semi-join:** `WHERE Id IN (SELECT AccountId FROM Opportunity WHERE ...)` keeps parents that have matching children. An **anti-join** uses `NOT IN` to keep parents with none.

**Aggregates:** `COUNT()`, `SUM()`, `AVG()`, `MIN()`, `MAX()` with `GROUP BY`, and `HAVING` to filter the groups. Results come back as `AggregateResult` rows; read values by alias with `get('alias')`.

**Polymorphic fields** such as `Task.WhatId` can point to many object types. `TYPEOF` lets you select different fields depending on the type.

Always remember the limits: 100 SOQL queries per synchronous transaction, 50,000 rows returned in total, and a subquery counts toward the row limit of its parent query.

## Basic example

```apex
// Up: contact with its account's name and owner
List<Contact> contacts = [
    SELECT Id, Name, Account.Name, Account.Owner.Name
    FROM Contact
    WHERE Account.BillingCountry = 'India'
    LIMIT 10
];

// Down: accounts with their open opportunities
List<Account> accounts = [
    SELECT Id, Name,
        (SELECT Id, Name, Amount FROM Opportunities WHERE IsClosed = false)
    FROM Account
    WHERE BillingCountry = 'India'
    LIMIT 10
];
for (Account a : accounts) {
    System.debug(a.Name + ' has ' + a.Opportunities.size() + ' open opportunities');
}

// Aggregate: total open amount per stage
for (AggregateResult row : [
    SELECT StageName stage, COUNT(Id) total, SUM(Amount) amount
    FROM Opportunity
    WHERE IsClosed = false
    GROUP BY StageName
]) {
    System.debug(row.get('stage') + ': ' + row.get('total') + ' / ' + row.get('amount'));
}
```

Notice `a.Opportunities` on each account: that is the child list from the subquery, and it is empty (not null) when there are no children.

## Advanced end-to-end example

We build a selector (all SOQL in one class), a service that shapes the results, and a test class that creates its own data.

**force-app/main/default/classes/PipelineSelector.cls**

```apex
public with sharing class PipelineSelector {

    // One row per account: open pipeline and largest deal.
    public static List<AggregateResult> openPipelineByAccount(String country) {
        return [
            SELECT AccountId acct,
                   COUNT(Id) openCount,
                   SUM(Amount) openAmount,
                   MAX(Amount) biggest
            FROM Opportunity
            WHERE IsClosed = false
              AND Account.BillingCountry = :country
            GROUP BY AccountId
            HAVING SUM(Amount) > 0
            ORDER BY SUM(Amount) DESC
            LIMIT 200
        ];
    }

    // Anti-join: accounts with no open opportunity at all.
    public static List<Account> accountsWithoutOpenPipeline(String country) {
        return [
            SELECT Id, Name
            FROM Account
            WHERE BillingCountry = :country
              AND Id NOT IN (SELECT AccountId FROM Opportunity WHERE IsClosed = false)
            ORDER BY Name
            LIMIT 200
        ];
    }

    // Parent-to-child: accounts with contacts and open opportunities.
    public static Map<Id, Account> accountsWithChildren(Set<Id> accountIds) {
        return new Map<Id, Account>([
            SELECT Id, Name,
                   (SELECT Id, Name, Email FROM Contacts ORDER BY LastName LIMIT 5),
                   (SELECT Id, Name, Amount, StageName FROM Opportunities
                    WHERE IsClosed = false ORDER BY Amount DESC NULLS LAST)
            FROM Account
            WHERE Id IN :accountIds
        ]);
    }
}
```

**force-app/main/default/classes/PipelineReportService.cls**

```apex
public with sharing class PipelineReportService {

    public class AccountLine {
        @AuraEnabled public Id accountId;
        @AuraEnabled public String accountName;
        @AuraEnabled public Integer openCount;
        @AuraEnabled public Decimal openAmount;
        @AuraEnabled public Decimal biggest;
        @AuraEnabled public List<String> contactNames = new List<String>();
    }

    public class Report {
        @AuraEnabled public List<AccountLine> lines = new List<AccountLine>();
        @AuraEnabled public List<String> idleAccounts = new List<String>();
        @AuraEnabled public Decimal totalOpenAmount = 0;
    }

    public static Report build(String country) {
        if (String.isBlank(country)) {
            throw new IllegalArgumentException('A country is required.');
        }

        Report report = new Report();
        List<AggregateResult> rows = PipelineSelector.openPipelineByAccount(country);

        Set<Id> accountIds = new Set<Id>();
        for (AggregateResult row : rows) {
            accountIds.add((Id) row.get('acct'));
        }
        Map<Id, Account> accounts = PipelineSelector.accountsWithChildren(accountIds);

        for (AggregateResult row : rows) {
            Id accountId = (Id) row.get('acct');
            Account account = accounts.get(accountId);

            AccountLine line = new AccountLine();
            line.accountId = accountId;
            line.accountName = account == null ? '(not visible)' : account.Name;
            line.openCount = (Integer) row.get('openCount');
            line.openAmount = (Decimal) row.get('openAmount');
            line.biggest = (Decimal) row.get('biggest');

            if (account != null) {
                for (Contact c : account.Contacts) {
                    line.contactNames.add(c.Name);
                }
            }
            report.lines.add(line);
            report.totalOpenAmount += line.openAmount;
        }

        for (Account a : PipelineSelector.accountsWithoutOpenPipeline(country)) {
            report.idleAccounts.add(a.Name);
        }
        return report;
    }

    @AuraEnabled(cacheable=true)
    public static Report forCountry(String country) {
        try {
            return build(country);
        } catch (IllegalArgumentException e) {
            throw new AuraHandledException(e.getMessage());
        }
    }
}
```

**force-app/main/default/classes/PipelineReportServiceTest.cls**

```apex
@IsTest
private class PipelineReportServiceTest {

    @TestSetup
    static void setup() {
        List<Account> accounts = new List<Account>{
            new Account(Name = 'Busy Co', BillingCountry = 'Testland'),
            new Account(Name = 'Quiet Co', BillingCountry = 'Testland'),
            new Account(Name = 'Other Co', BillingCountry = 'Elsewhere')
        };
        insert accounts;

        insert new List<Opportunity>{
            new Opportunity(Name = 'Big', AccountId = accounts[0].Id, StageName = 'Prospecting',
                CloseDate = Date.today().addDays(30), Amount = 3000),
            new Opportunity(Name = 'Small', AccountId = accounts[0].Id, StageName = 'Qualification',
                CloseDate = Date.today().addDays(20), Amount = 1000),
            new Opportunity(Name = 'Won', AccountId = accounts[1].Id, StageName = 'Closed Won',
                CloseDate = Date.today().addDays(-1), Amount = 9999),
            new Opportunity(Name = 'Elsewhere deal', AccountId = accounts[2].Id, StageName = 'Prospecting',
                CloseDate = Date.today().addDays(5), Amount = 777)
        };
        insert new Contact(FirstName = 'Mina', LastName = 'Shah', AccountId = accounts[0].Id);
    }

    @IsTest
    static void aggregatesOpenPipelinePerAccount() {
        Test.startTest();
        PipelineReportService.Report report = PipelineReportService.build('Testland');
        Test.stopTest();

        System.assertEquals(1, report.lines.size(), 'Only Busy Co has open pipeline');
        PipelineReportService.AccountLine line = report.lines[0];
        System.assertEquals('Busy Co', line.accountName);
        System.assertEquals(2, line.openCount);
        System.assertEquals(4000, line.openAmount);
        System.assertEquals(3000, line.biggest);
        System.assertEquals(4000, report.totalOpenAmount);
    }

    @IsTest
    static void includesContactsFromTheChildSubquery() {
        PipelineReportService.Report report = PipelineReportService.build('Testland');
        System.assertEquals(new List<String>{ 'Mina Shah' }, report.lines[0].contactNames);
    }

    @IsTest
    static void listsAccountsWithoutOpenOpportunities() {
        PipelineReportService.Report report = PipelineReportService.build('Testland');
        // Quiet Co only has a closed opportunity, so the anti-join returns it.
        System.assertEquals(new List<String>{ 'Quiet Co' }, report.idleAccounts);
    }

    @IsTest
    static void ignoresOtherCountries() {
        PipelineReportService.Report report = PipelineReportService.build('Elsewhere');
        System.assertEquals(777, report.totalOpenAmount);
        System.assertEquals(0, report.idleAccounts.size());
    }

    @IsTest
    static void rejectsABlankCountry() {
        try {
            PipelineReportService.forCountry('  ');
            System.assert(false, 'Expected an exception');
        } catch (AuraHandledException e) {
            System.assert(e.getMessage() != null);
        }
    }

    @IsTest
    static void staysWithinQueryLimits() {
        Test.startTest();
        PipelineReportService.build('Testland');
        System.assertEquals(3, Limits.getQueries(), 'The report should use exactly three queries');
        Test.stopTest();
    }
}
```

Deploy and run the tests:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names PipelineReportServiceTest --result-format human --wait 10 --target-org dev
```

And try it from anonymous Apex:

```apex
PipelineReportService.Report r = PipelineReportService.build('India');
System.debug(JSON.serializePretty(r));
```

## What happens behind the scenes

Salesforce stores records in tables, but SOQL is not SQL. There is no `JOIN` keyword; the platform already knows the relationships between objects from the metadata (a lookup field and its relationship names), so a dotted path or a subquery is enough. When you write `Account.Owner.Name`, the platform joins to the Account and User tables for you, and applies the user's access rules to each step.

A **subquery** such as `(SELECT ... FROM Contacts)` is resolved with the parent in one request. The results are nested: each `Account` record in the list carries its own `Contacts` collection. That is why the whole report costs three queries no matter how many accounts there are, and why it is much better than querying contacts inside a loop.

An **aggregate** query is evaluated in the database. Instead of loading thousands of opportunities and adding them in Apex, the platform returns one row per group. The values arrive as `Object`, so you cast them (`(Decimal) row.get('openAmount')`). Using aliases (`openAmount`) is clearer than the default names `expr0`, `expr1`.

An **anti-join** with `NOT IN (SELECT ...)` is evaluated by the platform as a filter on the parent, so no account list ever reaches Apex that you then have to prune. There are restrictions: the subquery must select an Id or a lookup field, you cannot nest them deeply, and semi-join and anti-join subqueries cannot themselves contain further subqueries.

Because the class uses `with sharing`, each query returns only records the current user may see. The aggregate over opportunities and the account lookup are separate queries, so a user could in theory see an aggregate row for an account they cannot read; the code handles that case by labelling it "(not visible)" rather than throwing a null error.

## Test it and verify

1. Run the anonymous script from the setup section to create sample data.
2. Run the test class and confirm all six tests pass, including the one that asserts exactly three queries.
3. In **Developer Console, Query Editor**, run the child subquery and open the result to see the nested rows. Try the aggregate query and compare the totals with a standard Salesforce report.
4. Open **Debug Logs** or the **Execution Overview** and check the "SOQL queries" number for `PipelineReportService.build`. It should be 3.
5. Run the report as a user with limited sharing and confirm that they see only what their access allows.

## Common mistakes and fixes

- **Using the wrong relationship name.** Parent-to-child uses the plural name (`Contacts`, `Opportunities`); custom ones end in `__r`. Look it up in Object Manager, under the child object's lookup field, or in the schema.
- **Querying inside a loop.** Collect ids first, then run one query with `IN :ids`.
- **Reading an aggregate without a cast.** `row.get('x')` returns `Object`.
- **Forgetting `GROUP BY` fields in `SELECT`.** Every non-aggregated field must be grouped.
- **`WHERE` versus `HAVING`.** `WHERE` filters rows before grouping; `HAVING` filters the grouped results.
- **Assuming a child list is null.** It is an empty list.
- **Ignoring row limits.** A subquery counts toward the 50,000-row total; add `LIMIT`.
- **Hard-coding a stage name in several places.** Use `IsClosed` and `IsWon`, which hold across custom stages.
- **Mixing up the two forms of count.** `SELECT COUNT() FROM Account` returns a single number through `Database.countQuery` or by assigning to an `Integer`, while `COUNT(Id)` in a grouped query returns a value inside an `AggregateResult`.

## Key takeaways

- Use dots for child-to-parent and subqueries with plural names for parent-to-child.
- Semi-joins and anti-joins filter parents by their children in one query.
- Aggregates run in the database; alias them and cast the values.
- Put SOQL in a selector, shape results in a service, and assert query counts in tests.
- Respect limits: 100 queries and 50,000 rows per synchronous transaction.

## Where to go next

- Read [SOQL best practices](/articles/soql-best-practices/) for selectivity and performance.
- Read [Dynamic SOQL, SOSL and Schema describe](/articles/dynamic-soql-sosl-and-schema-describe/) for queries built at runtime.
- Read [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/) for the limits behind the numbers.
