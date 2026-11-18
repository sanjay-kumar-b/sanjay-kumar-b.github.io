---
title: "External Services and Salesforce Connect: Integrating Without Writing Code"
description: "Turn an OpenAPI spec into Flow actions with External Services, and show live external data with Salesforce Connect and a custom Apex adapter."
category: salesforce-administration
tags: [Integration, External Services, Salesforce Connect, Intermediate]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/external-services-and-salesforce-connect.jpg
sources:
  - title: "Salesforce Help: External Services"
    url: "https://help.salesforce.com/s/products/platform"
  - title: "Salesforce Connect Developer Documentation"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

Two Salesforce features let you integrate with little or no Apex. **External Services** turns an API's OpenAPI description into actions you can drop into Flow. **Salesforce Connect** shows data that lives in another system as **External Objects**, fetched live instead of copied. This article explains both, then builds a working example of each, including a custom adapter for the case where no standard adapter fits.

## The business scenario

Fernhill Clinics (a fictional clinic group) wants two things. When a receptionist enters a patient address in a screen flow, it should be validated against an address service without any developer involved. And the clinic's billing system holds 4 million invoices that agents must see on the patient's page, but the data must not be copied into Salesforce for privacy and storage reasons.

## Before you start: setup

### In Salesforce

1. Create an **External Credential** and a **Named Credential** named `Address_API` pointing at the address service. Add a principal with the API key and give a permission set access to that principal. The callouts article describes each step.
2. For Salesforce Connect, confirm your org has the licence. It is sold separately, so check with your account team.
3. Create a Named Credential `Billing_API` for the billing service.
4. Create a permission set that grants the integration users access to the External Data Source and the external object.
5. Do everything in a sandbox first. Menu names change between releases, so follow the current Salesforce Help pages for the exact clicks.

### In the external system

1. The address service must publish an **OpenAPI 3** description (YAML or JSON) that is reachable or can be pasted in.
2. The billing service must expose a list endpoint, a single-record endpoint and ideally filtering, with a stable unique id on each invoice.
3. Both services need an API key or OAuth client dedicated to Salesforce, with read-only rights.

## How it works

**External Services.** You register an API by giving Salesforce its OpenAPI schema and a Named Credential. Salesforce turns each operation into an **invocable action**. In Flow you add an **Action** element, pick the generated action, and map inputs and outputs. Agent actions can use the same actions.

**Salesforce Connect.** You define an **External Data Source**, then choose which tables to sync as **External Objects** with names ending in `__x`. Users see them in lists, related lists, reports and search, but each view fetches the data on demand.

Adapters for Salesforce Connect:

- **OData 2.0 and 4.0** for OData-compliant services.
- **Cross-org** for another Salesforce org.
- **Custom adapter** built with the Apex Connector Framework when the API is something else.

Choosing between them:

| Need | Use |
|---|---|
| Call an API from a Flow | External Services |
| Display external records inside Salesforce | Salesforce Connect |
| Copy data in bulk | Bulk API 2.0 or middleware |
| Complex logic or retries | Apex callouts |

## Basic example

A minimal OpenAPI description for the address service. Register it in **Setup > External Services** using the `Address_API` Named Credential.

```yaml
openapi: 3.0.3
info:
  title: Address Validation
  version: 1.0.0
paths:
  /validate:
    post:
      operationId: validateAddress
      summary: Validate and normalise an address
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [street, city, postcode]
              properties:
                street: { type: string }
                city: { type: string }
                postcode: { type: string }
      responses:
        '200':
          description: Result
          content:
            application/json:
              schema:
                type: object
                properties:
                  valid: { type: boolean }
                  normalised: { type: string }
```

After import you will have an action named after `validateAddress`. In a screen flow, add the action after the address screen, map `street`, `city` and `postcode`, and branch on the `valid` output.

## Advanced end-to-end example

First, a tiny mock of the address service so you can import and test the spec before the real vendor is ready:

