---
title: "Cross-System Integration Patterns for Salesforce: Choosing the Right One"
description: "Request-reply, fire-and-forget, batch sync, remote call-in and virtualization explained with working Apex and Node code for one order scenario."
category: salesforce-development
tags: [Integration, Architecture, Intermediate]
publishedAt: 2026-11-09
updatedAt: 2026-11-15
cover: /images/covers/cross-system-integration-patterns.jpg
sources:
  - title: "Integration Patterns (Salesforce Architects)"
    url: "https://architect.salesforce.com/docs/architect/fundamentals/guide/integration-patterns"
  - title: "Apex Developer Guide: Callouts"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_callouts.htm"
---

Before writing integration code, decide **what kind of conversation** the two systems need. Choosing the wrong pattern is expensive: a user waits ten seconds for a slow system, or a message is lost because nobody planned for a failure. This article names the patterns, gives a decision method, and then implements three of them for one realistic scenario.

## The business scenario

Trailhead Gear (a fictional outdoor shop) sells through its website. When a customer places an order: the quote screen must show live stock from the warehouse system, Salesforce must tell the ERP that an order was placed without making the customer wait, and the website must create the order in Salesforce from outside. Each of those three needs a different pattern.

## Before you start: setup

### In Salesforce

1. Create a Named Credential `Warehouse_API` pointing to the warehouse base URL, with an External Credential for its API key. See the callouts article for the exact steps.
2. Create a Platform Event `Order_Placed__e` with text fields `OrderNumber__c` and `Customer__c`, and a number field `Total__c`. Publish behaviour: **Publish After Commit**.
3. Give the integration user a permission set that includes the Named Credential principal, the Apex classes, and create access on the order object.
4. Use a sandbox or scratch org for all tests.

### In the external system

1. The warehouse must expose `GET /stock/{sku}` returning `{"sku":"TENT-2P","available":14}` and respond within a few seconds.
2. The ERP must subscribe to the Pub/Sub API or a middleware queue to receive `Order_Placed__e`.
3. The website needs an OAuth client for Salesforce, as described in the OAuth article.

## How it works

The common patterns, and when each fits:

| Pattern | Idea | Typical tools |
|---|---|---|
| **Request and reply** | Salesforce calls a system and waits for the answer | Apex callout, External Services, Flow HTTP callout |
| **Fire and forget** | Send a message, do not wait | Platform Events, Outbound Message, Queueable callout |
| **Batch data synchronization** | Move large data sets on a schedule | Bulk API 2.0, ETL or middleware, Batch Apex |
| **Remote call-in** | An external system calls Salesforce | REST, SOAP, Composite API, Apex REST |
| **UI update from data changes** | Refresh screens without polling | Change Data Capture, Platform Events |
| **Data virtualization** | Show external data without copying it | Salesforce Connect and External Objects |

Ask five questions in order:

1. **Does the user need the answer now?** Yes means request-reply with a short timeout and a fallback. No means asynchronous.
2. **How much data?** Hundreds of records suits REST or Composite. Millions suits Bulk API 2.0.
3. **Who starts it?** Salesforce starting means callouts or events out. The outside system starting means an API in.
4. **Must the data live in Salesforce?** If not, virtualization avoids storage and sync problems.
5. **What if the other side is down?** Plan retries, queues and a place to look at failures.

## Basic example

The simplest pattern is request-reply: ask the warehouse for stock and wait.

```apex
public with sharing class StockSimple {
    public static Integer available(String sku) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Warehouse_API/stock/' + EncodingUtil.urlEncode(sku, 'UTF-8'));
        req.setMethod('GET');
        HttpResponse res = new Http().send(req);
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        return (Integer) body.get('available');
    }
}
```

This works only while the warehouse is fast and healthy. The advanced example adds a timeout and a fallback so the quote screen never hangs.

## Advanced end-to-end example

**force-app/main/default/classes/StockLookup.cls** (request and reply with timeout and fallback)

```apex
public with sharing class StockLookup {

    public class StockResult {
        @AuraEnabled public String sku;
        @AuraEnabled public Integer available;
        @AuraEnabled public Boolean known;
        @AuraEnabled public String note;
    }

    @AuraEnabled(cacheable=false)
    public static StockResult check(String sku) {
        StockResult result = new StockResult();
        result.sku = sku;
        result.known = false;
        try {
            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:Warehouse_API/stock/' + EncodingUtil.urlEncode(sku, 'UTF-8'));
            req.setMethod('GET');
            req.setTimeout(5000);
            HttpResponse res = new Http().send(req);
            if (res.getStatusCode() == 200) {
                Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
                result.available = Integer.valueOf(body.get('available'));
                result.known = true;
            } else {
                result.note = 'Warehouse returned ' + res.getStatusCode();
            }
        } catch (CalloutException e) {
            result.note = 'Stock unknown: warehouse did not answer in time.';
        }
        return result;
    }
}
```

