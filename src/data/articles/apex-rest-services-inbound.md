---
title: "Building Custom Apex REST Services for Inbound Integrations"
description: "Expose your own REST endpoint with @RestResource: idempotent upserts, validation, versioned URLs, security, partner setup and full tests."
category: salesforce-development
tags: [REST API, Apex, Integration, Intermediate]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/apex-rest-services-inbound.jpg
sources:
  - title: "Apex REST (Apex Developer Guide)"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_rest.htm"
  - title: "RestRequest and RestResponse classes"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_class_System_RestRequest.htm"
---

Standard REST handles create, read, update and delete on one record at a time. Build an Apex REST service when a caller needs **business logic in a single call**, such as "create an order with its lines and reserve stock". In this article you build a small partner order API, first in its simplest form and then as a production-style service that is safe to retry.

## The business scenario

Northwind Outfitters (a fictional wholesaler) lets partner shops submit orders from their own systems. A partner may send the same order twice because of a network timeout, and one bad line must not leave half an order behind. The service must accept a JSON order, create or update the order and its lines in one transaction, return clear error messages, and be callable only by approved integration users.

## Before you start: setup

### In Salesforce

1. Create the custom objects. `Partner_Order__c` needs a text field `External_Id__c` (External ID and Unique, case sensitive), a lookup to Account, and a text field `Status__c`. `Partner_Order_Line__c` is a master-detail child of the order with `Sku__c` (text) and `Quantity__c` (number).
2. Create an **integration user** with a dedicated user license suitable for API access, and assign a permission set that grants the **Apex Class Access** for `PartnerOrderApi` plus create and edit on both objects. Never reuse a human administrator.
3. Decide how the partner authenticates. For server-to-server calls use an OAuth client credentials flow through an external client app, described in the OAuth article. The partner receives an access token and sends it as a bearer header.
4. Deploy to a sandbox or scratch org first, because Apex tests must pass before production.

### In the external system

1. Store the Salesforce **My Domain URL**, client id and secret in the partner's secret store, not in source code.
2. Generate a stable order number in the partner system. It becomes `externalId`, the key that makes retries safe.
3. Make the partner client retry only on timeouts, `429` and `5xx`, and never on `400`.

## How it works

A class annotated with `@RestResource(urlMapping='/partner/v1/orders/*')` becomes reachable at `/services/apexrest/partner/v1/orders/`. Each method you annotate with `@HttpPost`, `@HttpGet`, `@HttpPut`, `@HttpPatch` or `@HttpDelete` handles that verb. Inside the method, `RestContext.request` gives you headers and the body, and `RestContext.response` lets you set the status code.

Three design rules keep a service dependable:

- **Parse into typed classes** with `JSON.deserialize`, then validate. Never trust the payload.
- **Use an upsert on an External ID** so a repeated request updates instead of duplicating.
- **Keep the transaction atomic** with a savepoint so a failed line rolls everything back.

The URL carries a version (`/v1/`). When you must change the contract in a breaking way, publish `/v2/` and leave `/v1/` alone for existing partners.

## Basic example

The smallest useful service accepts an Account name and returns its Id.

```apex
@RestResource(urlMapping='/demo/v1/accounts/*')
global with sharing class DemoAccountApi {

    global class Request {
        public String name;
    }

    @HttpPost
    global static String createAccount() {
        Request req = (Request) JSON.deserialize(
            RestContext.request.requestBody.toString(), Request.class);
        Account a = new Account(Name = req.name);
        insert a;
        return a.Id;
    }
}
```

Call it with curl after getting a token:

```bash
curl -X POST "https://YOUR_DOMAIN.my.salesforce.com/services/apexrest/demo/v1/accounts/" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"Acme Test"}'
```

This works, but it has no validation, no error handling, no idempotency and returns a bare string. The advanced version fixes all of that.

## Advanced end-to-end example

The service below has a contract class, a validator, a service class with all the database work, a thin REST class, and tests.

**force-app/main/default/classes/PartnerOrderDto.cls**