**mock/address-server.mjs** (run with `node mock/address-server.mjs`)

```javascript
import { createServer } from 'node:http';

createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/validate') {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const a = JSON.parse(body || '{}');
      const valid = Boolean(a.street && a.city && /^[A-Za-z0-9 ]{3,8}$/.test(a.postcode || ''));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ valid, normalised: valid ? `${a.street}, ${a.city} ${a.postcode.toUpperCase()}` : '' }));
    });
    return;
  }
  res.writeHead(404).end();
}).listen(8080, () => console.log('Address mock on :8080'));
```

Now the custom Salesforce Connect adapter for the invoices. It has a provider, a connection that describes the table and answers queries, and a helper you can unit test.

**force-app/main/default/classes/BillingDataSourceProvider.cls**

```apex
global class BillingDataSourceProvider extends DataSource.Provider {

    override global List<DataSource.AuthenticationCapability> getAuthenticationCapabilities() {
        return new List<DataSource.AuthenticationCapability>{
            DataSource.AuthenticationCapability.ANONYMOUS
        };
    }

    override global List<DataSource.Capability> getCapabilities() {
        return new List<DataSource.Capability>{
            DataSource.Capability.ROW_QUERY
        };
    }

    override global DataSource.Connection getConnection(DataSource.ConnectionParams params) {
        return new BillingDataSourceConnection(params);
    }
}
```

**force-app/main/default/classes/BillingDataSourceConnection.cls**

```apex
global class BillingDataSourceConnection extends DataSource.Connection {

    private final DataSource.ConnectionParams params;

    global BillingDataSourceConnection(DataSource.ConnectionParams params) {
        this.params = params;
    }

    // Describes the external object that will be created from this source.
    override global List<DataSource.Table> sync() {
        List<DataSource.Column> columns = new List<DataSource.Column>{
            DataSource.Column.text('ExternalId', 255),
            DataSource.Column.url('DisplayUrl'),
            DataSource.Column.text('InvoiceNumber', 80),
            DataSource.Column.text('Status', 40),
            DataSource.Column.number('Amount', 16, 2)
        };
        return new List<DataSource.Table>{
            DataSource.Table.get('Invoice', 'InvoiceNumber', columns)
        };
    }

    // Called every time a user opens a list or related list.
    override global DataSource.TableResult query(DataSource.QueryContext context) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Billing_API/invoices?limit=100');
        req.setMethod('GET');
        req.setTimeout(8000);
        HttpResponse res = new Http().send(req);
        if (res.getStatusCode() != 200) {
            throw new DataSource.OAuthTokenExpiredException(
                'Billing service returned ' + res.getStatusCode());
        }
        return DataSource.TableResult.get(context, BillingRows.fromJson(res.getBody()));
    }
}
```

**force-app/main/default/classes/BillingRows.cls**

```apex
public with sharing class BillingRows {

    public static List<Map<String, Object>> fromJson(String body) {
        List<Map<String, Object>> rows = new List<Map<String, Object>>();
        List<Object> items = (List<Object>) JSON.deserializeUntyped(body);
        for (Object o : items) {
            Map<String, Object> item = (Map<String, Object>) o;
            String id = String.valueOf(item.get('id'));
            rows.add(new Map<String, Object>{
                'ExternalId' => id,
                'DisplayUrl' => 'https://billing.example.com/invoices/' + id,
                'InvoiceNumber' => item.get('number'),
                'Status' => item.get('status'),
                'Amount' => item.get('amount')
            });
        }
        return rows;
    }
}
```

**force-app/main/default/classes/BillingRowsTest.cls**

