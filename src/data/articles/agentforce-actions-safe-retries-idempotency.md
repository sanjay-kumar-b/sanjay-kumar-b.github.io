---
title: "Safe Retries for Agentforce Actions: Make Every Action Idempotent"
description: "Agents retry, users repeat themselves and tools time out. Build idempotent Agentforce actions with deterministic keys, a ledger and tests so a refund happens once."
category: agentforce
tags: [Agentforce, Actions, Idempotency, Apex, Retries]
publishedAt: 2026-11-18
updatedAt: 2026-11-18
cover: /images/covers/agentforce-actions-safe-retries-idempotency.jpg
sources:
  - title: "Agentforce Developer Guide: Agent Actions"
    url: "https://developer.salesforce.com/docs/einstein/genai/overview"
  - title: "Apex Developer Guide: InvocableMethod annotation"
    url: "https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/"
---

A human clicking a button once is easy to reason about. An agent is different. The reasoning engine may call the same action twice in a conversation because the first answer looked unclear. The customer may say "did that go through?" and the agent may run the action again. The platform or your own flow may retry after a timeout. Every one of those paths can turn one refund into two.

This is the same hazard as in any integration (the other side succeeded, but you did not hear about it), with an extra twist: the caller is a language model, not deterministic code, so you cannot rely on it to call the action exactly once. The safe design is to make every action that changes something **idempotent**: the same request, repeated, produces the same result and one side effect.

Read [timeouts, duplicates and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/) for the integration side and [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) for how actions are built.

## The business scenario

Crestline Lending (a fictional lender) has a service agent in Agentforce. One action, `Refund Fee`, refunds a late fee through the billing system. In testing, a customer asked "can you refund my fee?", the billing call timed out, the agent said "I'm retrying", the second call succeeded, and the first one had too: two refunds. The team wants the same conversation to refund a given fee at most once, and to answer honestly when the outcome is uncertain.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition or sandbox org with Agentforce enabled and an agent you can edit in Agentforce Builder. Verify: you can open the agent and see its topics.
2. Create a custom object `Agent_Action_Log__c` with fields: `Action_Key__c` (Text 80, External ID, Unique), `Action_Name__c` (Text 80), `Status__c` (Picklist: InProgress, Succeeded, Unknown, Failed), `Attempts__c` (Number 2,0), `Reference__c` (Text 80), `Message__c` (Text 255), `Last_Error__c` (Long Text 2000), `Conversation_Id__c` (Text 80). Verify: all fields exist and the key is unique.
3. Create a Named Credential `Billing` for the billing system (see [Named Credentials](/articles/rest-callouts-named-credentials/)) and grant principal access to the agent's running user through a permission set. Verify: anonymous Apex can call the billing health endpoint.
4. Grant that running user access to `Agent_Action_Log__c` and to the Apex class below.

### In the external system

5. Make sure the billing API accepts an `Idempotency-Key` header or a client reference id for refunds, and note how long it remembers keys. Verify: two identical requests with the same key return the same refund id.
6. If it does not, add a lookup (`GET /refunds?reference=...`) so the action can ask "was this already refunded?" before creating one.

### In the agent

7. In Agentforce Builder, add the Apex action to a topic, name it by what it does for the customer, and write instructions that tell the agent to **use the status returned** and never to repeat an action whose status is `AlreadyDone` or `Unknown`. The builder screens change between releases, so follow the current Salesforce Help for adding an action.

## How it works

1. **The key is derived, not random.** It is a hash of the conversation id, the action name and the normalised inputs. Two calls for the same refund in the same conversation get the same key, without the model having to remember anything.
2. **The ledger answers first.** The action looks up the key. A `Succeeded` row returns `AlreadyDone` with the original reference. An `InProgress` row returns a "still working" answer.
3. **The side effect carries the key.** The billing call sends `Idempotency-Key`, so even if the ledger misses, the other system protects itself.
4. **Unknown is a real answer.** After a timeout the action returns `Unknown` with wording that tells the agent not to promise success and not to repeat blindly. A keyed retry is still allowed.
5. **The action returns structured status.** The agent speaks about what happened using the status, instead of guessing.

## Basic example

First the pure logic in Node: normalisation, key derivation, the ledger and the decision flow.

