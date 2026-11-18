---
title: "SOQL Best Practices: Fast, Selective and Safe Queries"
description: "Write SOQL that scales: selective filters, bind variables, safe dynamic queries, aggregates, keyset paging and user-mode security, with a full case-search layer."
category: salesforce-development
tags: [SOQL, Apex, Performance]
publishedAt: 2026-10-21
updatedAt: 2026-11-14
cover: /images/covers/soql-best-practices.jpg
sources:
  - title: "SOQL and SOSL Reference"
    url: "https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/"
  - title: "Execution Governors and Limits (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/pages/apex_gov_limits.htm"
---

SOQL is simple to write and easy to write badly. A query that returns instantly with 5,000 test records can time out with 5 million production records. These practices matter most once your org has large data volumes, and they are cheap to apply from day one.

This article gives you the rules, then builds a complete, safe case-search layer: a selector with selective queries, an aggregate summary, a dynamic search that cannot be injected, and keyset pagination that stays fast on page 5,000.

## The business scenario

Orbit Telecom (a fictional carrier) has 8 million Cases. The support console needs a "find cases" screen with optional filters (status, priority, account, text in the subject, created-after date), a count per status for a dashboard tile, and an "infinite scroll" list that must stay fast no matter how deep the user scrolls. Search is built by many teams, so it must be injection-proof and respect field-level security.

## Before you start: setup

### In Salesforce

1. Use a Developer sandbox or scratch org. For realistic timing, load a few hundred thousand Cases with Data Loader or the Bulk API (see the Bulk API articles). Verify: `SELECT COUNT() FROM Case` in the Developer Console returns the number you loaded.
2. Turn on the query plan tool. In the Developer Console choose Help, Preferences, and enable "Enable Query Plan" (label may differ slightly by release). Verify: the Query Editor now shows a **Query Plan** button.
3. Make sure your user can read Case, Account and the fields used (Status, Priority, Subject, CreatedDate, AccountId). The code uses user mode, so missing field access is reported as an error.
4. Install the Salesforce CLI: `sf org login web --alias dev`.

### In the external system

5. None needed. If you want a production-sized load test, generate a CSV of Cases with any script and load it with `sf data import bulk`. Verify the row count afterward.

## How it works

### Selective queries

A query is **selective** when the platform can use an index to find a small set of rows instead of scanning the whole table. On large objects, a non-selective filter is a common cause of timeouts and `System.QueryException: Non-selective query against large object type`.

Fields that are indexed by default include `Id`, `Name`, `OwnerId`, `CreatedDate`, `SystemModstamp`, lookup and master-detail fields, and external IDs (confirm the list for your object in the documentation). Custom fields can be indexed by Salesforce Support on request.

Rules of thumb (confirm the current thresholds in the Salesforce documentation on selective query criteria): the filter must match a small share of the table, roughly a few tens of percent for a standard index and less for a custom index, and the optimizer needs a filter on an indexed field to use that index.

Things that usually stop an index from being used:

| Pattern | Why it hurts |
|---|---|
| `WHERE Field != 'x'` or `NOT IN` | Negative filters match almost everything |
| `LIKE '%abc'` (leading wildcard) | The index cannot narrow by the end of a value |
| Wrapping a field in a function | The index is on the raw value |
| `OR` between an indexed and a non-indexed field | One branch scans the table |
| `Field = null` on a big object | Usually matches too much |

### Four habits

1. Select only the fields you use. Fewer fields means less heap.
2. Filter in the query, not in Apex.
3. Use bind variables for every value, always.
4. Ask for the user's permissions with `WITH USER_MODE` unless you have a documented reason to use system mode.

## Basic example

Before and after, using the habits above. Run it in anonymous Apex.

```apex
// Anonymous Apex
// BAD: pulls everything, filters in Apex, ignores field-level security.
List<Case> all = [SELECT Id, Subject, Status, Priority, CreatedDate, AccountId FROM Case LIMIT 50000];
List<Case> urgent = new List<Case>();
for (Case c : all) {
    if (c.Priority == 'High' && c.Status != 'Closed') {
        urgent.add(c);
    }
}
System.debug('BAD rows read: ' + Limits.getQueryRows());
```

```apex
// Anonymous Apex
// GOOD: the database does the filtering, one bind variable, only the fields we need.
String priority = 'High';
Date since = Date.today().addDays(-7);
List<Case> urgent = [
    SELECT Id, Subject, Status
    FROM Case
    WHERE Priority = :priority AND IsClosed = false AND CreatedDate >= :since
    WITH USER_MODE
    ORDER BY CreatedDate DESC
    LIMIT 200
];
System.debug('GOOD rows read: ' + Limits.getQueryRows());
```

