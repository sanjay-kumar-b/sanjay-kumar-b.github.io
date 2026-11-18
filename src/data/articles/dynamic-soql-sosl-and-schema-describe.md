---
title: "Dynamic SOQL, SOSL and Schema Describe: Build Safe Queries at Runtime"
description: "Build Apex queries at runtime safely with bind maps, allow-lists and Schema describe, add SOSL text search, and test it all with a flexible search service."
category: salesforce-development
tags: [SOQL, SOSL, Apex, Schema, Advanced]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "SOQL and SOSL Reference"
    url: "https://developer.salesforce.com/docs/atlas.en-us.soql_sosl.meta/soql_sosl/"
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Static SOQL is written at design time and checked by the compiler. Sometimes you cannot know the query until runtime: a filter screen where users pick fields, a generic export tool, a search box. This article shows how to build queries at runtime without opening a security hole, how SOSL searches text across objects, and how Schema describe tells your code what the org contains.

## The business scenario

Juniper Consulting's support managers want one reusable "find records" component. They choose an object (Account, Contact or Case), pick filters such as "Status equals Escalated" or "Name contains Acme", and get matching rows. They also want a single search box that finds a word across several objects. A static query cannot do this, and string-concatenating user input into a query would allow SOQL injection. You will build a service that accepts a description of the search, validates every part against the org's real metadata, and uses bind variables for all values.

## Before you start: setup

### In Salesforce

1. Use a **Developer Edition org** or sandbox with the Salesforce CLI and VS Code connected (`sf org login web --alias dev`).
2. Set `"sourceApiVersion": "67.0"` in `sfdx-project.json`.
3. Decide which objects the tool may search. In the code below that is an **allow-list** (`Account`, `Contact`, `Case`), because "any object" is a data exposure risk.
4. Give users a permission set that grants read access to those objects and fields. The service runs in **user mode**, so what each user sees depends on their permissions.
5. Create sample data with Execute Anonymous:

```apex
insert new List<Account>{
    new Account(Name = 'Acme Energy', Industry = 'Energy'),
    new Account(Name = 'Acme Foods', Industry = 'Food'),
    new Account(Name = 'Birch Bank', Industry = 'Banking')
};
```

6. For SOSL, remember that search indexing is **not instant** after inserts. In tests you use `Test.setFixedSearchResults`; in a real org new records can take a short while to appear in search.

### In the external system

None is required. If a web or mobile app calls this service, expose it through an Apex REST class or an LWC wire adapter, never accept raw query text from outside, and pass only the structured description of the search.

## How it works

**Dynamic SOQL** runs a query held in a string. The old way is `Database.query(string)`. The safer way is `Database.queryWithBinds(string, bindMap, accessLevel)`, where values are referenced as `:name` in the query and supplied in a map, so user text is never part of the query's syntax. The access level `AccessLevel.USER_MODE` enforces the running user's object, field and sharing access.

**Injection** happens when user text becomes part of the query: `WHERE Name = '` + input + `'` lets someone enter `x' OR Name != '`. Two defences work together:

1. **Bind** every value (`:v0`, `:v1`). `String.escapeSingleQuotes` is a fallback, not the main defence.
2. **Allow-list** every identifier (object, field, operator, sort direction). Binds cannot protect names, so you must check names yourself against **Schema describe**.

**Schema describe** returns metadata at runtime: `Schema.getGlobalDescribe()` lists objects, `sObjectType.getDescribe()` gives an object's details, and `fields.getMap()` gives its fields, each with `isAccessible()`, `isFilterable()`, `isSortable()`, `getType()` and picklist values.

**SOSL** (Salesforce Object Search Language) searches words across many objects with `FIND`, using the search index: `FIND 'acme' IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name)`. It returns a list of lists, one per object. Use SOQL to filter structured data and SOSL to find words.

## Basic example

