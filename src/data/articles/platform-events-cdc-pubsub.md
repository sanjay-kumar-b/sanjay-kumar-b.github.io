---
title: "Platform Events, Change Data Capture and the Pub/Sub API"
description: "Build event-driven integration end to end: define and publish platform events, subscribe safely with retries, use CDC, and read events from outside."
category: salesforce-development
tags: [Platform Events, CDC, Pub/Sub API, Integration, Advanced]
publishedAt: 2026-11-09
updatedAt: 2026-11-14
cover: /images/covers/platform-events-cdc-pubsub.jpg
sources:
  - title: "Platform Events Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/"
  - title: "Change Data Capture Developer Guide"
    url: "https://developer.salesforce.com/docs/atlas.en-us.change_data_capture.meta/change_data_capture/"
  - title: "Pub/Sub API"
    url: "https://developer.salesforce.com/docs/platform/pub-sub-api/overview"
---

Events let systems react to things that happen without tight coupling. The publisher says "this happened" and does not know or care who listens. If a listener is slow, broken or added later, the publisher is not affected.

This article builds a complete event-driven flow: a platform event announces a won deal, an Apex subscriber hands it to the ERP with retries and idempotency, Change Data Capture keeps the ERP's account data in sync, and an external client reads the same events through the Pub/Sub API.

## The business scenario

Tessera Industrial (a fictional manufacturer) sells through Salesforce and fulfils from an ERP. When an Opportunity is Closed Won, the ERP must create a sales order. When an Account's name or phone changes, the ERP must update its customer record. Today a trigger calls the ERP directly and sales reps lose their save whenever the ERP is down. The new design separates the two worlds with events: saving the Opportunity never waits for the ERP.

## Before you start: setup

### In Salesforce

1. Use a scratch org or Developer sandbox. Verify: `sf org list` shows it.
2. Create the Named Credential `ERP_API` for the ERP's base URL, with its External Credential and authentication (Setup, Named Credentials; labels differ slightly by release). Verify: the credential saves. Tests use a mock, so you only need a working credential for the manual test.
3. Create the platform event `Deal_Won__e` (Setup, Platform Events, New Platform Event, or deploy the XML below). Fields: `Opportunity_Id__c` (Text 18), `Amount__c` (Number 16,2), `Account_Name__c` (Text 255). Publish behavior: **Publish After Commit**, so subscribers never hear about a deal that rolled back.
4. Create the custom object `Event_Receipt__c` with a unique, case-sensitive External ID text field `Event_Uuid__c` (80), a text field `Status__c` and a long text `Detail__c`. This is the idempotency ledger.
5. Enable Change Data Capture for Account: Setup, Change Data Capture, move Account to Selected Entities, Save. Verify: `AccountChangeEvent` appears in the Developer Console's query editor object list.
6. Make an integration user or use an External Client App for the external reader (see the OAuth article). Grant the user the "Customize Application" or a permission set with API Enabled, and read access to the event channels you subscribe to.

### In the external system

7. The ERP needs an endpoint such as `POST /orders` that returns `201` on success. For practice, use the small mock server in the verify section.
8. For the Pub/Sub client: Node.js 18 or later, and the Pub/Sub API proto file from Salesforce's open-source Pub/Sub API repository. Verify: `node --version` prints 18 or higher.

## How it works

| | Platform event | Change Data Capture |
|---|---|---|
| Who defines the message | You | Salesforce |
| Who publishes | You (Apex, Flow, API) | Salesforce, after a record change |
| Content | The fields you define | Changed fields plus a header describing the change |
| Best for | Business facts ("deal won") | Replicating data to other systems |

Key facts that shape the design:

- Events are stored on an **event bus** for a limited retention period, and each has a **replay id**. A subscriber can resume from a replay id after a disconnect, as long as it is still within retention.
- Delivery is **at least once**. Assume the same event can arrive twice and make subscribers idempotent.
- `Publish After Commit` waits for the publishing transaction to commit. `Publish Immediately` publishes at once, even if the transaction later rolls back. Use the first for business facts.
- Publishing success means the bus **accepted** the event. It says nothing about whether any subscriber processed it.
- Subscribers inside Salesforce run in their own transaction as the Automated Process user, so they never share locks or limits with the publisher.