**force-app/main/default/classes/OrderPublisher.cls** (fire and forget)

```apex
public with sharing class OrderPublisher {

    public static List<Database.SaveResult> publish(List<Order> orders) {
        List<Order_Placed__e> events = new List<Order_Placed__e>();
        for (Order o : orders) {
            events.add(new Order_Placed__e(
                OrderNumber__c = o.OrderNumber,
                Customer__c = o.AccountId,
                Total__c = o.TotalAmount
            ));
        }
        List<Database.SaveResult> results = EventBus.publish(events);
        for (Database.SaveResult r : results) {
            if (!r.isSuccess()) {
                for (Database.Error err : r.getErrors()) {
                    System.debug(LoggingLevel.ERROR, 'Event publish failed: ' + err.getMessage());
                }
            }
        }
        return results;
    }
}
```

**force-app/main/default/classes/PatternsTest.cls**

```apex
@IsTest
private class PatternsTest {

    private class StockMock implements HttpCalloutMock {
        private Integer status;
        private String body;
        StockMock(Integer status, String body) { this.status = status; this.body = body; }
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(status);
            res.setBody(body);
            return res;
        }
    }

    private class TimeoutMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            throw new CalloutException('Read timed out');
        }
    }

    @IsTest
    static void stockIsKnownWhenWarehouseAnswers() {
        Test.setMock(HttpCalloutMock.class, new StockMock(200, '{"sku":"TENT-2P","available":14}'));
        StockLookup.StockResult r = StockLookup.check('TENT-2P');
        System.assertEquals(true, r.known);
        System.assertEquals(14, r.available);
    }

    @IsTest
    static void fallbackWhenWarehouseIsSlow() {
        Test.setMock(HttpCalloutMock.class, new TimeoutMock());
        StockLookup.StockResult r = StockLookup.check('TENT-2P');
        System.assertEquals(false, r.known);
        System.assert(r.note.contains('unknown'));
    }

    @IsTest
    static void fallbackOnServerError() {
        Test.setMock(HttpCalloutMock.class, new StockMock(503, '{}'));
        StockLookup.StockResult r = StockLookup.check('TENT-2P');
        System.assertEquals(false, r.known);
        System.assert(r.note.contains('503'));
    }

    @IsTest
    static void orderEventsArePublished() {
        Account a = new Account(Name = 'Shop');
        insert a;
        Order o = new Order(AccountId = a.Id, Status = 'Draft', EffectiveDate = Date.today());
        insert o;
        o = [SELECT OrderNumber, AccountId, TotalAmount FROM Order WHERE Id = :o.Id];
        Test.startTest();
        List<Database.SaveResult> results = OrderPublisher.publish(new List<Order>{ o });
        Test.stopTest();
        System.assertEquals(true, results[0].isSuccess());
    }
}
```

**website/placeOrder.mjs** (remote call-in from the website, using one Composite request)

```javascript
const base = `${process.env.INSTANCE}/services/data/v67.0`;
const headers = {
  Authorization: `Bearer ${process.env.TOKEN}`,
  'Content-Type': 'application/json'
};

export async function placeOrder(customerName, customerId) {
  const body = {
    allOrNone: true,
    compositeRequest: [
      {
        method: 'PATCH',
        url: `/services/data/v67.0/sobjects/Account/Website_Customer_Id__c/${encodeURIComponent(customerId)}`,
        referenceId: 'acct',
        body: { Name: customerName }
      },
      {
        method: 'POST',
        url: '/services/data/v67.0/sobjects/Order',
        referenceId: 'ord',
        body: { AccountId: '@{acct.id}', Status: 'Draft', EffectiveDate: new Date().toISOString().slice(0, 10) }
      }
    ]
  };
  const res = await fetch(`${base}/composite`, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!res.ok) {
    throw new Error(`Salesforce ${res.status}: ${await res.text()}`);
  }
  return res.json();
}
```

A small helper that encodes the decision questions makes the method repeatable and testable:

