---
title: "Data Cloud Fundamentals: Data Streams, Data Model, Identity Resolution, Insights and Segments"
description: "Understand Salesforce Data Cloud end to end: ingest data streams, map to the data model, resolve identities, build insights and segments, with a runnable identity model."
category: salesforce-development
tags: [Data Cloud, Data Model, Identity Resolution, Intermediate]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce Help: Data Cloud"
    url: "https://help.salesforce.com/s/articleView?id=sf.c360_a_data_cloud.htm"
  - title: "Data Cloud Developer Guide"
    url: "https://developer.salesforce.com/docs/data/data-cloud-int/guide/dc-introduction.html"
---

Customer data usually lives in many places: the CRM, a web store, a support tool, a marketing platform. Data Cloud brings it into one platform, links the records that belong to the same person, and makes the result usable for segments, analytics, automation and AI agents. This article explains the building blocks in the order you meet them, and includes a small program that behaves like identity resolution so you can see why records link.

> Data Cloud screens, object names and API paths change between releases and depend on your licence. Use Setup and the current help for the exact steps. The identity model, tests and SQL below are written so you can understand and run the logic yourself, but the SQL needs your own object and field names.

## The business scenario

Juniper Consulting sells training online and through account managers. Asha Rao appears in the CRM as a contact, in the web store as a guest buyer with a slightly different email format, and in the event system with only a phone number. Marketing sends her three different emails for the same webinar, support does not see her purchases, and nobody can count customers correctly. The goal: one profile per person, a list of "people who bought training in the last 90 days and have an open case", and the ability to use that list in marketing and in an Agentforce agent.

## Before you start: setup

### In Salesforce

1. **Licence and provisioning.** Data Cloud is a separately licensed product. In a Developer Edition or a trial org, check that Data Cloud is provisioned (Setup, search "Data Cloud"). Provisioning can take a while and is done by the admin or Salesforce, so confirm before you plan anything else.
2. **Permissions.** Assign the Data Cloud permission sets (Admin, Data Aware Specialist, Marketing roles) to the people who will build and use it. Do not give everyone the admin set.
3. **Connect sources.** For the CRM, use the **Salesforce CRM connector** (choose the objects, such as Contact, Account, Case). For files and databases, use **Amazon S3**, **Google Cloud Storage**, the **Ingestion API** or **MuleSoft** connectors as available.
4. **Decide the data model up front.** Data Cloud uses a standard model with objects like **Individual**, **Contact Point Email**, **Contact Point Phone**, **Sales Order** and **Case**. Plan how each source field maps to it.
5. **Consent and privacy.** Decide which consent fields you will ingest, and how they will be respected in segments and activations. Involve legal early.
6. **Test data.** Prepare a small, realistic sample from each source (a few hundred rows), including some deliberate overlaps like the Asha Rao example.

### In the external system

1. For the web store and event system, agree on a **file or API contract**: a stable primary key per record, an **updated timestamp**, UTF-8 CSV or JSON, one row per customer or per order.
2. If you use the **Ingestion API**, create a connected app or External Client App with the scopes the Data Cloud documentation names, and store credentials in the sending system's secret store.
3. For files in cloud storage, create a **read-only** access identity for Data Cloud and restrict it to the specific folder.
4. Decide the **frequency**: streaming for events, daily batch for orders, and who owns fixing bad rows in the source.

## How it works

The flow has six stages:

1. **Data streams** bring data in. Each stream creates a **Data Lake Object (DLO)**: a raw copy of the source table, stored as it arrived.
2. **Mapping** connects a DLO's fields to **Data Model Objects (DMOs)**: the standard, harmonised model (Individual, Contact Point Email, and so on). Mapping is where "e-mail", "Email" and "contact_mail" become one field.
3. **Identity resolution** links DMO records that describe the same person. **Match rules** decide what counts as the same (exact email, or similar name plus phone). **Reconciliation rules** decide which value wins when linked records disagree (most recent, most frequent, source priority). The output is a **Unified Individual** and a link table showing which source profiles it contains.
4. **Insights** calculate metrics over the unified data. A **Calculated Insight** is a SQL-based measure such as "lifetime spend per customer"; **streaming insights** react in near real time.
5. **Segments** select people by rules ("bought training in 90 days AND has an open case"), refreshed on a schedule or near real time.
6. **Activation and actions** send segments and data to other places: marketing channels, an advertising platform, a Salesforce flow, or an agent via **data actions** and **data graphs** that provide fast access to unified data.