## Basic example

Publish an event and subscribe to it with a trigger.

```apex
// Anonymous Apex
List<Database.SaveResult> results = EventBus.publish(new List<Deal_Won__e>{
    new Deal_Won__e(Opportunity_Id__c = '006000000000001AAA', Amount__c = 1500, Account_Name__c = 'Acme')
});
for (Database.SaveResult r : results) {
    System.debug(r.isSuccess() ? 'Accepted by the event bus' : 'Rejected: ' + r.getErrors());
}
```

```apex
trigger DealWonDebugTrigger on Deal_Won__e (after insert) {
    for (Deal_Won__e e : Trigger.new) {
        System.debug('Received ' + e.Opportunity_Id__c + ' replay ' + e.ReplayId);
    }
}
```

Event triggers run asynchronously, so you see the debug line in a separate log for the Automated Process user (add that user to your trace flags in Setup, Debug Logs).

## Advanced end-to-end example

### Metadata

**`force-app/main/default/objects/Deal_Won__e/Deal_Won__e.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <deploymentStatus>Deployed</deploymentStatus>
    <eventType>StandardVolume</eventType>
    <label>Deal Won</label>
    <pluralLabel>Deals Won</pluralLabel>
    <publishBehavior>PublishAfterCommit</publishBehavior>
</CustomObject>
```

**`force-app/main/default/objects/Deal_Won__e/fields/Opportunity_Id__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Opportunity_Id__c</fullName>
    <externalId>false</externalId>
    <isFilteringDisabled>false</isFilteringDisabled>
    <isNameField>false</isNameField>
    <isSortingDisabled>false</isSortingDisabled>
    <label>Opportunity Id</label>
    <length>18</length>
    <required>false</required>
    <type>Text</type>
    <unique>false</unique>
</CustomField>
```

Create `Amount__c` (Number, precision 16, scale 2) and `Account_Name__c` (Text 255) the same way. Create `Event_Receipt__c` with `Event_Uuid__c` marked `<externalId>true</externalId>` and `<unique>true</unique>` (the XML has the same shape).

### Publisher

**`force-app/main/default/classes/DealEventPublisher.cls`**

```apex
public with sharing class DealEventPublisher {

    // Called from the Opportunity trigger. One publish call for the whole batch.
    public static void publishForWon(List<Opportunity> opps, Map<Id, Opportunity> oldMap) {
        List<Deal_Won__e> events = new List<Deal_Won__e>();
        for (Opportunity o : opps) {
            Boolean newlyWon = o.IsWon && (oldMap == null || !oldMap.get(o.Id).IsWon);
            if (newlyWon) {
                events.add(new Deal_Won__e(
                    Opportunity_Id__c = o.Id,
                    Amount__c = o.Amount,
                    Account_Name__c = o.Name
                ));
            }
        }
        if (events.isEmpty()) {
            return;
        }

        List<Database.SaveResult> results = EventBus.publish(events);
        for (Integer i = 0; i < results.size(); i++) {
            if (!results[i].isSuccess()) {
                // The bus rejected it (for example, publish limits). Do not hide this.
                System.debug(LoggingLevel.ERROR,
                    'Deal_Won__e not published for ' + events[i].Opportunity_Id__c
                    + ': ' + results[i].getErrors()[0].getMessage());
            }
        }
    }
}
```

**`force-app/main/default/triggers/OpportunityDealWonTrigger.trigger`**

```apex
trigger OpportunityDealWonTrigger on Opportunity (after insert, after update) {
    DealEventPublisher.publishForWon(Trigger.new, Trigger.oldMap);
}
```

### Subscriber with idempotency and retry

**`force-app/main/default/triggers/DealWonSubscriber.trigger`**