```apex
public with sharing class PartnerOrderDto {

    public class Line {
        public String sku;
        public Integer quantity;
    }

    public class Request {
        public String externalId;
        public String accountExternalNumber;
        public List<Line> lines;
    }

    public class Response {
        public Boolean success;
        public String orderId;
        public String externalId;
        public String message;
        public List<String> errors = new List<String>();
    }
}
```

**force-app/main/default/classes/PartnerOrderValidator.cls**

```apex
public with sharing class PartnerOrderValidator {

    public static final Integer MAX_LINES = 200;

    public static List<String> validate(PartnerOrderDto.Request req) {
        List<String> errors = new List<String>();
        if (req == null) {
            errors.add('Request body is required.');
            return errors;
        }
        if (String.isBlank(req.externalId)) {
            errors.add('externalId is required.');
        }
        if (String.isBlank(req.accountExternalNumber)) {
            errors.add('accountExternalNumber is required.');
        }
        if (req.lines == null || req.lines.isEmpty()) {
            errors.add('At least one line is required.');
            return errors;
        }
        if (req.lines.size() > MAX_LINES) {
            errors.add('A maximum of ' + MAX_LINES + ' lines is allowed.');
        }
        Integer index = 0;
        for (PartnerOrderDto.Line line : req.lines) {
            index++;
            if (String.isBlank(line.sku)) {
                errors.add('Line ' + index + ': sku is required.');
            }
            if (line.quantity == null || line.quantity <= 0) {
                errors.add('Line ' + index + ': quantity must be greater than zero.');
            }
        }
        return errors;
    }
}
```

**force-app/main/default/classes/PartnerOrderService.cls**

```apex
public with sharing class PartnerOrderService {

    public class OrderException extends Exception {}

    public static PartnerOrderDto.Response upsertOrder(PartnerOrderDto.Request req) {
        PartnerOrderDto.Response res = new PartnerOrderDto.Response();
        res.externalId = req.externalId;

        List<Account> accounts = [
            SELECT Id FROM Account
            WHERE AccountNumber = :req.accountExternalNumber
            WITH USER_MODE
            LIMIT 1
        ];
        if (accounts.isEmpty()) {
            throw new OrderException('Unknown account ' + req.accountExternalNumber);
        }

        Savepoint sp = Database.setSavepoint();
        try {
            Partner_Order__c order = new Partner_Order__c(
                External_Id__c = req.externalId,
                Account__c = accounts[0].Id,
                Status__c = 'Received'
            );
            Database.UpsertResult ur = Database.upsert(
                order, Partner_Order__c.External_Id__c, true, AccessLevel.USER_MODE);
            res.orderId = order.Id;

            // Replace lines so a retry with changed quantities stays correct.
            delete [
                SELECT Id FROM Partner_Order_Line__c WHERE Order__c = :order.Id
            ];

            List<Partner_Order_Line__c> lines = new List<Partner_Order_Line__c>();
            for (PartnerOrderDto.Line line : req.lines) {
                lines.add(new Partner_Order_Line__c(
                    Order__c = order.Id,
                    Sku__c = line.sku,
                    Quantity__c = line.quantity
                ));
            }
            insert as user lines;

            res.success = true;
            res.message = ur.isCreated() ? 'Order created.' : 'Order updated.';
            return res;
        } catch (Exception e) {
            Database.rollback(sp);
            throw new OrderException(e.getMessage());
        }
    }
}
```

**force-app/main/default/classes/PartnerOrderApi.cls**