```apex
@IsTest
private class BillingRowsTest {

    @IsTest
    static void mapsApiItemsToExternalRows() {
        String body = '[{"id":"9001","number":"INV-9001","status":"Paid","amount":120.5},'
            + '{"id":"9002","number":"INV-9002","status":"Overdue","amount":80}]';
        List<Map<String, Object>> rows = BillingRows.fromJson(body);
        System.assertEquals(2, rows.size());
        System.assertEquals('9001', rows[0].get('ExternalId'));
        System.assertEquals('INV-9002', rows[1].get('InvoiceNumber'));
        System.assert(String.valueOf(rows[0].get('DisplayUrl')).endsWith('/9001'));
    }

    @IsTest
    static void emptyResponseGivesNoRows() {
        System.assertEquals(0, BillingRows.fromJson('[]').size());
    }

    @IsTest
    static void providerDeclaresRowQuery() {
        BillingDataSourceProvider p = new BillingDataSourceProvider();
        System.assert(p.getCapabilities().contains(DataSource.Capability.ROW_QUERY));
    }

    @IsTest
    static void syncDescribesTheInvoiceTable() {
        BillingDataSourceConnection c = new BillingDataSourceConnection(null);
        List<DataSource.Table> tables = c.sync();
        System.assertEquals(1, tables.size());
        System.assertEquals('Invoice', tables[0].name);
    }
}
```

Then, in Setup, create an **External Data Source** of type **Apex Connector Framework**, select `BillingDataSourceProvider`, validate and sync, and grant the permission set access to the new `Invoice__x` object.

## What happens behind the scenes

When a flow runs an imported action, Salesforce builds the HTTP request from the OpenAPI definition, sends it through the Named Credential (which adds authentication), parses the JSON response against the schema, and exposes the fields as flow variables. Callout limits still apply, so a flow that loops over many records and calls the action each time will hit them. If a response does not match the schema, the action can fail even though the HTTP call succeeded.

With Salesforce Connect, a user opening the Invoices related list causes Salesforce to call your connection's `query` method. Your code returns rows and Salesforce renders them like any other records. Nothing is stored, so there is no sync to maintain, but every page view costs a call to the billing system, and its speed becomes the page's speed. External objects also support fewer features than standard objects, so reports, triggers and flows have restrictions.

## Test it and verify

1. Run `node mock/address-server.mjs`, expose it through a tunnel or a test host, and point `Address_API` at it. Import the OpenAPI file and confirm the `validateAddress` action appears.
2. Build a screen flow with the action, then test a valid and an invalid postcode. Confirm the branch works and that a fault path shows a friendly message when the mock is stopped.
3. Deploy the Apex classes and run `BillingRowsTest`.
4. Create the External Data Source, validate it, sync the `Invoice` table and open the `Invoice__x` list view as a test user.
5. Add the invoices as a related list on the Account page layout.

## Common mistakes and fixes

- **Skipping fault paths in the flow.** Users see a raw error when the API is down. Add a fault connector with a helpful message.
- **Assuming any schema imports cleanly.** Complex schemas may fail. Test the import in a sandbox and simplify the spec if needed.
- **Calling an action inside a loop.** You hit callout limits. Collect the records and call once, or use Apex.
- **Using Salesforce Connect for heavy reporting.** Data must be fetched each time. Copy the data if you need analytics.
- **Forgetting the permission set.** Users cannot see external objects until they are granted access.
- **No dedicated integration identity.** Use a least-privilege account for the service.

## Key takeaways

- External Services turns an OpenAPI spec into Flow actions, with no Apex.
- Salesforce Connect shows external data live as `__x` objects without copying it.
- A custom Apex adapter covers APIs that have no standard adapter.
- Both depend on the speed and uptime of the other system, so plan timeouts and fault paths.
- Choose by need: Flow action, live view, bulk copy, or Apex for complex logic.

## Where to go next

- Read [REST callouts with Named Credentials](/articles/rest-callouts-named-credentials/) for the credentials setup used here.
- Read [Cross-system integration patterns](/articles/cross-system-integration-patterns/) to choose between virtualization and copying.
- Read [Middleware integrations guide](/articles/middleware-integrations-guide/) for heavier orchestration.