```apex
trigger DealWonSubscriber on Deal_Won__e (after insert) {
    // Remember where we are, so a retry resumes after the last event we finished.
    String lastReplay = null;

    Set<String> uuids = new Set<String>();
    for (Deal_Won__e e : Trigger.new) {
        uuids.add(e.EventUuid);
    }

    // Idempotency: skip events we already processed.
    Set<String> alreadyDone = new Set<String>();
    for (Event_Receipt__c r : [
        SELECT Event_Uuid__c FROM Event_Receipt__c WHERE Event_Uuid__c IN :uuids
    ]) {
        alreadyDone.add(r.Event_Uuid__c);
    }

    List<ErpOrderRequest> work = new List<ErpOrderRequest>();
    List<Event_Receipt__c> receipts = new List<Event_Receipt__c>();
    for (Deal_Won__e e : Trigger.new) {
        lastReplay = e.ReplayId;
        if (alreadyDone.contains(e.EventUuid)) {
            continue;
        }
        work.add(new ErpOrderRequest(e.Opportunity_Id__c, e.Amount__c, e.Account_Name__c));
        receipts.add(new Event_Receipt__c(Event_Uuid__c = e.EventUuid, Status__c = 'Queued'));
    }

    try {
        if (!work.isEmpty()) {
            upsert receipts Event_Uuid__c;                  // ledger first
            System.enqueueJob(new ErpOrderSyncJob(work));    // callout happens in async Apex
        }
        EventBus.TriggerContext.currentContext().setResumeCheckpoint(lastReplay);
    } catch (DmlException ex) {
        // Transient problem (for example a row lock). Ask the platform to redeliver.
        throw new EventBus.RetryableException('Ledger write failed: ' + ex.getMessage());
    }
}
```

**`force-app/main/default/classes/ErpOrderRequest.cls`**

```apex
public class ErpOrderRequest {
    public String opportunityId;
    public Decimal amount;
    public String customer;

    public ErpOrderRequest(String opportunityId, Decimal amount, String customer) {
        this.opportunityId = opportunityId;
        this.amount = amount;
        this.customer = customer;
    }
}
```

**`force-app/main/default/classes/ErpOrderSyncJob.cls`**

```apex
public with sharing class ErpOrderSyncJob implements Queueable, Database.AllowsCallouts {

    private final List<ErpOrderRequest> requests;

    public ErpOrderSyncJob(List<ErpOrderRequest> requests) {
        this.requests = requests;
    }

    public void execute(QueueableContext context) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ERP_API/orders');
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Idempotency-Key', requests[0].opportunityId); // the ERP de-duplicates too
        req.setTimeout(20000);
        req.setBody(JSON.serialize(requests));

        String status;
        String detail;
        try {
            HttpResponse res = new Http().send(req);
            Integer code = res.getStatusCode();
            status = (code >= 200 && code < 300) ? 'Done' : (code >= 500 ? 'RetryLater' : 'Failed');
            detail = 'HTTP ' + code;
        } catch (CalloutException e) {
            status = 'RetryLater';
            detail = e.getMessage();
        }

        List<Event_Receipt__c> toUpdate = new List<Event_Receipt__c>();
        for (Event_Receipt__c r : [
            SELECT Id FROM Event_Receipt__c WHERE Status__c = 'Queued' LIMIT 200
        ]) {
            r.Status__c = status;
            r.Detail__c = detail;
            toUpdate.add(r);
        }
        update toUpdate;
    }
}
```

### Change Data Capture subscriber

**`force-app/main/default/triggers/AccountChangeSubscriber.trigger`**

```apex
trigger AccountChangeSubscriber on AccountChangeEvent (after insert) {
    Set<Id> accountIds = new Set<Id>();

    for (AccountChangeEvent evt : Trigger.new) {
        EventBus.ChangeEventHeader header = evt.ChangeEventHeader;

        // GAP_* and overflow events mean we may have missed changes: re-read the record.
        Boolean isGap = header.changeType.startsWith('GAP');
        Boolean isUpdate = header.changeType == 'UPDATE';

        Boolean interesting = !isUpdate
            || header.changedFields.contains('Name')
            || header.changedFields.contains('Phone');

        if (interesting || isGap) {
            accountIds.addAll(header.recordIds);
        }
    }

    if (!accountIds.isEmpty()) {
        System.enqueueJob(new AccountSyncJob(accountIds));
    }
}
```

**`force-app/main/default/classes/AccountSyncJob.cls`**