```apex
// 1. Dynamic SOQL with binds (safe for values)
String industry = 'Energy';
Map<String, Object> binds = new Map<String, Object>{ 'industry' => industry };
List<Account> accounts = Database.queryWithBinds(
    'SELECT Id, Name FROM Account WHERE Industry = :industry LIMIT 50',
    binds,
    AccessLevel.USER_MODE
);

// 2. Describe: is the field readable, what type is it?
Schema.DescribeFieldResult name = Account.Name.getDescribe();
System.debug(name.isAccessible() + ' ' + name.getType());

// 3. Describe by string name, when the object is only known at runtime
Schema.SObjectType type = Schema.getGlobalDescribe().get('Account');
Map<String, Schema.SObjectField> fields = type.getDescribe().fields.getMap();
System.debug(fields.containsKey('industry'));   // lower-case keys

// 4. SOSL: find a word across objects
List<List<SObject>> found = [FIND 'Acme' IN ALL FIELDS RETURNING Account(Id, Name), Contact(Id, Name)];
List<Account> foundAccounts = (List<Account>) found[0];
```

This is safe because the only runtime values are the bind and the object looked up through describe. The advanced example generalises it.

## Advanced end-to-end example

**force-app/main/default/classes/SearchSpec.cls** describes a search as data.

```apex
public with sharing class SearchSpec {
    public class Filter {
        @AuraEnabled public String field;
        @AuraEnabled public String operator;   // equals, notEquals, contains, startsWith, greaterThan, lessThan
        @AuraEnabled public String value;
    }

    @AuraEnabled public String objectName;
    @AuraEnabled public List<String> fields = new List<String>();
    @AuraEnabled public List<Filter> filters = new List<Filter>();
    @AuraEnabled public String sortField;
    @AuraEnabled public Boolean sortDescending = false;
    @AuraEnabled public Integer pageSize = 25;
}
```

**force-app/main/default/classes/SearchValidationException.cls**

```apex
public class SearchValidationException extends Exception {}
```

**force-app/main/default/classes/DynamicSearchService.cls**