```apex
@RestResource(urlMapping='/partner/v1/orders/*')
global with sharing class PartnerOrderApi {

    @HttpPost
    global static void post() {
        RestResponse http = RestContext.response;
        http.addHeader('Content-Type', 'application/json');
        PartnerOrderDto.Response res = new PartnerOrderDto.Response();

        PartnerOrderDto.Request req;
        try {
            String body = RestContext.request.requestBody == null
                ? '' : RestContext.request.requestBody.toString();
            req = (PartnerOrderDto.Request) JSON.deserialize(
                body, PartnerOrderDto.Request.class);
        } catch (Exception e) {
            http.statusCode = 400;
            res.success = false;
            res.message = 'Body is not valid JSON.';
            http.responseBody = Blob.valueOf(JSON.serialize(res));
            return;
        }

        List<String> errors = PartnerOrderValidator.validate(req);
        if (!errors.isEmpty()) {
            http.statusCode = 400;
            res.success = false;
            res.message = 'Validation failed.';
            res.errors = errors;
            http.responseBody = Blob.valueOf(JSON.serialize(res));
            return;
        }

        try {
            res = PartnerOrderService.upsertOrder(req);
            http.statusCode = 200;
        } catch (PartnerOrderService.OrderException e) {
            http.statusCode = 422;
            res.success = false;
            res.externalId = req.externalId;
            res.message = e.getMessage();
        } catch (Exception e) {
            http.statusCode = 500;
            res.success = false;
            res.message = 'Unexpected error. Quote this externalId when contacting support.';
            System.debug(LoggingLevel.ERROR, e.getMessage() + ' ' + e.getStackTraceString());
        }
        http.responseBody = Blob.valueOf(JSON.serialize(res));
    }

    @HttpGet
    global static void get() {
        RestResponse http = RestContext.response;
        http.addHeader('Content-Type', 'application/json');
        String path = RestContext.request.requestURI;
        String externalId = path.substringAfterLast('/');
        List<Partner_Order__c> rows = [
            SELECT Id, External_Id__c, Status__c
            FROM Partner_Order__c
            WHERE External_Id__c = :externalId
            WITH USER_MODE
            LIMIT 1
        ];
        if (rows.isEmpty()) {
            http.statusCode = 404;
            http.responseBody = Blob.valueOf('{"message":"Order not found."}');
            return;
        }
        http.statusCode = 200;
        http.responseBody = Blob.valueOf(JSON.serialize(rows[0]));
    }
}
```

**force-app/main/default/classes/PartnerOrderApiTest.cls**

```apex
@IsTest
private class PartnerOrderApiTest {

    @TestSetup
    static void setup() {
        insert new Account(Name = 'Partner Shop', AccountNumber = 'P-100');
    }

    private static void callPost(String json) {
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/partner/v1/orders/';
        req.httpMethod = 'POST';
        req.requestBody = Blob.valueOf(json);
        RestContext.request = req;
        RestContext.response = new RestResponse();
        PartnerOrderApi.post();
    }

    private static String validBody(Integer qty) {
        return '{"externalId":"EXT-1","accountExternalNumber":"P-100",'
            + '"lines":[{"sku":"TENT-2P","quantity":' + qty + '},'
            + '{"sku":"STOVE-1","quantity":1}]}';
    }

    @IsTest
    static void createsOrderWithLines() {
        callPost(validBody(2));
        System.assertEquals(200, RestContext.response.statusCode);
        System.assertEquals(1, [SELECT COUNT() FROM Partner_Order__c]);
        System.assertEquals(2, [SELECT COUNT() FROM Partner_Order_Line__c]);
    }

    @IsTest
    static void retryDoesNotDuplicate() {
        callPost(validBody(2));
        callPost(validBody(5));
        System.assertEquals(200, RestContext.response.statusCode);
        System.assertEquals(1, [SELECT COUNT() FROM Partner_Order__c]);
        System.assertEquals(2, [SELECT COUNT() FROM Partner_Order_Line__c]);
        Partner_Order_Line__c tent = [
            SELECT Quantity__c FROM Partner_Order_Line__c WHERE Sku__c = 'TENT-2P'
        ];
        System.assertEquals(5, tent.Quantity__c);
    }

    @IsTest
    static void invalidJsonReturns400() {
        callPost('not json');
        System.assertEquals(400, RestContext.response.statusCode);
    }

    @IsTest
    static void validationErrorsReturn400() {
        callPost('{"externalId":"EXT-2","accountExternalNumber":"P-100","lines":[{"sku":"","quantity":0}]}');
        System.assertEquals(400, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('quantity'));
        System.assertEquals(0, [SELECT COUNT() FROM Partner_Order__c]);
    }

    @IsTest
    static void unknownAccountReturns422() {
        callPost('{"externalId":"EXT-3","accountExternalNumber":"NOPE","lines":[{"sku":"A","quantity":1}]}');
        System.assertEquals(422, RestContext.response.statusCode);
    }

    @IsTest
    static void getReturns404ForMissingOrder() {
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/partner/v1/orders/MISSING';
        req.httpMethod = 'GET';
        RestContext.request = req;
        RestContext.response = new RestResponse();
        PartnerOrderApi.get();
        System.assertEquals(404, RestContext.response.statusCode);
    }

    @IsTest
    static void getReturnsExistingOrder() {
        callPost(validBody(1));
        RestRequest req = new RestRequest();
        req.requestUri = '/services/apexrest/partner/v1/orders/EXT-1';
        req.httpMethod = 'GET';
        RestContext.request = req;
        RestContext.response = new RestResponse();
        PartnerOrderApi.get();
        System.assertEquals(200, RestContext.response.statusCode);
        System.assert(RestContext.response.responseBody.toString().contains('EXT-1'));
    }
}
```