The first version reads up to 50,000 rows to keep a few. The second reads only the matching rows. Note the `CreatedDate` filter: a date range on an indexed field is what makes the second query selective on a big table.

## Advanced end-to-end example

### The selector

**`force-app/main/default/classes/CaseSearchCriteria.cls`**

```apex
// What the user typed into the search form. All fields are optional.
public class CaseSearchCriteria {
    @AuraEnabled public String status;
    @AuraEnabled public String priority;
    @AuraEnabled public Id accountId;
    @AuraEnabled public String subjectContains;
    @AuraEnabled public Date createdAfter;
    @AuraEnabled public Id lastSeenId;      // for keyset paging
    @AuraEnabled public Integer pageSize = 50;
}
```

**`force-app/main/default/classes/CaseSelector.cls`**

```apex
public inherited sharing class CaseSelector {

    private static final Integer MAX_PAGE = 200;

    // 1. Relationship query: cases and their account name in ONE query.
    public static List<Case> openForAccounts(Set<Id> accountIds) {
        return [
            SELECT Id, CaseNumber, Subject, Status, Priority, Account.Name
            FROM Case
            WHERE AccountId IN :accountIds AND IsClosed = false
            WITH USER_MODE
            ORDER BY CreatedDate DESC
            LIMIT 2000
        ];
    }

    // 2. Aggregate: counts per status computed by the database, not in Apex.
    public static Map<String, Integer> countByStatus(Date createdAfter) {
        Map<String, Integer> result = new Map<String, Integer>();
        for (AggregateResult ar : [
            SELECT Status s, COUNT(Id) n
            FROM Case
            WHERE CreatedDate >= :createdAfter
            WITH USER_MODE
            GROUP BY Status
        ]) {
            result.put((String) ar.get('s'), (Integer) ar.get('n'));
        }
        return result;
    }

    // 3. Dynamic search: the SQL text only ever contains field names WE chose.
    //    Every user value goes in through a bind map, so injection is not possible.
    public static List<Case> search(CaseSearchCriteria c) {
        List<String> filters = new List<String>();
        Map<String, Object> binds = new Map<String, Object>();

        if (String.isNotBlank(c.status)) {
            filters.add('Status = :status');
            binds.put('status', c.status);
        }
        if (String.isNotBlank(c.priority)) {
            filters.add('Priority = :priority');
            binds.put('priority', c.priority);
        }
        if (c.accountId != null) {
            filters.add('AccountId = :accountId');
            binds.put('accountId', c.accountId);
        }
        if (c.createdAfter != null) {
            filters.add('CreatedDate >= :createdAfter');
            binds.put('createdAfter', c.createdAfter);
        }
        if (String.isNotBlank(c.subjectContains)) {
            filters.add('Subject LIKE :subjectLike');
            // escapeSingleQuotes is for string concatenation; with binds it is not needed,
            // but we must escape LIKE wildcards the user typed.
            String safe = c.subjectContains.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_');
            binds.put('subjectLike', '%' + safe + '%');
        }
        // Keyset paging: continue after the last Id we returned (see below).
        if (c.lastSeenId != null) {
            filters.add('Id > :lastSeenId');
            binds.put('lastSeenId', c.lastSeenId);
        }

        Integer size = Math.min(Math.max(c.pageSize == null ? 50 : c.pageSize, 1), MAX_PAGE);
        binds.put('pageSize', size);

        String soql = 'SELECT Id, CaseNumber, Subject, Status, Priority, AccountId, CreatedDate FROM Case';
        if (!filters.isEmpty()) {
            soql += ' WHERE ' + String.join(filters, ' AND ');
        }
        soql += ' ORDER BY Id ASC LIMIT :pageSize';

        return Database.queryWithBinds(soql, binds, AccessLevel.USER_MODE);
    }

    // 4. A SOQL for-loop streams big results in chunks of 200 and keeps heap low.
    public static Integer countHighPriorityOlderThan(Date cutoff) {
        Integer total = 0;
        for (List<Case> chunk : [
            SELECT Id FROM Case WHERE Priority = 'High' AND CreatedDate < :cutoff WITH USER_MODE
        ]) {
            total += chunk.size();
        }
        return total;
    }
}
```

### The service

**`force-app/main/default/classes/CaseSearchService.cls`**