```apex
public with sharing class DynamicSearchService {

    public static final Set<String> ALLOWED_OBJECTS = new Set<String>{ 'Account', 'Contact', 'Case' };
    public static final Integer MAX_PAGE = 200;

    // Operator names map to fixed SOQL fragments. User text never reaches the query as an operator.
    private static final Map<String, String> OPERATORS = new Map<String, String>{
        'equals' => '=',
        'notEquals' => '!=',
        'contains' => 'LIKE',
        'startsWith' => 'LIKE',
        'greaterThan' => '>',
        'lessThan' => '<'
    };

    public class Built {
        public String soql;
        public Map<String, Object> binds = new Map<String, Object>();
    }

    // ---- Describe helpers --------------------------------------------------

    public static Schema.DescribeSObjectResult describeObject(String objectName) {
        if (String.isBlank(objectName) || !ALLOWED_OBJECTS.contains(objectName)) {
            throw new SearchValidationException('Object not allowed: ' + objectName);
        }
        Schema.SObjectType type = Schema.getGlobalDescribe().get(objectName);
        if (type == null) {
            throw new SearchValidationException('Unknown object: ' + objectName);
        }
        Schema.DescribeSObjectResult result = type.getDescribe();
        if (!result.isAccessible()) {
            throw new SearchValidationException('You cannot read ' + objectName);
        }
        return result;
    }

    public static Schema.DescribeFieldResult describeField(
        Schema.DescribeSObjectResult object_, String fieldName
    ) {
        Schema.SObjectField field = object_.fields.getMap().get(String.valueOf(fieldName).toLowerCase());
        if (field == null) {
            throw new SearchValidationException('Unknown field: ' + fieldName);
        }
        Schema.DescribeFieldResult result = field.getDescribe();
        if (!result.isAccessible()) {
            throw new SearchValidationException('You cannot read field ' + result.getName());
        }
        return result;
    }

    // ---- Building the query ------------------------------------------------

    private static Object convert(Schema.DescribeFieldResult field, String operator, String raw) {
        if (operator == 'contains') {
            return '%' + String.escapeSingleQuotes(raw) + '%';
        }
        if (operator == 'startsWith') {
            return String.escapeSingleQuotes(raw) + '%';
        }
        Schema.DisplayType type = field.getType();
        if (type == Schema.DisplayType.INTEGER) {
            return Integer.valueOf(raw);
        }
        if (type == Schema.DisplayType.DOUBLE || type == Schema.DisplayType.CURRENCY
            || type == Schema.DisplayType.PERCENT) {
            return Decimal.valueOf(raw);
        }
        if (type == Schema.DisplayType.BOOLEAN) {
            return Boolean.valueOf(raw);
        }
        if (type == Schema.DisplayType.DATE) {
            return Date.valueOf(raw);
        }
        return raw;
    }

    public static Built build(SearchSpec spec) {
        Schema.DescribeSObjectResult object_ = describeObject(spec.objectName);

        List<String> select_ = new List<String>();
        for (String name : spec.fields) {
            select_.add(describeField(object_, name).getName());
        }
        if (select_.isEmpty()) {
            select_.add('Id');
        }

        Built built = new Built();
        List<String> clauses = new List<String>();
        Integer index = 0;
        for (SearchSpec.Filter f : spec.filters) {
            if (!OPERATORS.containsKey(f.operator)) {
                throw new SearchValidationException('Operator not allowed: ' + f.operator);
            }
            Schema.DescribeFieldResult field = describeField(object_, f.field);
            if (!field.isFilterable()) {
                throw new SearchValidationException('Field cannot be filtered: ' + field.getName());
            }
            String bindName = 'v' + index;
            try {
                built.binds.put(bindName, convert(field, f.operator, f.value));
            } catch (TypeException e) {
                throw new SearchValidationException('Bad value for ' + field.getName() + ': ' + f.value);
            }
            clauses.add(field.getName() + ' ' + OPERATORS.get(f.operator) + ' :' + bindName);
            index++;
        }

        String soql = 'SELECT ' + String.join(select_, ', ') + ' FROM ' + object_.getName();
        if (!clauses.isEmpty()) {
            soql += ' WHERE ' + String.join(clauses, ' AND ');
        }
        if (String.isNotBlank(spec.sortField)) {
            Schema.DescribeFieldResult sort = describeField(object_, spec.sortField);
            if (!sort.isSortable()) {
                throw new SearchValidationException('Field cannot be sorted: ' + sort.getName());
            }
            soql += ' ORDER BY ' + sort.getName() + (spec.sortDescending ? ' DESC' : ' ASC');
        }
        Integer size = Math.min(Math.max(spec.pageSize == null ? 25 : spec.pageSize, 1), MAX_PAGE);
        built.binds.put('pageSize', size);
        built.soql = soql + ' LIMIT :pageSize';
        return built;
    }

    // ---- Running it --------------------------------------------------------

    public static List<SObject> run(SearchSpec spec) {
        Built built = build(spec);
        return Database.queryWithBinds(built.soql, built.binds, AccessLevel.USER_MODE);
    }
}
```

**force-app/main/default/classes/TextSearchService.cls** is the SOSL side.

```apex
public with sharing class TextSearchService {

    // Characters with special meaning in SOSL search strings.
    private static final String RESERVED = '\\?&|!{}[]()^~*:"\'+-';

    public static String sanitize(String term) {
        if (String.isBlank(term)) {
            throw new SearchValidationException('Enter a word to search for.');
        }
        String cleaned = '';
        for (Integer i = 0; i < term.length(); i++) {
            String ch = term.substring(i, i + 1);
            cleaned += RESERVED.contains(ch) ? '\\' + ch : ch;
        }
        if (term.trim().length() < 2) {
            throw new SearchValidationException('Enter at least two characters.');
        }
        return cleaned;
    }

    public static Map<String, List<SObject>> search(String term) {
        String safe = sanitize(term);
        String query = 'FIND \'' + safe + '*\' IN NAME FIELDS '
            + 'RETURNING Account(Id, Name), Contact(Id, Name), Case(Id, Subject) '
            + 'WITH USER_MODE LIMIT 20';
        Search.SearchResults results = Search.query(query);

        Map<String, List<SObject>> found = new Map<String, List<SObject>>();
        for (String name : new List<String>{ 'Account', 'Contact', 'Case' }) {
            List<SObject> rows = new List<SObject>();
            for (Search.SearchResult r : results.get(name)) {
                rows.add(r.getSObject());
            }
            found.put(name, rows);
        }
        return found;
    }
}
```