```apex
public with sharing class AccountSyncJob implements Queueable, Database.AllowsCallouts {

    private final Set<Id> accountIds;

    public AccountSyncJob(Set<Id> accountIds) {
        this.accountIds = accountIds;
    }

    public void execute(QueueableContext context) {
        List<Map<String, Object>> payload = new List<Map<String, Object>>();
        for (Account a : [SELECT Id, Name, Phone FROM Account WHERE Id IN :accountIds]) {
            payload.add(new Map<String, Object>{ 'id' => a.Id, 'name' => a.Name, 'phone' => a.Phone });
        }
        if (payload.isEmpty()) {
            return; // deleted accounts: a real system would send a delete message
        }
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:ERP_API/customers');
        req.setMethod('PUT');
        req.setHeader('Content-Type', 'application/json');
        req.setBody(JSON.serialize(payload));
        new Http().send(req);
    }
}
```

### Tests

**`force-app/main/default/classes/DealEventFlowTest.cls`**

```apex
@IsTest
private class DealEventFlowTest {

    private class ErpMock implements HttpCalloutMock {
        public Integer calls = 0;
        public String lastBody;
        private final Integer status;
        ErpMock(Integer status) {
            this.status = status;
        }
        public HttpResponse respond(HttpRequest req) {
            calls++;
            lastBody = req.getBody();
            HttpResponse r = new HttpResponse();
            r.setStatusCode(status);
            r.setBody('{}');
            return r;
        }
    }

    private static Opportunity newOpp() {
        Account a = new Account(Name = 'Event Test Co');
        insert a;
        Opportunity o = new Opportunity(
            Name = 'Big Deal', AccountId = a.Id, Amount = 5000,
            StageName = 'Prospecting', CloseDate = Date.today().addDays(10)
        );
        insert o;
        return o;
    }

    @IsTest
    static void closingAnOpportunityPublishesOneEventAndSyncsOnce() {
        Opportunity o = newOpp();
        ErpMock mock = new ErpMock(201);
        Test.setMock(HttpCalloutMock.class, mock);

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.getEventBus().deliver();   // deliver the event to the subscriber trigger
        Test.stopTest();                // run the Queueable

        Assert.areEqual(1, [SELECT COUNT() FROM Event_Receipt__c], 'One receipt for one event');
        Assert.areEqual(1, mock.calls, 'One ERP callout');
        Assert.isTrue(mock.lastBody.contains(o.Id), 'Body carries the opportunity id');
        Assert.areEqual('Done', [SELECT Status__c FROM Event_Receipt__c LIMIT 1].Status__c, 'Marked done');
    }

    @IsTest
    static void updatingAnAlreadyWonOpportunityDoesNotPublishAgain() {
        Opportunity o = newOpp();
        Test.setMock(HttpCalloutMock.class, new ErpMock(201));

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.getEventBus().deliver();
        o.Amount = 6000;
        update o;
        Test.getEventBus().deliver();
        Test.stopTest();

        Assert.areEqual(1, [SELECT COUNT() FROM Event_Receipt__c], 'Still exactly one receipt');
    }

    @IsTest
    static void serverErrorMarksReceiptForRetry() {
        Opportunity o = newOpp();
        Test.setMock(HttpCalloutMock.class, new ErpMock(503));

        Test.startTest();
        o.StageName = 'Closed Won';
        update o;
        Test.getEventBus().deliver();
        Test.stopTest();

        Assert.areEqual('RetryLater', [SELECT Status__c FROM Event_Receipt__c LIMIT 1].Status__c,
            'A 5xx response leaves the receipt retryable');
    }

    @IsTest
    static void accountNameChangeIsCapturedAndSynced() {
        Test.enableChangeDataCapture();
        ErpMock mock = new ErpMock(200);
        Test.setMock(HttpCalloutMock.class, mock);

        Account a = new Account(Name = 'Before Name');
        insert a;
        Test.getEventBus().deliver();
        Integer afterInsert = mock.calls;

        Test.startTest();
        a.Name = 'After Name';
        update a;
        Test.getEventBus().deliver();
        Test.stopTest();

        Assert.isTrue(mock.calls > afterInsert, 'The name change reached the ERP');
        Assert.isTrue(mock.lastBody.contains('After Name'), 'Payload has the new name');
    }
}
```