Two ideas to remember. First, Data Cloud is **not** just a bigger database: raw data stays in DLOs and the harmonised view is created by mapping, so you can remap without reloading. Second, **identity resolution is rule-driven and tunable**: tight rules miss duplicates, loose rules merge different people, and the right balance depends on your data.

## Basic example

A simple question on the unified data, written in the SQL that Data Cloud's query tools accept. The object and field names follow the standard model; check yours in the Data Explorer.

```sql
-- Count unified individuals by whether they have an email contact point
SELECT
  COUNT(DISTINCT ui.ssot__Id__c) AS people,
  COUNT(DISTINCT ce.ssot__PartyId__c) AS with_email
FROM UnifiedIndividual__dlm ui
LEFT JOIN ContactPointEmail__dlm ce
  ON ce.ssot__PartyId__c = ui.ssot__Id__c;
```

The `__dlm` suffix marks a Data Model Object; `ssot__` marks fields of the standard model. Your own custom DMOs use `__dlm` with your field names.

## Advanced end-to-end example

First the identity model: a program that does what match and reconciliation rules do, so you can experiment before changing real rules.

**tools/identity.mjs**

```javascript
// A small model of Data Cloud identity resolution: match rules link source profiles
// into unified profiles, and reconciliation rules choose each unified field's value.

export function normalizeEmail(value) {
  return (value ?? '').trim().toLowerCase();
}

export function normalizePhone(value) {
  const digits = (value ?? '').replace(/\D/g, '');
  return digits.length > 10 ? digits.slice(-10) : digits;
}

export function normalizeName(value) {
  return (value ?? '').trim().toLowerCase().replace(/[^a-z]/g, '');
}

// Each rule returns a key for a profile, or null if the profile lacks the data.
export const MATCH_RULES = {
  exactEmail: p => (normalizeEmail(p.email) ? 'email:' + normalizeEmail(p.email) : null),
  namePhone: p => {
    const phone = normalizePhone(p.phone);
    const name = normalizeName(p.lastName) + normalizeName(p.firstName).slice(0, 1);
    return phone.length >= 7 && name.length >= 2 ? `np:${name}:${phone}` : null;
  }
};

class UnionFind {
  constructor(size) {
    this.parent = Array.from({ length: size }, (_, i) => i);
  }
  find(i) {
    while (this.parent[i] !== i) {
      this.parent[i] = this.parent[this.parent[i]];
      i = this.parent[i];
    }
    return i;
  }
  union(a, b) {
    this.parent[this.find(a)] = this.find(b);
  }
}

export function resolve(profiles, ruleNames = Object.keys(MATCH_RULES)) {
  const sets = new UnionFind(profiles.length);
  for (const ruleName of ruleNames) {
    const rule = MATCH_RULES[ruleName];
    if (!rule) {
      throw new Error('Unknown match rule: ' + ruleName);
    }
    const seen = new Map();
    profiles.forEach((profile, index) => {
      const key = rule(profile);
      if (key === null) {
        return;
      }
      if (seen.has(key)) {
        sets.union(index, seen.get(key));
      } else {
        seen.set(key, index);
      }
    });
  }

  const groups = new Map();
  profiles.forEach((profile, index) => {
    const root = sets.find(index);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root).push(profile);
  });
  return [...groups.values()];
}

// Reconciliation: most recent non-empty value wins; ties keep the first source listed.
export function reconcile(group, fields = ['firstName', 'lastName', 'email', 'phone']) {
  const newestFirst = [...group].sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
  const unified = { sources: group.map(p => `${p.source}:${p.id}`).sort() };
  for (const field of fields) {
    const winner = newestFirst.find(p => (p[field] ?? '').trim() !== '');
    unified[field] = winner ? winner[field].trim() : '';
  }
  return unified;
}

export function unify(profiles, ruleNames) {
  return resolve(profiles, ruleNames).map(group => reconcile(group));
}
```

**tools/identity.test.mjs**

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, resolve, unify } from './identity.mjs';