**force-app/main/default/classes/DynamicSearchTest.cls**

```apex
@IsTest
private class DynamicSearchTest {

    @TestSetup
    static void setup() {
        insert new List<Account>{
            new Account(Name = 'Acme Energy', Industry = 'Energy', NumberOfEmployees = 500),
            new Account(Name = 'Acme Foods', Industry = 'Food', NumberOfEmployees = 50),
            new Account(Name = 'Birch Bank', Industry = 'Banking', NumberOfEmployees = 900)
        };
    }

    private static SearchSpec spec(String field, String op, String value) {
        SearchSpec s = new SearchSpec();
        s.objectName = 'Account';
        s.fields = new List<String>{ 'Name', 'Industry' };
        SearchSpec.Filter f = new SearchSpec.Filter();
        f.field = field;
        f.operator = op;
        f.value = value;
        s.filters.add(f);
        s.sortField = 'Name';
        return s;
    }

    @IsTest
    static void containsFilterFindsMatchingRows() {
        List<SObject> rows = DynamicSearchService.run(spec('Name', 'contains', 'Acme'));
        System.assertEquals(2, rows.size());
    }

    @IsTest
    static void numericFilterConvertsTheValue() {
        List<SObject> rows = DynamicSearchService.run(spec('NumberOfEmployees', 'greaterThan', '100'));
        System.assertEquals(2, rows.size());
    }

    @IsTest
    static void injectionAttemptIsTreatedAsPlainText() {
        // The quote and OR clause are bound as a value, so nothing matches and nothing breaks.
        List<SObject> rows = DynamicSearchService.run(spec('Name', 'equals', 'x\' OR Name != \''));
        System.assertEquals(0, rows.size());
    }

    @IsTest
    static void builtQueryNeverContainsTheUserValue() {
        DynamicSearchService.Built built = DynamicSearchService.build(spec('Name', 'equals', 'secret-text'));
        System.assert(!built.soql.contains('secret-text'));
        System.assertEquals('secret-text', built.binds.get('v0'));
    }

    @IsTest
    static void rejectsAnObjectOutsideTheAllowList() {
        SearchSpec s = spec('Name', 'equals', 'x');
        s.objectName = 'User';
        try {
            DynamicSearchService.build(s);
            System.assert(false, 'Expected an exception');
        } catch (SearchValidationException e) {
            System.assert(e.getMessage().contains('not allowed'));
        }
    }

    @IsTest
    static void rejectsUnknownFieldsAndOperators() {
        try {
            DynamicSearchService.build(spec('Nope__c', 'equals', 'x'));
            System.assert(false, 'Expected an exception');
        } catch (SearchValidationException e) {
            System.assert(e.getMessage().contains('Unknown field'));
        }
        try {
            DynamicSearchService.build(spec('Name', 'drop', 'x'));
            System.assert(false, 'Expected an exception');
        } catch (SearchValidationException e) {
            System.assert(e.getMessage().contains('Operator not allowed'));
        }
    }

    @IsTest
    static void capsThePageSize() {
        SearchSpec s = spec('Name', 'contains', 'a');
        s.pageSize = 100000;
        System.assertEquals(200, DynamicSearchService.build(s).binds.get('pageSize'));
    }

    @IsTest
    static void sanitizeEscapesReservedCharacters() {
        System.assertEquals('a\\*b', TextSearchService.sanitize('a*b'));
        try {
            TextSearchService.sanitize(' ');
            System.assert(false, 'Expected an exception');
        } catch (SearchValidationException e) {
            System.assert(e.getMessage().contains('Enter a word'));
        }
    }

    @IsTest
    static void textSearchReturnsTheFixedResults() {
        Account acme = [SELECT Id FROM Account WHERE Name = 'Acme Energy' LIMIT 1];
        Test.setFixedSearchResults(new List<Id>{ acme.Id });
        Test.startTest();
        Map<String, List<SObject>> found = TextSearchService.search('Acme');
        Test.stopTest();
        System.assertEquals(1, found.get('Account').size());
    }
}
```