```javascript
// pickPattern.mjs
export function pickPattern({ userWaits, records, direction, mustStoreInSalesforce }) {
  if (!mustStoreInSalesforce) return 'data virtualization';
  if (direction === 'inbound') return records > 10000 ? 'bulk api' : 'remote call-in';
  if (userWaits) return 'request and reply';
  return records > 10000 ? 'batch synchronization' : 'fire and forget';
}
```

```javascript
// pickPattern.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPattern } from './pickPattern.mjs';

test('live stock on a quote is request and reply', () => {
  assert.equal(pickPattern({ userWaits: true, records: 1, direction: 'outbound', mustStoreInSalesforce: true }), 'request and reply');
});
test('order notification is fire and forget', () => {
  assert.equal(pickPattern({ userWaits: false, records: 1, direction: 'outbound', mustStoreInSalesforce: true }), 'fire and forget');
});
test('nightly million-row load is bulk', () => {
  assert.equal(pickPattern({ userWaits: false, records: 2000000, direction: 'inbound', mustStoreInSalesforce: true }), 'bulk api');
});
test('reference data that need not be copied is virtualized', () => {
  assert.equal(pickPattern({ userWaits: true, records: 5, direction: 'outbound', mustStoreInSalesforce: false }), 'data virtualization');
});
```

## What happens behind the scenes

In request-reply, the Apex transaction holds its database connection and the user's browser waits while the callout runs. That is why a timeout matters: the default is ten seconds and you can set up to two minutes, but a quote screen should give up in a few seconds and show "stock unknown". Salesforce also forbids a callout after uncommitted DML in the same transaction, which is another reason to isolate callouts in their own method.

In fire and forget, `EventBus.publish` places the message on the event bus. With Publish After Commit the event is only released if the transaction succeeds, so you never announce an order that was rolled back. Subscribers receive it separately and the sender does not wait for them.

For remote call-in, the website's single Composite call runs as one transaction in Salesforce, so the account and order succeed or fail together.

Two cautions about the Composite call. The reference `@{acct.id}` only resolves when the upsert returns an id; when an upsert updates an existing record Salesforce returns no body, so in production look the account up first or use a Composite Graph, which handles references more explicitly. And the order object here is deliberately minimal: a real order also needs a pricebook and line items, which you would add as further steps in the same request.

Finally, think about **who owns the data**. In each pattern, write down which system is the master for every field. When the website and Salesforce can both change a phone number, you need a rule for the winner, such as "latest timestamp wins" or "Salesforce wins for support fields, website wins for contact fields". Teams that skip this decision spend months chasing records that keep flipping between two values.

## Test it and verify

1. Deploy the event, classes and Named Credential, then run `PatternsTest`.
2. In **Anonymous Apex**, run `System.debug(StockLookup.check('TENT-2P'));` against a sandbox warehouse and confirm `known` is true.
3. Point the Named Credential at a closed port and rerun. Confirm the "unknown" fallback instead of an error screen.
4. Subscribe to `/event/Order_Placed__e` with an event monitoring tool and publish one order. Confirm one message arrives.
5. Run `node --test` for the decision helper, then run `placeOrder` against the sandbox and confirm both records are created.

## Common mistakes and fixes

- **Synchronous chains.** Salesforce waits on A, which waits on B. Latency and failures multiply, so break the chain with events.
- **Polling every minute.** An event pushes changes instantly and costs far fewer API calls.
- **Point-to-point spaghetti.** Ten systems wired to each other cannot be maintained. Put middleware between them.
- **Two systems editing one record.** Decide which system owns each field.
- **No fallback.** If a user-facing callout has no timeout and fallback, one slow system takes your screen down.
- **Missing monitoring.** Failures nobody sees become data problems later.

## Key takeaways

- Pick the pattern from the questions: how fast, how much, who starts, where the data lives, what if it fails.
- Use request-reply only when the user needs the answer now, and always set a timeout and fallback.
- Use events for notifications and Bulk API for volume.
- Use one Composite call when an outside system must create linked records atomically.
- Design for idempotency, visibility, least privilege and monitoring.

## Where to go next

- Read [Integration reliability and idempotency](/articles/integration-reliability-idempotency/) for retries and reconciliation.
- Read [Platform events, CDC and Pub/Sub](/articles/platform-events-cdc-pubsub/) for the event side.
- Read [Middleware integrations guide](/articles/middleware-integrations-guide/) to avoid point-to-point wiring.
