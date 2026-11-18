---
title: "Apex Exception Handling and Logging: Custom Exceptions, Savepoints and a Log Framework"
description: "Handle Apex errors the right way: try/catch/finally, custom exceptions, partial DML results, savepoints and a platform-event logger, with full tests."
category: salesforce-development
tags: [Apex, Exceptions, Logging, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Apex Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
  - title: "Platform Events Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/"
---

Code fails. The question is whether it fails loudly and safely, or silently and badly. This article covers how Apex errors work, how to catch only what you can handle, how to keep data consistent with savepoints, and how to log errors so you can find them in production.

## The business scenario

Juniper Consulting runs a nightly import that creates Orders and their Order Lines from a partner file. Last week one bad row made the whole import fail with a generic "Script-thrown exception", leaving half the orders saved and nobody knowing which row failed. The operations team wants: good rows saved, bad rows reported with a reason, an all-or-nothing option for each order and its lines, and a log entry that survives a rollback so support can investigate.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox, with the Salesforce CLI and VS Code connected.
2. Create a **custom object** `Import_Log__c` with fields: `Severity__c` (Text 20), `Source__c` (Text 100), `Message__c` (Long Text Area 32768), `Details__c` (Long Text Area 32768), and `Record_Id__c` (Text 18). Give your integration or admin users create and read access through a permission set.
3. Create a **platform event** `Log_Event__e` (Setup, Platform Events) with the same text fields, publish behaviour **Publish Immediately**. Platform events are published outside the main transaction, which is why log entries survive a rollback.
4. Create an **Apex trigger** on `Log_Event__e` (code below) that writes to `Import_Log__c`.
5. Create the Order-related data: for this article we use the standard `Account` and a simple `Order_Line__c` custom object (Master-Detail is not needed) with `Account__c` (Lookup to Account), `Quantity__c` (Number) and `Price__c` (Currency).

### In the external system

The partner file is a CSV delivered by their system. Agree on the columns (`accountName`, `quantity`, `price`) and a clear error format to return. If the import is triggered by an external call, the caller should receive a per-row result, not a single success or failure.

## How it works

An **exception** is an object thrown when something goes wrong. Execution jumps out of the current method to the nearest matching `catch`. Apex has built-in types: `DmlException`, `QueryException`, `NullPointerException`, `ListException`, `MathException`, `CalloutException`, `LimitException` and more. All extend `Exception`.

- **try / catch / finally:** `finally` always runs, for cleanup.
- **Order of catch blocks** matters: put specific types before `Exception`.
- **Limit exceptions cannot be caught.** If you hit a governor limit, the transaction ends.
- **Custom exceptions:** a class whose name ends in `Exception` and that extends `Exception`.
- **Savepoints:** `Database.setSavepoint()` and `Database.rollback(sp)` undo DML to a point.
- **Partial success:** `Database.insert(records, false)` returns a `SaveResult` per record so good rows are saved and bad rows are reported.
- **Logging:** a rollback undoes DML, including your log record, unless the log is written outside the transaction. Publishing a platform event with *Publish Immediately* does that.

Rule of thumb: catch an exception only when you can **do something useful**: retry, return a friendly message, or log and rethrow. Do not swallow errors.

## Basic example

```apex
public class BasicErrors {
    public class OrderException extends Exception {}

    public static Integer parseQuantity(String raw) {
        try {
            return Integer.valueOf(raw);
        } catch (TypeException e) {
            throw new OrderException('Quantity must be a whole number: ' + raw);
        } finally {
            System.debug('parseQuantity finished for ' + raw);
        }
    }

    public static void saveAccount(String name) {
        try {
            insert new Account(Name = name);
        } catch (DmlException e) {
            // e.getDmlMessage(0) is the readable reason for the first failed row
            System.debug('Could not save: ' + e.getDmlMessage(0));
            throw e;   // do not hide it
        }
    }
}
```

## Advanced end-to-end example

**force-app/main/default/classes/ImportException.cls**

```apex
public class ImportException extends Exception {}
```

**force-app/main/default/classes/Logger.cls** publishes a platform event, so entries survive rollbacks.

```apex
public with sharing class Logger {
    public enum Severity { DEBUG, INFO, WARN, ERROR }

    @TestVisible private static List<Log_Event__e> buffer = new List<Log_Event__e>();

    public static void log(Severity level, String source, String message, Id recordId, String details) {
        buffer.add(new Log_Event__e(
            Severity__c = level.name(),
            Source__c = source,
            Message__c = truncate(message, 32000),
            Details__c = truncate(details, 32000),
            Record_Id__c = recordId == null ? null : String.valueOf(recordId)
        ));
    }

    public static void error(String source, Exception e, Id recordId) {
        log(Severity.ERROR, source, e.getMessage(), recordId,
            e.getTypeName() + '\n' + e.getStackTraceString());
    }

    public static void info(String source, String message) {
        log(Severity.INFO, source, message, null, null);
    }

    // Call once at the end of a transaction (or in a finally block).
    public static void flush() {
        if (buffer.isEmpty()) {
            return;
        }
        List<Database.SaveResult> results = EventBus.publish(buffer);
        for (Database.SaveResult r : results) {
            if (!r.isSuccess()) {
                System.debug(LoggingLevel.ERROR, 'Log publish failed: ' + r.getErrors()[0].getMessage());
            }
        }
        buffer.clear();
    }

    private static String truncate(String value, Integer max) {
        if (value == null) {
            return null;
        }
        return value.length() <= max ? value : value.substring(0, max);
    }
}
```

**force-app/main/default/triggers/LogEventTrigger.trigger**

```apex
trigger LogEventTrigger on Log_Event__e (after insert) {
    List<Import_Log__c> rows = new List<Import_Log__c>();
    for (Log_Event__e e : Trigger.new) {
        rows.add(new Import_Log__c(
            Severity__c = e.Severity__c,
            Source__c = e.Source__c,
            Message__c = e.Message__c,
            Details__c = e.Details__c,
            Record_Id__c = e.Record_Id__c
        ));
    }
    insert rows;
}
```

**force-app/main/default/classes/OrderImportService.cls**

```apex
public with sharing class OrderImportService {

    public class Row {
        public Integer line;
        public String accountName;
        public String quantity;
        public String price;
    }

    public class RowResult {
        public Integer line;
        public Boolean success;
        public String message;
    }

    // Each row is its own unit: good rows are saved, bad rows reported.
    public static List<RowResult> importRows(List<Row> rows) {
        List<RowResult> results = new List<RowResult>();
        Map<String, Account> accounts = loadAccounts(rows);

        for (Row row : rows) {
            RowResult result = new RowResult();
            result.line = row.line;
            Savepoint sp = Database.setSavepoint();
            try {
                Order_Line__c record = toRecord(row, accounts);
                insert record;
                result.success = true;
                result.message = 'Saved ' + record.Id;
            } catch (ImportException e) {
                Database.rollback(sp);
                result.success = false;
                result.message = e.getMessage();
                Logger.log(Logger.Severity.WARN, 'OrderImport', e.getMessage(), null, 'line ' + row.line);
            } catch (DmlException e) {
                Database.rollback(sp);
                result.success = false;
                result.message = e.getDmlMessage(0);
                Logger.error('OrderImport', e, null);
            } catch (Exception e) {
                // Unexpected: log with the stack trace, then rethrow after flushing.
                Database.rollback(sp);
                Logger.error('OrderImport', e, null);
                Logger.flush();
                throw e;
            }
            results.add(result);
        }
        Logger.info('OrderImport', rows.size() + ' rows processed');
        Logger.flush();
        return results;
    }

    private static Map<String, Account> loadAccounts(List<Row> rows) {
        Set<String> names = new Set<String>();
        for (Row r : rows) {
            if (String.isNotBlank(r.accountName)) {
                names.add(r.accountName.trim());
            }
        }
        Map<String, Account> byName = new Map<String, Account>();
        for (Account a : [SELECT Id, Name FROM Account WHERE Name IN :names WITH USER_MODE]) {
            byName.put(a.Name, a);
        }
        return byName;
    }

    @TestVisible
    private static Order_Line__c toRecord(Row row, Map<String, Account> accounts) {
        if (String.isBlank(row.accountName) || !accounts.containsKey(row.accountName.trim())) {
            throw new ImportException('Unknown account: ' + row.accountName);
        }
        Integer qty;
        Decimal price;
        try {
            qty = Integer.valueOf(row.quantity);
            price = Decimal.valueOf(row.price);
        } catch (TypeException e) {
            throw new ImportException('Quantity and price must be numbers.');
        }
        if (qty <= 0) {
            throw new ImportException('Quantity must be greater than zero.');
        }
        return new Order_Line__c(
            Account__c = accounts.get(row.accountName.trim()).Id,
            Quantity__c = qty,
            Price__c = price
        );
    }
}
```

**force-app/main/default/classes/OrderImportServiceTest.cls**

```apex
@IsTest
private class OrderImportServiceTest {

    private static OrderImportService.Row row(Integer line, String account, String qty, String price) {
        OrderImportService.Row r = new OrderImportService.Row();
        r.line = line;
        r.accountName = account;
        r.quantity = qty;
        r.price = price;
        return r;
    }

    @TestSetup
    static void setup() {
        insert new Account(Name = 'Acme Ltd');
    }

    @IsTest
    static void savesGoodRowsAndReportsBadOnes() {
        List<OrderImportService.Row> rows = new List<OrderImportService.Row>{
            row(1, 'Acme Ltd', '5', '10.50'),
            row(2, 'Nobody Inc', '1', '1'),
            row(3, 'Acme Ltd', 'abc', '1'),
            row(4, 'Acme Ltd', '0', '1')
        };

        Test.startTest();
        List<OrderImportService.RowResult> results = OrderImportService.importRows(rows);
        Test.stopTest();

        System.assertEquals(true, results[0].success);
        System.assertEquals(false, results[1].success);
        System.assert(results[1].message.contains('Unknown account'));
        System.assert(results[2].message.contains('must be numbers'));
        System.assert(results[3].message.contains('greater than zero'));
        System.assertEquals(1, [SELECT COUNT() FROM Order_Line__c]);
    }

    @IsTest
    static void logEntriesSurviveAndAreWrittenByTheTrigger() {
        Test.startTest();
        OrderImportService.importRows(new List<OrderImportService.Row>{ row(1, 'Nobody Inc', '1', '1') });
        Test.getEventBus().deliver();
        Test.stopTest();

        List<Import_Log__c> logs = [SELECT Severity__c, Source__c, Message__c FROM Import_Log__c];
        System.assert(logs.size() >= 2, 'A warning and a summary entry are expected');
        System.assertEquals('OrderImport', logs[0].Source__c);
    }

    @IsTest
    static void loggerTruncatesVeryLongMessages() {
        Logger.log(Logger.Severity.INFO, 'Test', 'x'.repeat(40000), null, null);
        System.assertEquals(32000, Logger.buffer[0].Message__c.length());
    }

    @IsTest
    static void unexpectedErrorsAreRethrown() {
        // A null row list element causes a NullPointerException inside the loop.
        try {
            OrderImportService.importRows(new List<OrderImportService.Row>{ null });
            System.assert(false, 'Expected an exception');
        } catch (NullPointerException e) {
            System.assert(true);
        }
    }
}
```

Deploy and test:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names OrderImportServiceTest --result-format human --wait 10 --target-org dev
```

## What happens behind the scenes

When `insert` fails, the platform throws a `DmlException` carrying one entry per failed row. `getDmlMessage(0)` returns the readable text for the first, such as a validation rule message or a required-field error. When you catch `ImportException`, you are catching your own business-rule failure; it never touched the database.

`Database.setSavepoint()` marks a point in the transaction. `Database.rollback(sp)` undoes every DML since that point, but **not** things that happen outside the transaction. That is the reason the log is a platform event. Events published with *Publish Immediately* are sent to the event bus right away, and a later rollback does not unpublish them. A trigger on the event, running in its own transaction, then writes the log row. If you inserted `Import_Log__c` directly, `Database.rollback` would delete your own error message along with the data you were trying to discard.

Buffering matters too. Each `EventBus.publish` call counts against a DML-like limit, so the logger collects entries and publishes them in one call in `flush()`. The unexpected-exception branch flushes before rethrowing, otherwise the entry would vanish with the failed transaction.

Governor limit errors (`LimitException`) cannot be caught, so you cannot log them from inside the failing transaction. Prevent them by design: bulkify, and check `Limits.getDmlStatements()` where it makes sense.

## Writing error messages people can act on

A good message names the problem and the fix. "Unknown account: Nobody Inc" tells the operator which value to correct, while "Error" tells them nothing. Keep three audiences in mind. The **end user** needs a short sentence without internals. The **operator** who reviews the import needs the row number and the value. The **developer** needs the exception type and stack trace, which belong in the log details and never in the user-facing message. Splitting the message from the details, as the logger does, lets you serve all three without leaking internals. Also decide the severity on purpose: a bad partner row is a warning because the system behaved correctly, while an unexpected null pointer is an error because the code has a bug. Alerts and dashboards built on that field then stay meaningful.

## Test it and verify

1. Run the tests and confirm all four pass.
2. In Execute Anonymous, import three rows (one good, two bad) and read the returned messages.
3. Open the `Import_Log__c` tab and confirm that the warning rows exist even though those rows were rolled back.
4. Rename the Account to something else, run again and confirm "Unknown account" appears.
5. Check Setup, Platform Events, for the event usage and make sure the trigger is active.

## Common mistakes and fixes

- **Catching `Exception` and doing nothing.** Log it and rethrow, or return a clear message.
- **Wrong catch order.** Specific types first, `Exception` last.
- **Trying to catch limit exceptions.** You cannot; design for limits.
- **Logging to a custom object inside the transaction.** A rollback removes it; use a platform event.
- **Publishing one event per message.** Buffer and publish once.
- **`insert` for bulk loads that should be partial.** Use `Database.insert(list, false)` when bad rows must not block good ones.
- **Leaking internal details to users.** Show a friendly message and log the stack trace.
- **Forgetting `AuraHandledException` for LWC callers.** Convert expected errors into one, with a clear message.

## Key takeaways

- Catch only what you can handle; rethrow the rest.
- Custom exceptions give business rules a name and a message.
- Savepoints and partial DML control what is saved.
- A platform-event logger survives rollbacks.
- Test failure paths as carefully as success paths.

## Where to go next

- Read [Apex test classes best practices](/articles/apex-test-classes-best-practices/) for building the data these tests use.
- Read [Apex triggers advanced](/articles/apex-triggers-advanced/) for error handling inside triggers.
- Read [Platform events and Change Data Capture](/articles/platform-events-cdc-pubsub/) for the event bus details.