Deploy and run:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names DynamicSearchTest --result-format human --wait 10 --target-org dev
```

## What happens behind the scenes

`Database.queryWithBinds` sends the **query text** and the **values** to the platform separately. The parser reads the text first, sees `:v0` as a placeholder, and then fills the placeholder with the value from the map as data. Whatever the value contains, it cannot change the structure of the query. That is the same idea as a prepared statement in other databases, and it is why the injection test passes: the value `x' OR Name != '` is just a string that matches nothing.

Binds cannot be used for **names**: the object, the fields, the operators, the sort direction. If those came from the user as raw text, an attacker could ask for any field. So the service never copies a name from the request. It looks each name up in the describe result (`fields.getMap()`), and uses `getName()` from the **describe**, which returns the real API name with correct capitalisation. Operators come from a fixed map of safe fragments. Even the page size is clamped and bound.

`AccessLevel.USER_MODE` adds the platform's own enforcement as a second layer. Even if a bad field slipped through, the platform would refuse fields the user cannot read, rather than returning them. The explicit `isAccessible()` checks provide a **clear message**; user mode provides the **guarantee**.

SOSL works differently from SOQL. A search request goes to the **search index**, a separate store that is updated shortly after records change. It matches words, applies stemming and language rules, and returns results from several objects at once. That is why SOSL is fast for "find this word anywhere", and why it is not the tool for "all accounts where employees are above 100". In tests the index is not populated, so `Test.setFixedSearchResults` tells the platform which records a search should return.

Describe calls are cheap but not free: `Schema.getGlobalDescribe()` builds a large map, so avoid calling it inside loops. The service calls it once per request. Prefer `Schema.SObjectType` tokens (`Account.SObjectType`) when the object is known at compile time.

## Test it and verify

1. Run `DynamicSearchTest` and confirm that every test passes.
2. In Execute Anonymous, build a spec for Account with `contains` on `Name` and print `DynamicSearchService.build(spec).soql`. Confirm that the value is not inside the text.
3. Call the service with a field that does not exist and read the error message.
4. Sign in as a user without access to Case and confirm `build` reports "You cannot read Case".
5. Create a new Account, run `TextSearchService.search`, and notice that a brand new record may not appear instantly, while an older one does.
6. Check the debug log for the exact query that ran.

## Common mistakes and fixes

- **Concatenating user input into a query.** Use bind variables for every value.
- **Trusting field or object names from the client.** Validate against describe and an allow-list.
- **Using `Database.query` in user-facing code without access checks.** Prefer `queryWithBinds` with `AccessLevel.USER_MODE`.
- **Forgetting that describe keys are lower case.** Lower-case the name for `fields.getMap()`.
- **Calling `getGlobalDescribe()` in a loop.** Call it once and reuse the result.
- **Using SOSL for structured filters.** Use SOQL for field conditions and SOSL for words.
- **Not escaping SOSL reserved characters.** Characters like `*` and `"` change the search meaning.
- **Expecting SOSL results in tests.** Use `Test.setFixedSearchResults`.
- **Returning unlimited rows.** Clamp the page size.

## Key takeaways

- Bind values and allow-list names; both are needed against injection.
- Describe tells you at runtime what objects, fields and types exist.
- Run user-facing queries in user mode.
- SOSL finds words across objects; SOQL filters structured data.
- Write tests for the attack cases, not only the happy path.

## Where to go next

- Read [SOQL relationships and aggregate queries](/articles/soql-relationships-and-aggregate-queries/) for the static query shapes.
- Read [Apex security: user mode and sharing](/articles/apex-security-and-user-mode/) for the access model.
- Read [SOQL best practices](/articles/soql-best-practices/) for performance.