```javascript
// An idempotent agent action: same intent in, same result out, side effect once.
import { createHash } from 'node:crypto';

// Normalise inputs so "  Order 123 " and "order 123" count as the same request.
export function normalize(inputs) {
  const out = {};
  for (const key of Object.keys(inputs).sort()) {
    const value = inputs[key];
    out[key] = typeof value === 'string' ? value.trim().toLowerCase() : value;
  }
  return out;
}

// The key comes from the conversation, the action and the normalised inputs.
// It must NOT include a timestamp or a random value, or every retry gets a new key.
export function actionKey(conversationId, actionName, inputs) {
  const text = JSON.stringify([conversationId, actionName, normalize(inputs)]);
  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}

export class ActionLedger {
  constructor() {
    this.rows = new Map();
  }
  get(key) { return this.rows.get(key); }
  put(key, row) { this.rows.set(key, row); }
}

// "perform" does the real work (refund, case update, email). It may throw.
export async function runAction({ ledger, conversationId, name, inputs, perform }) {
  const key = actionKey(conversationId, name, inputs);
  const row = ledger.get(key);

  if (row && row.status === 'Succeeded') {
    return { status: 'AlreadyDone', message: row.message, reference: row.reference };
  }
  if (row && row.status === 'InProgress') {
    return { status: 'InProgress', message: 'This request is already being processed.' };
  }

  ledger.put(key, { status: 'InProgress', attempts: (row?.attempts ?? 0) + 1 });
  try {
    const result = await perform(normalize(inputs), key);
    ledger.put(key, { status: 'Succeeded', reference: result.reference, message: result.message });
    return { status: 'Done', message: result.message, reference: result.reference };
  } catch (e) {
    // Unknown outcome: do not claim failure to the customer; allow a keyed retry.
    ledger.put(key, { status: 'Unknown', attempts: ledger.get(key).attempts, error: e.message });
    return { status: 'Unknown', message: 'We could not confirm this yet. Please do not repeat it.' };
  }
}
```

Tests, including the repeated request, the odd spacing, the timeout followed by a retry, and the in-progress guard:

```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActionLedger, actionKey, normalize, runAction } from './actionKit.mjs';

function refundWorld() {
  const refunds = [];
  const perform = async inputs => {
    refunds.push(inputs.orderid);
    return { reference: 'RF-' + refunds.length, message: 'Refund created' };
  };
  return { refunds, perform };
}

const call = (world, ledger, inputs, conversationId = 'conv-1') =>
  runAction({ ledger, conversationId, name: 'refundOrder', inputs, perform: world.perform });

test('the same request sent twice refunds once', async () => {
  const world = refundWorld();
  const ledger = new ActionLedger();
  const first = await call(world, ledger, { orderId: 'A1' });
  const second = await call(world, ledger, { orderId: 'A1' });
  assert.equal(first.status, 'Done');
  assert.equal(second.status, 'AlreadyDone');
  assert.equal(second.reference, first.reference);
  assert.equal(world.refunds.length, 1);
});

test('differences in spacing and case do not create a second refund', async () => {
  const world = refundWorld();
  const ledger = new ActionLedger();
  await call(world, ledger, { orderId: 'A1' });
  await call(world, ledger, { orderId: '  a1 ' });
  assert.equal(world.refunds.length, 1);
});

test('a different order is a different action', async () => {
  const world = refundWorld();
  const ledger = new ActionLedger();
  await call(world, ledger, { orderId: 'A1' });
  await call(world, ledger, { orderId: 'B2' });
  assert.equal(world.refunds.length, 2);
});

test('a different conversation can legitimately repeat the action', () => {
  assert.notEqual(actionKey('c1', 'refundOrder', { orderId: 'A1' }),
                  actionKey('c2', 'refundOrder', { orderId: 'A1' }));
});

test('the key ignores property order', () => {
  assert.equal(actionKey('c', 'x', { a: 1, b: 2 }), actionKey('c', 'x', { b: 2, a: 1 }));
});

test('a failure returns an unknown status and does not claim success', async () => {
  const ledger = new ActionLedger();
  const result = await runAction({
    ledger, conversationId: 'c', name: 'refundOrder', inputs: { orderId: 'A1' },
    perform: async () => { throw new Error('timeout'); }
  });
  assert.equal(result.status, 'Unknown');
});

test('after an unknown outcome the retry performs once and then stays done', async () => {
  const world = refundWorld();
  const ledger = new ActionLedger();
  let fail = true;
  const perform = async (inputs, key) => {
    if (fail) { fail = false; throw new Error('timeout'); }
    return world.perform(inputs, key);
  };
  const args = { ledger, conversationId: 'c', name: 'refundOrder', inputs: { orderId: 'A1' }, perform };
  assert.equal((await runAction(args)).status, 'Unknown');
  assert.equal((await runAction(args)).status, 'Done');
  assert.equal((await runAction(args)).status, 'AlreadyDone');
  assert.equal(world.refunds.length, 1);
});

test('an action already in progress is not started twice', async () => {
  const ledger = new ActionLedger();
  const key = actionKey('c', 'refundOrder', { orderId: 'A1' });
  ledger.put(key, { status: 'InProgress', attempts: 1 });
  const world = refundWorld();
  const result = await runAction({ ledger, conversationId: 'c', name: 'refundOrder',
    inputs: { orderId: 'A1' }, perform: world.perform });
  assert.equal(result.status, 'InProgress');
  assert.equal(world.refunds.length, 0);
});

test('normalize trims and lowercases strings only', () => {
  assert.deepEqual(normalize({ b: ' X ', a: 5 }), { a: 5, b: 'x' });
});
```