```apex
public with sharing class CaseSearchService {

    public class Page {
        @AuraEnabled public List<Case> records;
        @AuraEnabled public Id nextCursor;   // null when there are no more pages
    }

    public static Page find(CaseSearchCriteria criteria) {
        List<Case> rows = CaseSelector.search(criteria);
        Page p = new Page();
        p.records = rows;
        Integer wanted = Math.min(Math.max(criteria.pageSize == null ? 50 : criteria.pageSize, 1), 200);
        p.nextCursor = rows.size() == wanted ? rows[rows.size() - 1].Id : null;
        return p;
    }

    public static Map<String, Integer> statusSummary(Integer days) {
        return CaseSelector.countByStatus(Date.today().addDays(-Math.abs(days)));
    }
}
```

### Why keyset paging, not OFFSET

`OFFSET 100000` forces the database to read and throw away 100,000 rows before returning the next 50, and SOQL caps `OFFSET` at 2,000. Keyset paging remembers the last `Id` returned and asks for `Id > :lastSeenId ORDER BY Id LIMIT 50`. That uses the index on `Id` and costs the same on page 1 and page 5,000.

### Tests

**`force-app/main/default/classes/CaseSelectorTest.cls`**

```apex
@IsTest
private class CaseSelectorTest {

    @TestSetup
    static void setup() {
        Account acc = new Account(Name = 'Orbit Test Account');
        insert acc;

        List<Case> cases = new List<Case>();
        for (Integer i = 0; i < 120; i++) {
            cases.add(new Case(
                AccountId = acc.Id,
                Subject = (i == 7 ? '100% outage_alpha' : 'Slow data ' + i),
                Status = (Math.mod(i, 2) == 0 ? 'New' : 'Working'),
                Priority = (Math.mod(i, 3) == 0 ? 'High' : 'Low'),
                Origin = 'Web'
            ));
        }
        insert cases;
    }

    @IsTest
    static void searchFiltersByStatusAndPriority() {
        CaseSearchCriteria c = new CaseSearchCriteria();
        c.status = 'New';
        c.priority = 'High';
        c.pageSize = 200;

        List<Case> rows = CaseSelector.search(c);

        Assert.isFalse(rows.isEmpty(), 'Expected some matching cases');
        for (Case r : rows) {
            Assert.areEqual('New', r.Status, 'Status filter applied');
            Assert.areEqual('High', r.Priority, 'Priority filter applied');
        }
    }

    @IsTest
    static void searchEscapesWildcardsAndQuotes() {
        CaseSearchCriteria c = new CaseSearchCriteria();
        c.subjectContains = '100% outage_alpha';
        List<Case> exact = CaseSelector.search(c);
        Assert.areEqual(1, exact.size(), 'Percent and underscore are literal characters');

        // An injection attempt is just text and matches nothing; it must not throw.
        c.subjectContains = '\' OR Name != null OR \'';
        Assert.areEqual(0, CaseSelector.search(c).size(), 'Injection text is treated as data');
    }

    @IsTest
    static void keysetPagingWalksEveryRecordExactlyOnce() {
        CaseSearchCriteria c = new CaseSearchCriteria();
        c.pageSize = 50;

        Set<Id> seen = new Set<Id>();
        Integer pages = 0;
        CaseSearchService.Page p;
        do {
            p = CaseSearchService.find(c);
            for (Case r : p.records) {
                Assert.isFalse(seen.contains(r.Id), 'No record may repeat');
                seen.add(r.Id);
            }
            c.lastSeenId = p.nextCursor;
            pages++;
        } while (p.nextCursor != null && pages < 10);

        Assert.areEqual(120, seen.size(), 'All 120 cases returned');
        Assert.areEqual(3, pages, '50 + 50 + 20');
    }

    @IsTest
    static void aggregateCountsMatchTheData() {
        Map<String, Integer> counts = CaseSelector.countByStatus(Date.today().addDays(-1));
        Assert.areEqual(60, counts.get('New'), 'Even indexes are New');
        Assert.areEqual(60, counts.get('Working'), 'Odd indexes are Working');
    }

    @IsTest
    static void queryCountDoesNotGrowWithData() {
        Account acc = [SELECT Id FROM Account LIMIT 1];
        Test.startTest();
        Integer before = Limits.getQueries();
        List<Case> rows = CaseSelector.openForAccounts(new Set<Id>{ acc.Id });
        Integer used = Limits.getQueries() - before;
        Test.stopTest();

        Assert.areEqual(1, used, 'One query for any number of cases');
        Assert.areEqual(120, rows.size(), 'All open cases returned');
        Assert.isNotNull(rows[0].Account.Name, 'Parent field came back in the same query');
    }

    @IsTest
    static void pageSizeIsCapped() {
        CaseSearchCriteria c = new CaseSearchCriteria();
        c.pageSize = 100000;
        Assert.isTrue(CaseSelector.search(c).size() <= 200, 'Page size is capped at 200');
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names CaseSelectorTest --result-format human --code-coverage --wait 10 --target-org dev
```