### External subscriber (Node.js, Pub/Sub API)

This reads `Deal_Won__e` from outside Salesforce. It follows the open-source Pub/Sub API client examples: a gRPC connection to `api.pubsub.salesforce.com:7443`, an access token plus instance URL and tenant id as call metadata, and Avro-encoded events described by a schema you fetch by id. Verify the proto path and message names against the current Pub/Sub API documentation before you ship.

**`pubsub-client/subscribe.js`**

```javascript
// npm install @grpc/grpc-js @grpc/proto-loader avsc
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');
const avro = require('avsc');

const LOGIN_URL = process.env.SF_LOGIN_URL;          // your My Domain URL
const CLIENT_ID = process.env.SF_CLIENT_ID;          // External Client App, client credentials flow
const CLIENT_SECRET = process.env.SF_CLIENT_SECRET;  // keep in a secret manager, not in code
const TOPIC = '/event/Deal_Won__e';

async function login() {
  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status}`);
  const body = await res.json();
  const info = await (await fetch(`${body.instance_url}/services/oauth2/userinfo`, {
    headers: { Authorization: `Bearer ${body.access_token}` },
  })).json();
  return { token: body.access_token, instanceUrl: body.instance_url, tenantId: info.organization_id };
}

function loadClient() {
  const def = protoLoader.loadSync('pubsub_api.proto', { keepCase: true, longs: String, defaults: true });
  const pkg = grpc.loadPackageDefinition(def).eventbus.v1;
  return new pkg.PubSub('api.pubsub.salesforce.com:7443', grpc.credentials.createSsl());
}

const schemaCache = new Map();
function getSchema(client, meta, schemaId) {
  if (schemaCache.has(schemaId)) return Promise.resolve(schemaCache.get(schemaId));
  return new Promise((resolve, reject) => {
    client.GetSchema({ schema_id: schemaId }, meta, (err, info) => {
      if (err) return reject(err);
      const type = avro.Type.forSchema(JSON.parse(info.schema_json));
      schemaCache.set(schemaId, type);
      resolve(type);
    });
  });
}

async function main() {
  const { token, instanceUrl, tenantId } = await login();
  const meta = new grpc.Metadata();
  meta.set('accesstoken', token);
  meta.set('instanceurl', instanceUrl);
  meta.set('tenantid', tenantId);

  const client = loadClient();
  const stream = client.Subscribe(meta);

  // Start at the newest event. Persist replay_id after processing to resume later.
  stream.write({ topic_name: TOPIC, replay_preset: 'LATEST', num_requested: 10 });

  stream.on('data', async (msg) => {
    for (const ev of msg.events || []) {
      const type = await getSchema(client, meta, ev.event.schema_id);
      const payload = type.fromBuffer(ev.event.payload);
      console.log('replay', ev.replay_id.toString('hex'), 'event', payload);
      // Idempotent processing goes here: use ev.event.id (the event uuid) as the key.
    }
    stream.write({ topic_name: TOPIC, num_requested: 10 }); // ask for more
  });
  stream.on('error', (e) => console.error('stream error', e.message));
  stream.on('end', () => console.log('stream ended'));
}

main().catch((e) => { console.error(e); process.exit(1); });
```

## What happens behind the scenes

1. A rep saves the Opportunity as Closed Won. The trigger builds one `Deal_Won__e` per newly won record and calls `EventBus.publish` once for the batch. Because the event is `PublishAfterCommit`, the platform holds it until the Opportunity transaction commits. If the save rolls back, no event exists.
2. The event bus assigns each event a replay id and stores it for its retention period. `isSuccess()` on the save result means the bus accepted the event.
3. The `DealWonSubscriber` trigger runs asynchronously in a **separate transaction** as the Automated Process user, in batches (the Apex platform event guide gives the batch size and limits for your release). It looks up the event uuids in `Event_Receipt__c` to skip duplicates, writes a ledger row, then enqueues a Queueable. Callouts are not allowed in the trigger itself, so the Queueable makes the ERP call.
4. `setResumeCheckpoint` tells the platform which replay id the trigger has finished. If the trigger throws `EventBus.RetryableException`, the platform redelivers from the last checkpoint after a short delay, up to a maximum number of retries; after that the batch is dropped. That is why the ledger and the ERP idempotency key both exist.
5. CDC works the same way, but Salesforce is the publisher. Each change to an enabled object produces a change event whose `ChangeEventHeader` lists the change type, the record ids and the changed field names. A bulk update can produce one event with several record ids.
6. The external client logs in with the client credentials flow, opens one long-lived gRPC stream, asks for events (`num_requested`) and receives batches. It needs the schema id in each event to decode the Avro payload. It should store the last processed replay id and ask to resume from it (`CUSTOM` replay preset) after a restart.

## Test it and verify

1. Deploy and run the tests:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names DealEventFlowTest --result-format human --code-coverage --wait 10 --target-org dev
```