Run `node --test tools/actionKit.test.mjs`. Expected: 9 tests pass.

## Advanced end-to-end example

Now the Apex action that Agentforce calls.

### 1. Key and normalisation

```apex
public with sharing class ActionKey {
    public static String normalize(String value) {
        return value == null ? '' : value.trim().toLowerCase();
    }

    // Deterministic: no timestamps, no random values.
    public static String build(String conversationId, String actionName, List<String> inputs) {
        List<String> parts = new List<String>{ normalize(conversationId), actionName };
        for (String input : inputs) {
            parts.add(normalize(input));
        }
        String text = String.join(parts, '|');
        Blob digest = Crypto.generateDigest('SHA-256', Blob.valueOf(text));
        return EncodingUtil.convertToHex(digest).substring(0, 32);
    }
}
```

### 2. The invocable action

```apex
public with sharing class RefundFeeAction {
    public class Request {
        @InvocableVariable(label='Conversation Id' required=true
            description='Id of the current conversation')
        public String conversationId;
        @InvocableVariable(label='Fee Id' required=true
            description='Id of the fee to refund')
        public String feeId;
    }

    public class Response {
        @InvocableVariable(label='Status'
            description='Done, AlreadyDone, InProgress, Unknown or Failed')
        public String status;
        @InvocableVariable(label='Message'
            description='What the agent should tell the customer')
        public String message;
        @InvocableVariable(label='Refund Reference')
        public String reference;
    }

    @InvocableMethod(label='Refund Fee'
        description='Refunds a late fee once. Safe to call again; repeats return the original result.')
    public static List<Response> refund(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request req : requests) {
            out.add(handle(req));
        }
        return out;
    }

    private static Response handle(Request req) {
        String key = ActionKey.build(req.conversationId, 'refundFee', new List<String>{ req.feeId });
        List<Agent_Action_Log__c> rows = [
            SELECT Id, Status__c, Attempts__c, Reference__c, Message__c
            FROM Agent_Action_Log__c WHERE Action_Key__c = :key LIMIT 1
        ];
        Agent_Action_Log__c row = rows.isEmpty() ? null : rows[0];
        Response res = new Response();

        if (row != null && row.Status__c == 'Succeeded') {
            res.status = 'AlreadyDone';
            res.reference = row.Reference__c;
            res.message = 'This fee was already refunded. Reference ' + row.Reference__c + '.';
            return res;
        }
        if (row != null && row.Status__c == 'InProgress') {
            res.status = 'InProgress';
            res.message = 'This refund is already being processed. Do not repeat it.';
            return res;
        }

        if (row == null) {
            row = new Agent_Action_Log__c(
                Action_Key__c = key, Action_Name__c = 'refundFee',
                Conversation_Id__c = req.conversationId, Attempts__c = 0);
        }
        row.Attempts__c = row.Attempts__c + 1;
        row.Status__c = 'InProgress';
        upsert row Action_Key__c;
        // Commit the ledger row now: a callout is not allowed with uncommitted DML,
        // so the actual call is made through the helper below in a separate step.
        return BillingClient.refundAndRecord(key, req.feeId);
    }
}
```

An invocable method that does DML and then a callout in the same transaction hits the uncommitted work restriction. The safe shape is to write the ledger first and call out from a separate transaction, for example a Queueable that records the result, or a Flow that runs the DML in an earlier, committed step. The helper below shows the callout and the record step; adapt where it runs to your architecture.

### 3. The billing call and result recording