## What happens behind the scenes

1. `Database.queryWithBinds` takes the query text and a map of values. The platform parses the text first, then substitutes the values as data. Because values never become part of the SQL text, a value like `' OR Name != null OR '` is only a string. This is what prevents SOQL injection. If you build a query by concatenating a user value into the text, you must escape it with `String.escapeSingleQuotes`, and you are one mistake away from a vulnerability.
2. `AccessLevel.USER_MODE` makes the platform check the running user's object permission, field-level security and sharing before returning rows. If the user cannot read a field in the `SELECT` or the `WHERE`, the query throws a `QueryException` instead of silently returning it.
3. `ORDER BY Id ASC` with `Id > :lastSeenId` uses the primary key index, so every page is an index range read. `LIMIT :pageSize` stops the scan as soon as enough rows are found.
4. The aggregate query runs `GROUP BY` inside the database and returns one `AggregateResult` per group (here three or four rows) instead of millions of Cases.
5. The query optimizer chooses an index only when the filter is selective. With `Status = 'New'` alone on 8 million Cases, a very large share of rows may match, so it may scan; adding `CreatedDate >= :createdAfter` gives the optimizer a narrow, indexed range. That is why the screen should always send a date filter.
6. Governor limits: each `search` call costs one SOQL query and returns at most 200 rows out of the 50,000-row transaction limit.

## Test it and verify

1. Run the test class. Expected: 6 tests pass.
2. In the Developer Console, open the Query Editor, paste `SELECT Id FROM Case WHERE Status = 'New'` and click **Query Plan**. Compare the "Cardinality" and "Cost" numbers with `SELECT Id FROM Case WHERE CreatedDate >= LAST_N_DAYS:7 AND Status = 'New'`. A lower relative cost means the optimizer found a better plan.
3. Call the service from anonymous Apex and look at the debug log:

```apex
// Anonymous Apex
CaseSearchCriteria c = new CaseSearchCriteria();
c.status = 'New';
c.createdAfter = Date.today().addDays(-30);
c.pageSize = 25;
CaseSearchService.Page p = CaseSearchService.find(c);
System.debug('Rows: ' + p.records.size() + ', next cursor: ' + p.nextCursor);
System.debug('Queries used: ' + Limits.getQueries());
```

Expected: `Queries used: 1` and a non-null cursor when more rows remain.
4. Try as a limited user: run the same code under a user whose profile cannot read `Case.Priority` and confirm you get a `QueryException`, not partial data.

## Common mistakes and fixes

- **Symptom: `Non-selective query against large object type`.** Cause: the filter is not on an indexed field or matches too much. Fix: add a selective, indexed filter (a date range, an Id set, an owner), or ask Salesforce Support about a custom index.
- **Symptom: `Too many query rows: 50001`.** Cause: reading everything. Fix: filter in the query, add `LIMIT`, process with a SOQL for-loop, or move to Batch Apex with a `QueryLocator`.
- **Symptom: SOQL built with `'...' + userInput + '...'`.** Cause: string concatenation. Fix: use bind variables, or `Database.queryWithBinds` for dynamic queries.
- **Symptom: `LIKE` returns wrong rows for text containing `%` or `_`.** Cause: those characters are wildcards. Fix: escape them as the example does.
- **Symptom: page 3,000 is slow.** Cause: `OFFSET` paging. Fix: keyset paging on `Id` or another unique, indexed field.
- **Symptom: a query inside a loop.** Cause: a related lookup per record. Fix: collect ids, query once into a `Map`, or use a relationship query.
- **Symptom: `WITH SECURITY_ENFORCED` appears in old code.** Cause: the older approach. Fix: use `WITH USER_MODE`; check your release notes for the API version where `WITH SECURITY_ENFORCED` stops compiling.
- **Symptom: heap errors on large results.** Cause: the whole result held in a list. Fix: use a SOQL for-loop and select fewer fields.

## Key takeaways

- Select only needed fields, filter in the database, and use indexed, selective filters on big objects.
- Always use bind variables; use `Database.queryWithBinds` for dynamic queries.
- Prefer relationship queries and aggregates to extra queries and Apex counting.
- Use keyset paging for deep lists, and a SOQL for-loop for large results.
- Choose user mode deliberately and test it with a limited user.

## Where to go next

- [Apex governor limits cheat sheet](/articles/apex-governor-limits-cheat-sheet/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
- [SOQL relationships and aggregate queries](/articles/soql-relationships-and-aggregate-queries/)
- [Bulkify Apex triggers](/articles/bulkify-apex-triggers/)