const PROFILES = [
  { source: 'crm', id: 'C1', firstName: 'Asha', lastName: 'Rao', email: 'Asha.Rao@Example.com', phone: '+91 98765 43210', updated: '2026-01-10' },
  { source: 'web', id: 'W7', firstName: 'A.', lastName: 'Rao', email: 'asha.rao@example.com', phone: '', updated: '2026-03-01' },
  { source: 'shop', id: 'S3', firstName: 'Asha', lastName: 'Rao', email: '', phone: '9876543210', updated: '2026-02-01' },
  { source: 'crm', id: 'C2', firstName: 'Ravi', lastName: 'Shah', email: 'ravi@example.com', phone: '', updated: '2026-01-05' }
];

test('phone numbers compare on their last ten digits', () => {
  assert.equal(normalizePhone('+91 98765 43210'), '9876543210');
});

test('exact email alone links the CRM and web profiles', () => {
  const groups = resolve(PROFILES, ['exactEmail']);
  assert.equal(groups.length, 3);
});

test('adding the name and phone rule links the shop profile too', () => {
  const groups = resolve(PROFILES);
  assert.equal(groups.length, 2);
  const asha = groups.find(g => g.length === 3);
  assert.deepEqual(asha.map(p => p.source).sort(), ['crm', 'shop', 'web']);
});

test('links are transitive across rules', () => {
  // web links to crm by email, shop links to crm by name and phone.
  const merged = resolve(PROFILES).find(g => g.some(p => p.source === 'shop'));
  assert.ok(merged.some(p => p.source === 'web'));
});

test('profiles with no usable data stay separate', () => {
  const groups = resolve([
    { source: 'a', id: '1', firstName: '', lastName: '', email: '', phone: '' },
    { source: 'b', id: '2', firstName: '', lastName: '', email: '', phone: '' }
  ]);
  assert.equal(groups.length, 2);
});

test('reconciliation takes the newest non-empty value per field', () => {
  const unified = unify(PROFILES).find(u => u.lastName === 'Rao');
  assert.equal(unified.firstName, 'A.');                 // newest profile (web) wins
  assert.equal(unified.email, 'asha.rao@example.com');   // newest non-empty
  assert.equal(unified.phone, '9876543210');             // web is blank, shop is next newest
  assert.equal(unified.sources.length, 3);
});

test('an unknown rule name is rejected', () => {
  assert.throws(() => resolve(PROFILES, ['magic']), /Unknown match rule/);
});
```

Run it:

```bash
node --test tools/identity.test.mjs
```

Then the **calculated insight** and **segment** logic, written in SQL. Create them through the Calculated Insights and Segmentation tools in Data Cloud; the SQL expresses the idea and must be adapted to your object names.

```sql
-- Calculated insight: lifetime value per unified individual
SELECT
  ui.ssot__Id__c           AS individual_id__c,
  SUM(so.ssot__GrandTotalAmount__c) AS lifetime_value__c,
  COUNT(so.ssot__Id__c)    AS order_count__c,
  MAX(so.ssot__OrderedDate__c) AS last_order_date__c
FROM UnifiedIndividual__dlm ui
JOIN SalesOrder__dlm so
  ON so.ssot__SoldToCustomerId__c = ui.ssot__Id__c
GROUP BY ui.ssot__Id__c;
```

```sql
-- Segment idea: bought training in the last 90 days AND has an open case
SELECT ui.ssot__Id__c
FROM UnifiedIndividual__dlm ui
WHERE ui.ssot__Id__c IN (
        SELECT so.ssot__SoldToCustomerId__c
        FROM SalesOrder__dlm so
        WHERE so.ssot__OrderedDate__c >= CURRENT_DATE - INTERVAL '90' DAY)
  AND ui.ssot__Id__c IN (
        SELECT c.ssot__AccountId__c
        FROM Case__dlm c
        WHERE c.ssot__Status__c <> 'Closed');