```apex
public with sharing class BillingClient {
    // Call this from a transaction that has no uncommitted DML (for example a Queueable).
    public static RefundFeeAction.Response refundAndRecord(String key, String feeId) {
        RefundFeeAction.Response res = new RefundFeeAction.Response();
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Billing/refunds');
        req.setMethod('POST');
        req.setTimeout(15000);
        req.setHeader('Content-Type', 'application/json');
        req.setHeader('Idempotency-Key', key);
        req.setBody(JSON.serialize(new Map<String, Object>{ 'feeId' => feeId }));

        Agent_Action_Log__c row = new Agent_Action_Log__c(Action_Key__c = key);
        try {
            HttpResponse http = new Http().send(req);
            Integer code = http.getStatusCode();
            if (code >= 200 && code < 300) {
                Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(http.getBody());
                row.Status__c = 'Succeeded';
                row.Reference__c = String.valueOf(body.get('id'));
                row.Message__c = 'Refund created';
                res.status = 'Done';
                res.reference = row.Reference__c;
                res.message = 'The fee was refunded. Reference ' + row.Reference__c + '.';
            } else if (code >= 400 && code < 500 && code != 408 && code != 429) {
                row.Status__c = 'Failed';
                row.Last_Error__c = 'HTTP ' + code;
                res.status = 'Failed';
                res.message = 'The refund was not allowed. Do not retry; offer a human agent.';
            } else {
                row.Status__c = 'Unknown';
                row.Last_Error__c = 'HTTP ' + code;
                res.status = 'Unknown';
                res.message = 'The refund could not be confirmed yet. Do not promise it and do not repeat it.';
            }
        } catch (System.CalloutException e) {
            row.Status__c = 'Unknown';
            row.Last_Error__c = e.getMessage();
            res.status = 'Unknown';
            res.message = 'The refund could not be confirmed yet. Do not promise it and do not repeat it.';
        }
        upsert row Action_Key__c;
        return res;
    }
}
```

### 4. Tests

```apex
@IsTest
private class RefundFeeActionTest {
    private class BillingMock implements HttpCalloutMock {
        public Integer calls = 0;
        private Integer code;
        BillingMock(Integer code) { this.code = code; }
        public HttpResponse respond(HttpRequest req) {
            calls++;
            if (code == 0) {
                throw new CalloutException('Read timed out');
            }
            HttpResponse res = new HttpResponse();
            res.setStatusCode(code);
            res.setBody('{"id":"RF-1"}');
            return res;
        }
    }

    @IsTest
    static void keyIsStableAndIgnoresSpacingAndCase() {
        String a = ActionKey.build('conv-1', 'refundFee', new List<String>{ 'FEE-1' });
        String b = ActionKey.build(' CONV-1 ', 'refundFee', new List<String>{ ' fee-1 ' });
        String c = ActionKey.build('conv-2', 'refundFee', new List<String>{ 'FEE-1' });
        System.assertEquals(a, b);
        System.assertNotEquals(a, c);
        System.assertEquals(32, a.length());
    }

    @IsTest
    static void successRecordsReferenceOnce() {
        BillingMock mock = new BillingMock(201);
        Test.setMock(HttpCalloutMock.class, mock);
        String key = ActionKey.build('conv-1', 'refundFee', new List<String>{ 'FEE-1' });
        RefundFeeAction.Response res = BillingClient.refundAndRecord(key, 'FEE-1');
        System.assertEquals('Done', res.status);
        System.assertEquals('RF-1', res.reference);
        System.assertEquals(1, [SELECT COUNT() FROM Agent_Action_Log__c WHERE Status__c = 'Succeeded']);
    }

    @IsTest
    static void timeoutIsUnknownNotFailed() {
        Test.setMock(HttpCalloutMock.class, new BillingMock(0));
        String key = ActionKey.build('conv-1', 'refundFee', new List<String>{ 'FEE-1' });
        RefundFeeAction.Response res = BillingClient.refundAndRecord(key, 'FEE-1');
        System.assertEquals('Unknown', res.status);
        System.assert(res.message.contains('Do not'));
    }

    @IsTest
    static void permanentRejectionIsFailed() {
        Test.setMock(HttpCalloutMock.class, new BillingMock(403));
        String key = ActionKey.build('conv-1', 'refundFee', new List<String>{ 'FEE-1' });
        System.assertEquals('Failed', BillingClient.refundAndRecord(key, 'FEE-1').status);
    }

    @IsTest
    static void repeatAfterSuccessReturnsAlreadyDoneWithoutCalling() {
        BillingMock mock = new BillingMock(201);
        Test.setMock(HttpCalloutMock.class, mock);
        String key = ActionKey.build('conv-1', 'refundFee', new List<String>{ 'FEE-1' });
        insert new Agent_Action_Log__c(Action_Key__c = key, Status__c = 'Succeeded',
            Reference__c = 'RF-9', Attempts__c = 1);
        RefundFeeAction.Request req = new RefundFeeAction.Request();
        req.conversationId = 'conv-1';
        req.feeId = 'FEE-1';
        List<RefundFeeAction.Response> out = RefundFeeAction.refund(
            new List<RefundFeeAction.Request>{ req });
        System.assertEquals('AlreadyDone', out[0].status);
        System.assertEquals('RF-9', out[0].reference);
        System.assertEquals(0, mock.calls);
    }
}
```