A partner client in Node shows the retry rule in practice:

```javascript
// partner-client.mjs (run with Node 20+)
const base = process.env.SF_INSTANCE_URL;
const token = process.env.SF_TOKEN;

export async function submitOrder(order, attempts = 4) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(`${base}/services/apexrest/partner/v1/orders/`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(order)
      });
      if (res.ok) return res.json();
      if (res.status === 400 || res.status === 422) {
        throw new Error(`Rejected: ${await res.text()}`); // do not retry
      }
    } catch (err) {
      if (String(err.message).startsWith('Rejected')) throw err;
    }
    await new Promise(r => setTimeout(r, 2 ** i * 500));
  }
  throw new Error('Gave up after retries');
}
```

## What happens behind the scenes

When a request reaches `/services/apexrest/partner/v1/orders/`, Salesforce authenticates the token, checks that the running user has access to the Apex class, and matches the URL against each `urlMapping`. The longest match wins. It then runs your method in a normal Apex transaction, so governor limits apply: a REST call counts as a synchronous transaction with its own limits.

A `with sharing` class respects record sharing, and `WITH USER_MODE` and `AccessLevel.USER_MODE` apply object and field permissions of the integration user. If an exception escapes a method, Salesforce returns `500` and rolls back. Because we catch exceptions and roll back to the savepoint ourselves, we can return precise status codes instead.

Upserting on an External ID makes the database do an atomic find-or-create, which is why a retried request updates the same row. Replacing the child lines inside the same transaction keeps the order and its lines consistent.

## Test it and verify

1. Deploy the classes and objects to a scratch org or sandbox, then run `PartnerOrderApiTest` and confirm every test passes.
2. Obtain a token and call the POST with the curl command, using body `{"externalId":"EXT-1","accountExternalNumber":"P-100","lines":[{"sku":"TENT-2P","quantity":2}]}`. Expect `200` and "Order created."
3. Send the same request again. Expect `200`, "Order updated.", and still one order record.
4. Send a body with `quantity` of `0`. Expect `400` and a readable error list.
5. Call as a user without class access. Expect `403` or an access error and no data change.
6. Check **Setup > Debug Logs** for the integration user to trace anything unexpected.

## Common mistakes and fixes

- **Using `without sharing` by default.** The integration then sees everything. Use `with sharing` and user mode, and grant only what is needed.
- **Returning a thrown exception to the partner.** Raw errors leak internals. Catch, log and return a short message.
- **Always returning 200.** Partners cannot tell success from failure. Use 400 for bad input, 404 for missing, 422 for business rule failures, 500 for unexpected.
- **No idempotency.** Retries create duplicates. Use an External ID and upsert.
- **Changing a live contract.** Add a new version path instead of editing `/v1/`.
- **Missing savepoint.** A failure after the header insert leaves an order with no lines.
- **Unbounded lists.** Cap the number of lines, because one request still obeys DML and heap limits.

## Key takeaways

- Build a custom REST service when one call must run several steps of business logic.
- Parse, validate, then act, and return status codes that match the outcome.
- Upsert on an External ID so repeated calls are safe.
- Wrap multi-record changes in a savepoint.
- Version the URL and run the service as a least-privilege integration user.

## Where to go next

- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for retries, outboxes and reconciliation.
- Read [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/) to set up the partner's token.
- Read [Apex security and user mode](/articles/apex-security-and-user-mode/) for the permission model used here.
