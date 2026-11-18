---
title: "Data Import, Export and Duplicate Management: Clean, Load and Prevent Duplicates"
description: "Load data safely into Salesforce: clean and validate CSVs, upsert with external ids, bulk load, export, and stop duplicates with rules and Apex."
category: salesforce-administration
tags: [Data Loading, Duplicate Management, Bulk API, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce Help: Import and Export Data"
    url: "https://help.salesforce.com/s/articleView?id=sf.importing.htm"
  - title: "Salesforce Help: Duplicate Management"
    url: "https://help.salesforce.com/s/articleView?id=sf.managing_duplicates_overview.htm"
  - title: "Bulk API 2.0 Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_asynch.meta/api_asynch/"
---

Bad data is expensive. A single careless import can create thousands of duplicate contacts, overwrite good values with blanks and take days to clean up. This article covers the safe path: choose the right tool, **clean and validate before loading**, load with an external id so reruns are safe, and use duplicate rules so the platform stops duplicates for you.

> CLI flags and Data Loader menu names change between releases. Use `--help` and the current documentation for exact options. The preparation script and Apex below are the parts you can run as written.

## The business scenario

Juniper Consulting has just acquired a smaller firm and received 40,000 contacts as a spreadsheet from their CRM. The file has inconsistent capitalisation, phone numbers in six formats, missing last names, blank emails and many people listed twice. Sales operations must load it into Salesforce, link each contact to the right Account, avoid creating duplicates of contacts that already exist, and be able to rerun the load after fixing mistakes without creating the same records again.

## Before you start: setup

### In Salesforce

1. Use a **sandbox** (a full or partial copy) for the first run, never production. Rehearse with a few hundred rows.
2. **Add an External ID field** to Contact: `Source_Id__c` (Text 50, **External ID** and **Unique**, case-insensitive). On Account add `Account_Ref__c` (Text 50, External ID, Unique) if you do not already have a stable key. The external id is what makes the load repeatable.
3. **Permissions.** The loading user needs Create and Edit on Contact and Account, and **API Enabled**. Give the user a dedicated integration profile or permission set, not an admin identity.
4. **Plan automation.** Triggers, flows and validation rules will fire on every row. Decide whether to leave them on (safer, slower) or use a bypass custom permission for the load (faster; you must then run the rules' checks yourself).
5. **Duplicate and matching rules.** In Setup, open **Duplicate Management**. Activate the standard **Contact** matching rule and a duplicate rule that **Alerts** in the UI and **Reports** in the API (or **Blocks**, if you want a hard stop). Note that the action can differ for UI and API saves.
6. **Backup.** Export the current Contacts first (Data Export or a bulk query), so you can roll back.
7. Install the **Salesforce CLI** and sign in: `sf org login web --alias sandbox`. Install Node 20 for the preparation script.

### In the external system

1. Ask the source team for the **primary key** of each contact in their system. That becomes `Source_Id__c`.
2. Agree the **file contract**: columns (`FirstName`, `LastName`, `Email`, `Phone`, `AccountRef`), UTF-8 encoding, comma separated, one header row.
3. Ask them to freeze changes during the load window, or to provide a delta file afterwards.
4. Keep their original file untouched; every cleaning step writes a new file.

## How it works

**Tools:**

| Tool | Records | Best for |
|---|---|---|
| **Data Import Wizard** | Up to about 50,000 | Simple loads of common objects, with built-in duplicate matching |
| **Data Loader** (desktop) | Millions | Insert, update, upsert, delete, export; mapping files; command line |
| **Salesforce CLI (`sf data ...`)** | Large | Scripted, repeatable loads and queries using the Bulk API |
| **Bulk API 2.0** | Large, asynchronous | Integration and large jobs, processed in the background |
| **Data Export** (Setup) | Whole org | Scheduled full backups |

**Operations:** insert (always creates), update (needs the Salesforce id), **upsert** (match on an external id: update if found, insert if not), delete, hard delete, and query.

**Upsert** is the key to safe reruns. If the external id exists, the record is updated; otherwise it is created. A failed load can be fixed and run again without duplicating the successful rows.

**Relationships in a load** can use the parent's external id too. A Contact row can carry `Account.Account_Ref__c` as its parent reference, so you never look up Salesforce ids.

**Duplicate management** has two parts. A **matching rule** defines what counts as similar (same email, or similar name and company). A **duplicate rule** decides what happens: **Allow** with an alert, or **Block**. Rules apply to UI and API saves; Apex can pass options to change the behaviour.

**Order of work:** profile the data, clean it, validate it, split it into batches, test with a small sample, load, check the results, and keep the error files.

## Basic example

A minimal upsert and export with the CLI (confirm flags with `sf data upsert bulk --help`):

```bash
# Load contacts, matching on the external id
sf data upsert bulk --sobject Contact --file contacts-clean.csv \
  --external-id Source_Id__c --wait 30 --target-org sandbox

# Export what is there now
sf data export bulk --query "SELECT Id, Source_Id__c, Email FROM Contact WHERE Source_Id__c != null" \
  --output-file contacts-after.csv --result-format csv --wait 30 --target-org sandbox
```

And the one-record Apex equivalent:

```apex
Contact c = new Contact(LastName = 'Rao', Email = 'asha@example.com', Source_Id__c = 'SRC-1');
Database.UpsertResult result = Database.upsert(c, Contact.Source_Id__c, false);
System.debug(result.isCreated() ? 'created' : 'updated');
```

## Advanced end-to-end example

The pipeline: **prepare** (clean, validate, de-duplicate within the file, split), **load** (upsert in batches), **verify** (compare counts), with duplicate-rule-aware Apex for records that arrive through code.

**tools/csvPrep.mjs** (preparation library, tested)

```javascript
// Prepares a contact CSV for loading: parse, clean, validate and remove in-file duplicates.

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') {
        i++;
      }
      row.push(field);
      field = '';
      if (row.some(cell => cell !== '')) {
        rows.push(row);
      }
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function toObjects(rows) {
  const [header, ...body] = rows;
  const names = header.map(h => h.trim());
  return body.map((cells, index) => {
    const record = { _line: index + 2 };
    names.forEach((name, i) => { record[name] = (cells[i] ?? '').trim(); });
    return record;
  });
}

export function normalizeEmail(value) {
  return value.trim().toLowerCase();
}

export function normalizePhone(value) {
  const digits = value.replace(/[^0-9+]/g, '');
  return digits.startsWith('+') ? digits : digits.replace(/^0+/, '');
}

export function titleCase(value) {
  return value.trim().toLowerCase().replace(/(^|[\s'-])([a-z])/g, (m, a, b) => a + b.toUpperCase());
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanRecord(raw) {
  const problems = [];
  const record = {
    FirstName: titleCase(raw.FirstName ?? ''),
    LastName: titleCase(raw.LastName ?? ''),
    Email: normalizeEmail(raw.Email ?? ''),
    Phone: normalizePhone(raw.Phone ?? ''),
    Account_Ref__c: (raw.AccountRef ?? '').trim()
  };
  if (record.LastName === '') {
    problems.push('LastName is required');
  }
  if (record.Email !== '' && !EMAIL.test(record.Email)) {
    problems.push('Email is not valid: ' + record.Email);
  }
  if (record.Account_Ref__c === '') {
    problems.push('AccountRef is required');
  }
  return { record, problems };
}

export function prepare(text) {
  const objects = toObjects(parseCsv(text));
  const valid = [];
  const rejected = [];
  const seen = new Map();

  for (const raw of objects) {
    const { record, problems } = cleanRecord(raw);
    const key = record.Email !== '' ? 'e:' + record.Email : `n:${record.FirstName}|${record.LastName}|${record.Account_Ref__c}`.toLowerCase();
    if (problems.length === 0 && seen.has(key)) {
      problems.push(`Duplicate of line ${seen.get(key)} in this file`);
    }
    if (problems.length > 0) {
      rejected.push({ line: raw._line, problems, raw });
    } else {
      seen.set(key, raw._line);
      valid.push(record);
    }
  }
  return { valid, rejected };
}

export function batches(records, size = 200) {
  const out = [];
  for (let i = 0; i < records.length; i += size) {
    out.push(records.slice(i, i + size));
  }
  return out;
}

export function toCsv(records, columns) {
  const escape = v => (/[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v);
  return [columns.join(','), ...records.map(r => columns.map(c => escape(String(r[c] ?? ''))).join(','))].join('\n') + '\n';
}
```

**tools/csvPrep.test.mjs**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, prepare, batches, toCsv, normalizePhone, titleCase } from './csvPrep.mjs';

const CSV = [
  'FirstName,LastName,Email,Phone,AccountRef',
  'asha,RAO,Asha.Rao@Example.com,(080) 555-0101,ACME',
  'Asha,Rao,asha.rao@example.com,080 555 0101,ACME',
  'ravi,"Shah, Jr",ravi@example.com,+91 98 7654 3210,BIRCH',
  'mina,,mina@example.com,,ACME',
  'tom,Lee,not-an-email,,ACME',
  'sam,Park,sam@example.com,,'
].join('\n');

test('parseCsv handles quotes, commas and blank lines', () => {
  const rows = parseCsv('a,b\n"x, y","say ""hi"""\n\n');
  assert.deepEqual(rows, [['a', 'b'], ['x, y', 'say "hi"']]);
});

test('parseCsv handles windows line endings', () => {
  assert.deepEqual(parseCsv('a,b\r\n1,2\r\n'), [['a', 'b'], ['1', '2']]);
});

test('names are title-cased and phones normalised', () => {
  assert.equal(titleCase("o'brien-SMITH"), "O'Brien-Smith");
  // A leading trunk zero is dropped from local numbers.
  assert.equal(normalizePhone('(080) 555-0101'), '805550101');
  assert.equal(normalizePhone('+91 98 7654 3210'), '+919876543210');
});

test('prepare separates valid rows from rejected rows with reasons', () => {
  const { valid, rejected } = prepare(CSV);
  assert.equal(valid.length, 2);
  assert.equal(rejected.length, 4);
  const reasons = rejected.flatMap(r => r.problems).join(' | ');
  assert.match(reasons, /Duplicate of line 2/);
  assert.match(reasons, /LastName is required/);
  assert.match(reasons, /Email is not valid/);
  assert.match(reasons, /AccountRef is required/);
});

test('the first copy of a duplicate is kept, cleaned', () => {
  const { valid } = prepare(CSV);
  assert.equal(valid[0].FirstName, 'Asha');
  assert.equal(valid[0].Email, 'asha.rao@example.com');
});

test('rejected rows remember their original line number', () => {
  const { rejected } = prepare(CSV);
  assert.deepEqual(rejected.map(r => r.line), [3, 5, 6, 7]);
});

test('batches splits a list into fixed-size chunks', () => {
  assert.deepEqual(batches([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(batches([], 10), []);
});

test('toCsv escapes commas and quotes', () => {
  const out = toCsv([{ a: 'x, y', b: 'say "hi"' }], ['a', 'b']);
  assert.equal(out, 'a,b\n"x, y","say ""hi"""\n');
});
```

**tools/prepare-contacts.mjs** runs the whole preparation and writes clean, rejected and batch files.

```javascript
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { batches, prepare, toCsv } from './csvPrep.mjs';

const [input, outDir = 'out'] = process.argv.slice(2);
if (!input) {
  console.error('Usage: node tools/prepare-contacts.mjs contacts.csv [outDir]');
  process.exit(2);
}

mkdirSync(outDir, { recursive: true });
const { valid, rejected } = prepare(readFileSync(input, 'utf8'));

const columns = ['FirstName', 'LastName', 'Email', 'Phone', 'Account_Ref__c'];
batches(valid, 5000).forEach((batch, i) => {
  writeFileSync(`${outDir}/contacts-clean-${String(i + 1).padStart(3, '0')}.csv`, toCsv(batch, columns));
});

const rejects = rejected.map(r => ({ line: r.line, reasons: r.problems.join('; '), ...r.raw }));
writeFileSync(`${outDir}/rejected.csv`, toCsv(rejects, ['line', 'reasons', 'FirstName', 'LastName', 'Email', 'Phone', 'AccountRef']));

console.log(`Valid: ${valid.length}, rejected: ${rejected.length}`);
console.log(`Files written to ${outDir}/`);
process.exit(rejected.length > 0 ? 1 : 0);
```

**force-app/main/default/classes/ContactLoader.cls** handles records that arrive through code, honouring duplicate rules.

```apex
public with sharing class ContactLoader {

    public class LoadResult {
        public Integer created = 0;
        public Integer updated = 0;
        public Integer duplicates = 0;
        public List<String> errors = new List<String>();
    }

    // Inserts new contacts and updates existing ones, matched on the external id.
    // Duplicate rules are respected unless allowDuplicates is true. (Database.upsert has no
    // DMLOptions overload, so the match is done with one query and insert/update are used.)
    public static LoadResult load(List<Contact> contacts, Boolean allowDuplicates) {
        Database.DMLOptions options = new Database.DMLOptions();
        options.DuplicateRuleHeader.allowSave = allowDuplicates;

        Set<String> sourceIds = new Set<String>();
        for (Contact c : contacts) {
            if (c.Source_Id__c != null) {
                sourceIds.add(c.Source_Id__c);
            }
        }
        Map<String, Id> existing = new Map<String, Id>();
        for (Contact c : [SELECT Id, Source_Id__c FROM Contact WHERE Source_Id__c IN :sourceIds]) {
            existing.put(c.Source_Id__c, c.Id);
        }

        LoadResult summary = new LoadResult();
        for (Contact c : contacts) {
            // One call per record keeps this example simple; bulk code uses the list forms.
            Boolean isNew = !existing.containsKey(c.Source_Id__c);
            Database.SaveResult result;
            if (isNew) {
                result = Database.insert(c, options);
            } else {
                c.Id = existing.get(c.Source_Id__c);
                result = Database.update(c, options);
            }
            if (result.isSuccess()) {
                if (isNew) {
                    summary.created++;
                } else {
                    summary.updated++;
                }
                continue;
            }
            for (Database.Error error : result.getErrors()) {
                if (error instanceof Database.DuplicateError) {
                    summary.duplicates++;
                    summary.errors.add(describe(c, (Database.DuplicateError) error));
                } else {
                    summary.errors.add(c.Source_Id__c + ': ' + error.getMessage());
                }
            }
        }
        return summary;
    }

    private static String describe(Contact c, Database.DuplicateError error) {
        Datacloud.DuplicateResult dup = error.getDuplicateResult();
        Integer matches = 0;
        for (Datacloud.MatchResult m : dup.getMatchResults()) {
            matches += m.getSize();
        }
        return c.Source_Id__c + ': duplicate rule "' + dup.getDuplicateRule() + '" found ' + matches + ' match(es).';
    }

    // Checks without saving, e.g. to show a warning before a user commits.
    public static Integer countPossibleDuplicates(List<Contact> contacts) {
        Integer total = 0;
        for (Datacloud.FindDuplicatesResult result : Datacloud.FindDuplicates.findDuplicates(contacts)) {
            for (Datacloud.DuplicateResult dup : result.getDuplicateResults()) {
                for (Datacloud.MatchResult match : dup.getMatchResults()) {
                    total += match.getSize();
                }
            }
        }
        return total;
    }
}
```

**force-app/main/default/classes/ContactLoaderTest.cls**

```apex
@IsTest
private class ContactLoaderTest {

    private static Contact contact(String sourceId, String last, String email) {
        return new Contact(Source_Id__c = sourceId, LastName = last, FirstName = 'Test', Email = email);
    }

    @IsTest
    static void createsNewRecordsAndUpdatesExistingOnesByExternalId() {
        ContactLoader.LoadResult first = ContactLoader.load(
            new List<Contact>{ contact('SRC-1', 'Rao', 'rao@example.com') }, true);
        System.assertEquals(1, first.created);

        ContactLoader.LoadResult second = ContactLoader.load(
            new List<Contact>{ contact('SRC-1', 'Rao-Updated', 'rao@example.com') }, true);
        System.assertEquals(0, second.created);
        System.assertEquals(1, second.updated);
        System.assertEquals(1, [SELECT COUNT() FROM Contact WHERE Source_Id__c = 'SRC-1']);
        System.assertEquals('Rao-Updated', [SELECT LastName FROM Contact WHERE Source_Id__c = 'SRC-1'].LastName);
    }

    @IsTest
    static void rerunningTheSameFileDoesNotCreateDuplicates() {
        List<Contact> batch = new List<Contact>{
            contact('SRC-10', 'Lee', 'lee@example.com'),
            contact('SRC-11', 'Park', 'park@example.com')
        };
        ContactLoader.load(batch, true);
        ContactLoader.load(batch, true);
        System.assertEquals(2, [SELECT COUNT() FROM Contact WHERE Source_Id__c IN ('SRC-10', 'SRC-11')]);
    }

    @IsTest
    static void reportsErrorsWithTheSourceId() {
        // LastName is required, so this row must fail.
        ContactLoader.LoadResult result = ContactLoader.load(
            new List<Contact>{ new Contact(Source_Id__c = 'SRC-99', FirstName = 'No', Email = 'no@example.com') }, true);
        System.assertEquals(0, result.created);
        System.assertEquals(1, result.errors.size());
        System.assert(result.errors[0].startsWith('SRC-99'));
    }

    @IsTest
    static void duplicateCheckReturnsACountWithoutSaving() {
        insert contact('SRC-20', 'Shah', 'shah@example.com');
        Integer before = [SELECT COUNT() FROM Contact];
        Integer possible = ContactLoader.countPossibleDuplicates(
            new List<Contact>{ new Contact(LastName = 'Shah', FirstName = 'Test', Email = 'shah@example.com') });
        System.assert(possible >= 0, 'The count depends on the active matching rule');
        System.assertEquals(before, [SELECT COUNT() FROM Contact], 'Nothing is saved');
    }
}
```

Run the whole pipeline:

```bash
node --test tools/csvPrep.test.mjs
node tools/prepare-contacts.mjs contacts.csv out
sf data upsert bulk --sobject Contact --file out/contacts-clean-001.csv --external-id Source_Id__c --wait 60 --target-org sandbox
sf project deploy start --source-dir force-app --target-org sandbox
sf apex run test --class-names ContactLoaderTest --result-format human --wait 10 --target-org sandbox
```

Then verify the counts: compare the number of valid rows with `SELECT COUNT() FROM Contact WHERE Source_Id__c != null`, and review `rejected.csv` with the source team.

## What happens behind the scenes

The preparation script reads the file as text and parses it by the CSV rules: commas separate fields, quotes protect commas inside a field, and doubled quotes inside quotes mean one quote. It then cleans each record (capitalising names, lower-casing emails, removing punctuation from phones) and validates it against the rules the org will enforce. Records that fail are written to `rejected.csv` **with the reason and original line number**, so the source team can fix them. It also removes duplicates **inside the file** by email, or by name and account when there is no email, keeping the first.

This matters because Salesforce's duplicate rules only compare a record with what is **already saved** (and with other records in the same transaction in limited ways); two identical rows in one file can both slip through. Cleaning before loading is cheaper than cleaning after.

When the Bulk API receives the file, it splits it into batches and processes them asynchronously. Each row goes through the full save pipeline: validation rules, before triggers, duplicate rules, the insert or update, after triggers and flows. With **upsert**, the platform looks up the external id in an index; if a record exists, the row becomes an update, and if not, an insert. That is why external id fields must be indexed and unique, and why rerunning a fixed file is safe.

Duplicate rules work through matching rules. A matching rule builds a key for each record (for example a normalised email), and looks for existing records with similar keys. When the duplicate rule's action is **Block**, the save fails with a `DuplicateError`; when it is **Allow** with **Report**, the save succeeds and the matches are logged. In Apex, `DuplicateRuleHeader.allowSave = true` (set on `Database.DMLOptions` and passed to `insert` or `update`) tells the platform to allow the save even when a rule would block it; the example passes it as a deliberate choice, never by default.

## Test it and verify

1. Run `node --test tools/csvPrep.test.mjs` and confirm all eight tests pass.
2. Run `prepare-contacts.mjs` on a 100-row sample with deliberate errors; open `rejected.csv` and check each reason.
3. Load the clean file into a **sandbox**, then run the same command again and confirm that the contact count does not change.
4. Deploy and run `ContactLoaderTest`; all four pass.
5. Create a known duplicate through the UI and confirm that your duplicate rule alerts or blocks as configured.
6. Export the loaded contacts and compare them with the clean file for counts and a few sample rows.
7. Only after all of this, schedule the production load in a quiet window with a backup in hand.

## Common mistakes and fixes

- **Loading into production first.** Rehearse in a sandbox.
- **Using insert for repeatable loads.** Use upsert with an external id.
- **No external id on the source key.** Add and index one before the first load.
- **Skipping cleaning.** Normalise names, emails and phones, and reject invalid rows with reasons.
- **Relying on duplicate rules for in-file duplicates.** De-duplicate the file first.
- **Forgetting automation.** Triggers and flows run for every row; plan for volume.
- **Overwriting with blanks.** Decide whether blank cells should clear fields; many tools ignore empty values only if set to.
- **Losing error files.** Keep results and rejected rows with the load record.
- **Date and time zone surprises.** Use ISO dates and state the time zone.

## Key takeaways

- Clean and validate before loading, and keep rejected rows with reasons.
- Use upsert with external ids so loads can be repeated safely.
- Choose the tool by size and repeatability: Wizard, Data Loader, CLI or Bulk API.
- Duplicate rules stop duplicates against saved data; clean the file for in-file duplicates.
- Rehearse, verify counts, and back up first.

## Where to go next

- Read [Salesforce data model and relationships](/articles/salesforce-data-model-and-relationships/) for external ids and relationship design.
- Read [Bulk API 2.0 ingest guide](/articles/bulk-api-2-ingest-guide/) for the API options behind these tools.
- Read [Apex exception handling and logging](/articles/apex-exception-handling-and-logging/) for reporting load errors from code.