This Apex is syntax-checked but not compiled in an org. Test and adjust in your own environment, particularly how the DML and callout are split in step 2.

## What happens behind the scenes

1. The customer asks for a refund. The reasoning engine picks the `Refund Fee` action and fills in the conversation id and fee id.
2. `RefundFeeAction` builds the key from those inputs. The same request always hashes to the same 32 characters.
3. It looks for that key in `Agent_Action_Log__c`. On the first request there is no row, so it creates one `InProgress`.
4. The billing call carries `Idempotency-Key`. On success the row becomes `Succeeded` with the refund reference.
5. If the call times out, the row becomes `Unknown` and the action returns a message telling the agent not to promise or repeat.
6. The customer asks again, or the platform retries. The same key finds the row. If `Succeeded`, the action returns `AlreadyDone` with the original reference and does not call billing. If `Unknown`, the call is repeated with the same key, so billing replays or completes the original refund rather than creating a second one.
7. The agent speaks from the returned `status` and `message`, so what the customer hears matches what happened.

## Design choices worth making deliberately

**What belongs in the key.** Include the inputs that define the business intent (the fee id), plus the conversation. Leave out anything that changes between attempts: timestamps, random ids, the model's free-text wording. If a customer legitimately wants a second, different refund, that is a different fee id and therefore a different key.

**Read-only actions.** An action that only reads data needs no ledger; repeating it is harmless. Spend the effort on actions that create, update, send or charge.

**Stuck InProgress rows.** If a job crashes after writing `InProgress`, the row can stay that way forever. Give it a timestamp and treat an `InProgress` row older than a few minutes as `Unknown`.

**Tell the model what to do.** The status text is part of the agent's instructions at run time. Words like "Do not promise it and do not repeat it" steer the agent better than a bare code. Also add a test conversation for the repeated and uncertain cases, as described in [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/).

## Test it and verify

1. Run `node --test tools/actionKit.test.mjs`. Expected: 9 pass.
2. Run the Apex tests: `sf apex run test --tests RefundFeeActionTest --result-format human --wait 10`. Expected: 5 pass.
3. In the Agentforce testing tools, send the utterance "Refund my late fee FEE-1" twice in one conversation. Expected: one `Succeeded` row in `Agent_Action_Log__c`, and the second answer says it was already refunded with the same reference.
4. Point the Named Credential at a slow test server (30-second delay) and repeat. Expected: the first answer says it could not be confirmed, the row is `Unknown`, and a repeat after the server recovers ends `Succeeded` with one refund.
5. Start a new conversation and ask for the same fee. Expected: a new key, so the action runs again; the billing system should still reject a second refund of the same fee as a business rule. Idempotency protects retries; business rules protect repeats.

## Common mistakes and fixes

- **Symptom: two refunds in one conversation.** Cause: no ledger or a random key. Fix: derive the key from the conversation, action name and normalised inputs.
- **Symptom: the key differs for the same refund.** Cause: spacing, case or a timestamp in the key. Fix: normalise inputs and exclude time.
- **Symptom: `You have uncommitted work pending` in the action.** Cause: DML before the callout. Fix: commit the ledger row in an earlier transaction or run the callout from a Queueable or Flow step.
- **Symptom: the agent says "done" after a timeout.** Cause: the action returned a success-like message. Fix: return `Unknown` with explicit wording.
- **Symptom: the agent keeps retrying a rejected request.** Cause: a vague error. Fix: return `Failed` with "Do not retry; offer a human agent".
- **Symptom: a stuck `InProgress` blocks the customer.** Cause: a crash after the first write. Fix: age out old `InProgress` rows to `Unknown`.
- **Symptom: the same fee is refunded in a second conversation.** Cause: idempotency only covers retries. Fix: enforce the business rule in the billing system as well.

## Key takeaways

- Agents repeat actions. Make every state-changing action idempotent.
- Derive the key from stable business inputs, never from time or random values.
- Check the ledger first and return the original result with a clear `AlreadyDone` status.
- Treat timeouts as `Unknown` and tell the agent in plain words not to promise or repeat.
- Send the key to the external system too, so both sides protect against duplicates.

## Where to go next

- [Timeouts, duplicates and external IDs](/articles/idempotent-retries-timeouts-and-external-ids/)
- [Partial batch failures and retry only the failures](/articles/batch-partial-failures-per-record-status-retry/)
- [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/)
- [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/)