```

A mapping plan keeps the team aligned; keep it in version control next to the data contract.

```yaml
sources:
  - name: crm_contacts
    stream: Salesforce CRM / Contact
    key: Id
    updated: SystemModstamp
    maps_to: Individual
    fields:
      FirstName: ssot__FirstName__c
      LastName: ssot__LastName__c
      Email: ContactPointEmail.ssot__EmailAddress__c
      Phone: ContactPointPhone.ssot__TelephoneNumber__c
  - name: web_store_orders
    stream: Ingestion API / orders
    key: order_id
    updated: modified_at
    maps_to: SalesOrder
    fields:
      order_id: ssot__Id__c
      customer_email: ContactPointEmail.ssot__EmailAddress__c
      total: ssot__GrandTotalAmount__c
      ordered_at: ssot__OrderedDate__c
identity_resolution:
  match_rules:
    - exact email
    - last name + first initial + phone (normalised)
  reconciliation:
    default: most recent
    email: most recent non-empty
    phone: source priority [crm_contacts, web_store_orders]
```

## What happens behind the scenes

When a data stream refreshes, Data Cloud reads the new and changed rows (using the key and updated timestamp), and writes them to the **Data Lake Object**. The DLO is stored in a data lake format that can hold very large volumes cheaply, which is why Data Cloud can keep the full raw history.

**Mapping** is applied logically: the DMO is a view over one or more DLOs, so changing a mapping changes the harmonised data without reloading the raw data. Harmonised records then feed identity resolution.

Identity resolution runs as a **scheduled process**, not instantly on every record. It builds keys from the match rules (the program above uses the same idea: a normalised email, or last name plus first initial plus phone), groups profiles that share a key, and then **joins groups transitively**. That last point is important in the test: the web profile links to the CRM profile by email, and the shop profile links to the CRM profile by name and phone, so all three end up in one unified profile even though web and shop share nothing directly. The program uses a **union-find** structure to merge groups, the standard technique for this problem.

Reconciliation then builds one record. Sorting by updated time and taking the first non-empty value per field is the "most recent" rule. Different fields can use different rules: here the phone number comes from the shop profile because the newest profile (web) had none. The result is the Unified Individual, with a link table that records which source profiles it contains, so nothing is lost and a bad merge can be undone by changing the rules.

Calculated insights and segments are **SQL over the unified data**, executed by the platform's engine at scale on a schedule. Their results are stored and can be read quickly by activations and agents. Because they depend on identity resolution, a change in match rules changes segment membership at the next run.

## Test it and verify

1. Run `node --test tools/identity.test.mjs` and confirm all seven tests pass.
2. Change a rule in the program (for example remove the phone rule) and see which tests fail. That is how rule changes affect real data.
3. In your Data Cloud org, ingest a small sample from two sources with overlapping people. After mapping, run identity resolution and open a **Unified Individual** to see its linked profiles.
4. Run the calculated insight on the sample and compare the totals with the source system's own numbers.
5. Build the segment, check its size, and spot check five people by hand.
6. Review consent: confirm that people who opted out are not in the activation.

## Common mistakes and fixes

- **Loading everything.** Ingest only what a use case needs; cost and complexity follow volume.
- **Poor keys and timestamps.** Without a stable key and an updated time, refreshes duplicate or miss rows.
- **Loose match rules.** Matching on name alone merges different people. Prefer exact identifiers, then add fuzzy rules carefully.
- **Tight match rules.** If email formats differ, normalise before matching.
- **Not reviewing merges.** Sample unified profiles for false merges after each rule change.
- **Ignoring consent.** Ingest consent and apply it in segments and activations.
- **Treating mapping as a one-time task.** Mapping is configuration; keep it documented and versioned.
- **Expecting instant results.** Identity resolution, insights and segments run on schedules.

## Key takeaways

- Data streams fill Data Lake Objects, and mapping harmonises them into the data model.
- Identity resolution uses match rules to link and reconciliation rules to choose values.
- Insights and segments are SQL over unified data, refreshed on a schedule.
- Good keys, timestamps and normalised fields matter more than volume.
- Test rules on a sample and review merges before trusting them.

## Where to go next

- Read [Salesforce data model and relationships](/articles/salesforce-data-model-and-relationships/) for how CRM objects relate before they reach Data Cloud.
- Read [Data import, export and duplicate management](/articles/data-import-export-and-duplicate-management/) for cleaning data at the source.
- Read [Prompt Builder templates guide](/articles/prompt-builder-templates-guide/) for using unified data in generative AI.