Expected: 4 tests pass. (The duplicate-skipping branch depends on the platform redelivering an event with the same uuid, which a unit test cannot force; verify it by watching the ledger during a manual retry.)
2. Start this stand-in ERP in another terminal and point `ERP_API` at it through a public tunnel (needed because Salesforce must reach it):

```javascript
// erp-mock.js  (node erp-mock.js)
const http = require('http');
http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    console.log(req.method, req.url, req.headers['idempotency-key'] || '', body);
    res.writeHead(201, { 'Content-Type': 'application/json' });
    res.end('{"ok":true}');
  });
}).listen(8080, () => console.log('ERP mock on :8080'));
```

3. In the org, close an Opportunity. Expected: the ERP mock prints one `POST /orders` line, and `Event_Receipt__c` has one row with Status `Done`.
4. Rename an Account. Expected: a `PUT /customers` line.
5. Check Setup, Platform Events, or monitor event delivery in Setup's Event Manager if your org shows it, to confirm publish and delivery counts.

## Common mistakes and fixes

- **Symptom: subscribers act on deals that never happened.** Cause: the event publishes immediately and the transaction rolled back. Fix: use `PublishAfterCommit` for business facts.
- **Symptom: duplicate ERP orders.** Cause: at-least-once delivery plus retries. Fix: keep a ledger keyed by `EventUuid` and send an idempotency key to the ERP.
- **Symptom: the subscriber trigger fails with a callout error.** Cause: callouts are not allowed from event triggers directly. Fix: hand off to a Queueable that implements `Database.AllowsCallouts`.
- **Symptom: an external client misses events after a long outage.** Cause: events were outside the retention window. Fix: store the last replay id, resume soon after downtime, and run a reconciliation query for anything older.
- **Symptom: trigger changes events but the ERP gets stale data.** Cause: CDC sends only changed fields. Fix: re-read the record in the job, as `AccountSyncJob` does.
- **Symptom: "no event received" in tests.** Cause: the test did not deliver events. Fix: call `Test.getEventBus().deliver()` or `Test.stopTest()`, and use `Test.enableChangeDataCapture()` for CDC tests.
- **Symptom: `EventBus.publish` returns success but nothing happens.** Cause: success means accepted by the bus, not processed. Fix: monitor subscriber results (the ledger status) separately.
- **Symptom: publishing fails at high volume.** Cause: event publish allocations per 24 hours or per transaction. Fix: check the allocations for your edition in the Platform Events guide, and batch events.

## Key takeaways

- Platform events carry business facts you define; CDC carries record changes Salesforce publishes.
- Use `PublishAfterCommit` for facts, and treat delivery as at-least-once.
- Make subscribers idempotent with a ledger and an idempotency key, and retry with `EventBus.RetryableException`.
- Keep callouts out of event triggers; hand them to a Queueable.
- External clients use the Pub/Sub API with a replay id, and need a reconciliation plan for long outages.

## Where to go next

- [Integration reliability and idempotency](/articles/integration-reliability-idempotency/)
- [Calling external APIs with Named Credentials](/articles/rest-callouts-named-credentials/)
- [Queueable Apex: the complete guide](/articles/queueable-apex-complete-guide/)
- [OAuth flows and external client apps](/articles/oauth-flows-and-external-client-apps/)
