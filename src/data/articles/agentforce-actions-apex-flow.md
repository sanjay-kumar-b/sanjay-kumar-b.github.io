---
title: "Agentforce Actions: Building Apex and Flow Actions That Agents Use Well"
description: "Build reliable agent actions: bulk-safe invocable Apex with clear descriptions, an idempotent write action, a Flow action with a fault path, and tests."
category: agentforce
tags: [Agentforce, Agent Actions, Apex, Flows, Intermediate]
publishedAt: 2026-11-10
updatedAt: 2026-11-15
cover: /images/covers/agentforce-actions-apex-flow.jpg
sources:
  - title: "Legacy Guide: Agentforce Reasoning, Subagents, Instructions, and Actions"
    url: "https://www.salesforce.com/agentforce/legacy-guide/"
  - title: "Agentforce in Slack: custom Slack actions (Apex action example)"
    url: "https://docs.slack.dev/ai/customizing-agentforce-agents-with-custom-slack-actions"
  - title: "Create Custom Actions Using Apex Invocable Method"
    url: "https://developer.salesforce.com/docs/einstein/genai/guide/agent-invocablemethod.html"
---

Actions are how an agent does real work. Per Salesforce's guide, each action has a **name**, **action instructions** and **input instructions**, and actions can be reused across subagents. This article builds two Apex actions (one read-only, one that changes data safely) and a Flow action, with the rules that make agents use them correctly.

## The business scenario

Summit Outdoor (a fictional retailer) has a support agent. Customers ask "where is my order?" and "I want to return it". The first needs a read-only lookup. The second must create a return Case, but only for an order that was delivered within 30 days, and never twice for the same order. A third need is a Flow that an admin maintains: tell the customer the closest store that has an item. The team wants all three to be safe when the model calls them repeatedly or with odd inputs.

## Before you start: setup

### In Salesforce

1. Use a sandbox with Agentforce available. Create `Order__c` with `Status__c` (Processing, Shipped, Delivered), `Delivered_On__c` (date) and `Contact_Email__c` (email). Add a lookup field `Order__c` on Case (named `Order__c` as a custom field on Case) and a checkbox `Return_Request__c` on Case.
2. Create a permission set `Agent_Order_Actions` giving read on `Order__c`, create and read on Case, and access to the Apex classes `OrderStatusAction` and `ReturnRequestAction`. The agent's user needs it. In Slack's tutorial the Einstein Agent User profile needs Apex class access to the action classes, and your setup is similar.
3. For the Flow action, create `Store_Stock__c` with `Store_Name__c`, `Item_Code__c` and `Quantity__c`, and a few records.
4. Check current Agentforce documentation for how to add an action to a subagent in your release, and which actions need extra licences. The guide notes that prompt template, MuleSoft API, External Service and predictive model actions need an additional licence, while this article's Apex and Flow actions do not appear on that list; confirm with your Salesforce contact.

### In the external system

None. If orders lived in an ERP, the action would call it through a Named Credential, as in the callouts articles, and the same design rules would apply.

## How it works

Action types:

- **Flow:** low-code, good for record lookups, updates and approvals.
- **Apex (invocable):** full code for logic, callouts and complex queries.
- **Prompt template:** generate text from a Prompt Builder template.
- **API, MuleSoft or external:** call external systems, often through Named Credentials.
- **MCP-based tools:** see the MCP article.

Designing actions that agents use correctly:

1. **One action, one purpose.** Do not create a "do everything" action.
2. **Names and descriptions in plain language** ("Get order status", not "OrdSvc_v2").
3. **Few, typed inputs.** Let the agent ask for what is missing.
4. **Deterministic validation in code**, not in instructions.
5. **Return only what the agent needs**, avoiding personal data it should not repeat.
6. **Read-only first**, then actions that change data, with confirmation steps in the instructions.
7. **Limit per subagent:** the guide suggests no more than about 15.

## Basic example

A minimal Apex action:

```apex
public with sharing class OrderStatusBasic {

    public class Request {
        @InvocableVariable(label='Order Number' description='The customer order number, for example ORD-1001' required=true)
        public String orderNumber;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Current order status')
        public String status;
        @InvocableVariable(label='Error' description='Set when the order could not be found')
        public String errorMessage;
    }

    @InvocableMethod(label='Get Order Status' description='Returns the status for one order number')
    public static List<Response> run(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response res = new Response();
            List<Order__c> rows = [SELECT Status__c FROM Order__c WHERE Name = :r.orderNumber WITH USER_MODE LIMIT 1];
            if (rows.isEmpty()) {
                res.errorMessage = 'No order found for ' + r.orderNumber;
            } else {
                res.status = rows[0].Status__c;
            }
            out.add(res);
        }
        return out;
    }
}
```

The descriptions matter because the model uses them to decide when and how to call the action. The error field lets the agent explain a problem instead of failing. But this version queries inside a loop, which breaks when the platform passes many requests at once. The advanced version fixes that.

## Advanced end-to-end example

**force-app/main/default/classes/OrderStatusAction.cls** (read-only, bulk-safe)

```apex
public with sharing class OrderStatusAction {

    public class Request {
        @InvocableVariable(label='Order Number' description='The customer order number, for example ORD-1001' required=true)
        public String orderNumber;
        @InvocableVariable(label='Email' description='Email address on the order. Required so we only reveal an order to its owner.' required=true)
        public String email;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Current order status: Processing, Shipped or Delivered')
        public String status;
        @InvocableVariable(label='Delivered On' description='Delivery date in ISO format, only when delivered')
        public String deliveredOn;
        @InvocableVariable(label='Error' description='Set when no order matched the order number and email')
        public String errorMessage;
    }

    @InvocableMethod(label='Get Order Status' description='Returns the status of one order when the order number and email match')
    public static List<Response> run(List<Request> requests) {
        Set<String> numbers = new Set<String>();
        for (Request r : requests) {
            numbers.add(r.orderNumber);
        }
        Map<String, Order__c> byNumber = new Map<String, Order__c>();
        for (Order__c o : [
            SELECT Name, Status__c, Delivered_On__c, Contact_Email__c
            FROM Order__c WHERE Name IN :numbers WITH USER_MODE
        ]) {
            byNumber.put(o.Name, o);
        }
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response res = new Response();
            Order__c o = byNumber.get(r.orderNumber);
            if (o == null || o.Contact_Email__c == null || !o.Contact_Email__c.equalsIgnoreCase(r.email)) {
                res.errorMessage = 'No order found for that order number and email.';
            } else {
                res.status = o.Status__c;
                res.deliveredOn = o.Delivered_On__c == null ? null : String.valueOf(o.Delivered_On__c);
            }
            out.add(res);
        }
        return out;
    }
}
```

**force-app/main/default/classes/ReturnRequestAction.cls** (changes data: validated in code, idempotent)

```apex
public with sharing class ReturnRequestAction {

    public static final Integer RETURN_WINDOW_DAYS = 30;

    public class Request {
        @InvocableVariable(label='Order Number' description='The order the customer wants to return' required=true)
        public String orderNumber;
        @InvocableVariable(label='Email' description='Email address on the order' required=true)
        public String email;
        @InvocableVariable(label='Reason' description='Short reason for the return, in the customer words')
        public String reason;
    }

    public class Response {
        @InvocableVariable(label='Created' description='True when a new return case was created')
        public Boolean created;
        @InvocableVariable(label='Case Number' description='Case number to quote to the customer')
        public String caseNumber;
        @InvocableVariable(label='Message' description='Plain-language outcome the agent can relay')
        public String message;
    }

    @InvocableMethod(label='Start Return' description='Creates a return case for a delivered order inside the return window. Does nothing otherwise.')
    public static List<Response> run(List<Request> requests) {
        Set<String> numbers = new Set<String>();
        for (Request r : requests) {
            numbers.add(r.orderNumber);
        }
        Map<String, Order__c> orders = new Map<String, Order__c>();
        for (Order__c o : [
            SELECT Id, Name, Status__c, Delivered_On__c, Contact_Email__c
            FROM Order__c WHERE Name IN :numbers WITH USER_MODE
        ]) {
            orders.put(o.Name, o);
        }
        Map<Id, Order__c> ordersById = new Map<Id, Order__c>(orders.values());
        Set<Id> openReturnOrderIds = new Set<Id>();
        for (Case c : [
            SELECT Order__c FROM Case
            WHERE Order__c IN :ordersById.keySet() AND Return_Request__c = true AND IsClosed = false
            WITH USER_MODE
        ]) {
            openReturnOrderIds.add(c.Order__c);
        }

        List<Response> out = new List<Response>();
        List<Case> toInsert = new List<Case>();
        List<Integer> insertPositions = new List<Integer>();
        Set<Id> reservedThisCall = new Set<Id>();

        for (Request r : requests) {
            Response res = new Response();
            res.created = false;
            Order__c o = orders.get(r.orderNumber);

            if (o == null || o.Contact_Email__c == null || !o.Contact_Email__c.equalsIgnoreCase(r.email)) {
                res.message = 'No order found for that order number and email.';
            } else if (o.Status__c != 'Delivered' || o.Delivered_On__c == null) {
                res.message = 'This order has not been delivered yet, so it cannot be returned.';
            } else if (o.Delivered_On__c.daysBetween(Date.today()) > RETURN_WINDOW_DAYS) {
                res.message = 'This order was delivered more than ' + RETURN_WINDOW_DAYS + ' days ago.';
            } else if (openReturnOrderIds.contains(o.Id) || reservedThisCall.contains(o.Id)) {
                res.message = 'A return is already open for this order.';
            } else {
                reservedThisCall.add(o.Id);
                toInsert.add(new Case(
                    Subject = 'Return request for ' + o.Name,
                    Description = r.reason,
                    Origin = 'Web',
                    Order__c = o.Id,
                    Return_Request__c = true
                ));
                insertPositions.add(out.size());
                res.message = 'Return created.';
            }
            out.add(res);
        }

        if (!toInsert.isEmpty()) {
            insert as user toInsert;
            Map<Id, Case> inserted = new Map<Id, Case>([SELECT Id, CaseNumber FROM Case WHERE Id IN :toInsert]);
            for (Integer i = 0; i < toInsert.size(); i++) {
                Response res = out[insertPositions[i]];
                res.created = true;
                res.caseNumber = inserted.get(toInsert[i].Id).CaseNumber;
            }
        }
        return out;
    }
}
```

**force-app/main/default/classes/AgentActionsTest.cls**

```apex
@IsTest
private class AgentActionsTest {

    @TestSetup
    static void setup() {
        insert new List<Order__c>{
            new Order__c(Name = 'ORD-1', Status__c = 'Delivered', Delivered_On__c = Date.today().addDays(-5), Contact_Email__c = 'a@example.com'),
            new Order__c(Name = 'ORD-2', Status__c = 'Shipped', Contact_Email__c = 'b@example.com'),
            new Order__c(Name = 'ORD-3', Status__c = 'Delivered', Delivered_On__c = Date.today().addDays(-60), Contact_Email__c = 'c@example.com')
        };
    }

    private static ReturnRequestAction.Request ret(String n, String e) {
        ReturnRequestAction.Request r = new ReturnRequestAction.Request();
        r.orderNumber = n;
        r.email = e;
        r.reason = 'Too small';
        return r;
    }

    @IsTest
    static void statusRequiresMatchingEmail() {
        OrderStatusAction.Request r = new OrderStatusAction.Request();
        r.orderNumber = 'ORD-1';
        r.email = 'wrong@example.com';
        OrderStatusAction.Response res = OrderStatusAction.run(new List<OrderStatusAction.Request>{ r })[0];
        System.assertEquals(null, res.status);
        System.assert(res.errorMessage != null);
    }

    @IsTest
    static void deliveredOrderInsideWindowCreatesCase() {
        ReturnRequestAction.Response res = ReturnRequestAction.run(new List<ReturnRequestAction.Request>{ ret('ORD-1', 'a@example.com') })[0];
        System.assertEquals(true, res.created);
        System.assertNotEquals(null, res.caseNumber);
        System.assertEquals(1, [SELECT COUNT() FROM Case WHERE Return_Request__c = true]);
    }

    @IsTest
    static void secondRequestDoesNotCreateAnotherCase() {
        ReturnRequestAction.run(new List<ReturnRequestAction.Request>{ ret('ORD-1', 'a@example.com') });
        ReturnRequestAction.Response res = ReturnRequestAction.run(new List<ReturnRequestAction.Request>{ ret('ORD-1', 'a@example.com') })[0];
        System.assertEquals(false, res.created);
        System.assert(res.message.contains('already open'));
        System.assertEquals(1, [SELECT COUNT() FROM Case WHERE Return_Request__c = true]);
    }

    @IsTest
    static void duplicateInsideOneCallCreatesOneCase() {
        List<ReturnRequestAction.Response> res = ReturnRequestAction.run(new List<ReturnRequestAction.Request>{
            ret('ORD-1', 'a@example.com'), ret('ORD-1', 'a@example.com')
        });
        System.assertEquals(true, res[0].created);
        System.assertEquals(false, res[1].created);
    }

    @IsTest
    static void undeliveredAndOldOrdersAreRejected() {
        List<ReturnRequestAction.Response> res = ReturnRequestAction.run(new List<ReturnRequestAction.Request>{
            ret('ORD-2', 'b@example.com'), ret('ORD-3', 'c@example.com')
        });
        System.assertEquals(false, res[0].created);
        System.assert(res[0].message.contains('not been delivered'));
        System.assertEquals(false, res[1].created);
        System.assert(res[1].message.contains('30 days'));
        System.assertEquals(0, [SELECT COUNT() FROM Case]);
    }
}
```

**force-app/main/default/flows/Find_Store_With_Stock.flow-meta.xml** is the admin-maintained Flow action (autolaunched, with inputs, an output and a fault path). If it fails to deploy, rebuild it in Flow Builder with the same elements.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>67.0</apiVersion>
    <label>Find Store With Stock</label>
    <description>Finds one store that has the requested item. Used as an agent action.</description>
    <processType>AutoLaunchedFlow</processType>
    <status>Draft</status>
    <variables>
        <name>ItemCode</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>true</isInput>
        <isOutput>false</isOutput>
    </variables>
    <variables>
        <name>StoreName</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>true</isOutput>
    </variables>
    <variables>
        <name>ErrorMessage</name>
        <dataType>String</dataType>
        <isCollection>false</isCollection>
        <isInput>false</isInput>
        <isOutput>true</isOutput>
    </variables>
    <decisions>
        <name>Found_Store</name>
        <label>Found Store</label>
        <locationX>176</locationX>
        <locationY>395</locationY>
        <defaultConnector>
            <targetReference>Set_Not_Found</targetReference>
        </defaultConnector>
        <defaultConnectorLabel>Not found</defaultConnectorLabel>
        <rules>
            <name>Has_Store</name>
            <conditionLogic>and</conditionLogic>
            <conditions>
                <leftValueReference>Get_Stock</leftValueReference>
                <operator>IsNull</operator>
                <rightValue>
                    <booleanValue>false</booleanValue>
                </rightValue>
            </conditions>
            <connector>
                <targetReference>Set_Store</targetReference>
            </connector>
            <label>Has store</label>
        </rules>
    </decisions>
    <assignments>
        <name>Set_Store</name>
        <label>Set Store</label>
        <locationX>50</locationX>
        <locationY>503</locationY>
        <assignmentItems>
            <assignToReference>StoreName</assignToReference>
            <operator>Assign</operator>
            <value>
                <elementReference>Get_Stock.Store_Name__c</elementReference>
            </value>
        </assignmentItems>
    </assignments>
    <assignments>
        <name>Set_Not_Found</name>
        <label>Set Not Found</label>
        <locationX>314</locationX>
        <locationY>503</locationY>
        <assignmentItems>
            <assignToReference>ErrorMessage</assignToReference>
            <operator>Assign</operator>
            <value>
                <stringValue>No store currently has that item.</stringValue>
            </value>
        </assignmentItems>
    </assignments>
    <assignments>
        <name>Set_Fault_Message</name>
        <label>Set Fault Message</label>
        <locationX>440</locationX>
        <locationY>287</locationY>
        <assignmentItems>
            <assignToReference>ErrorMessage</assignToReference>
            <operator>Assign</operator>
            <value>
                <stringValue>Store lookup is unavailable right now.</stringValue>
            </value>
        </assignmentItems>
    </assignments>
    <recordLookups>
        <name>Get_Stock</name>
        <label>Get Stock</label>
        <locationX>176</locationX>
        <locationY>287</locationY>
        <assignNullValuesIfNoRecordsFound>false</assignNullValuesIfNoRecordsFound>
        <connector>
            <targetReference>Found_Store</targetReference>
        </connector>
        <faultConnector>
            <targetReference>Set_Fault_Message</targetReference>
        </faultConnector>
        <filterLogic>and</filterLogic>
        <filters>
            <field>Item_Code__c</field>
            <operator>EqualTo</operator>
            <value>
                <elementReference>ItemCode</elementReference>
            </value>
        </filters>
        <filters>
            <field>Quantity__c</field>
            <operator>GreaterThan</operator>
            <value>
                <numberValue>0.0</numberValue>
            </value>
        </filters>
        <getFirstRecordOnly>true</getFirstRecordOnly>
        <object>Store_Stock__c</object>
        <storeOutputAutomatically>true</storeOutputAutomatically>
    </recordLookups>
    <start>
        <locationX>50</locationX>
        <locationY>0</locationY>
        <connector>
            <targetReference>Get_Stock</targetReference>
        </connector>
    </start>
</Flow>
```

## What happens behind the scenes

When the model decides to run an action, the platform builds the input from what the model extracted from the conversation, using your input descriptions as guidance. It then calls your Apex method with a list (usually one item, but possibly more), runs it as the agent's user, and passes the returned object back as text the model can read. The model never sees your code, only the names, descriptions and outputs. A clear error message in the output is therefore part of your design: it is what the model will paraphrase to the customer.

Because a model can retry an action, repeat itself, or call it with odd inputs, the write action is built to be **idempotent**: a second identical request finds the open return and does nothing, and two requests in one call are guarded by `reservedThisCall`. The validation (delivered, inside the window, email matches) lives in code, where it cannot be argued with. `insert as user` and `WITH USER_MODE` ensure the agent user's permissions apply, so a permission set mistake fails closed.

The Flow works the same way from the agent's side: its input variable becomes an input, its output variables become the result, and the fault path sets a friendly message rather than letting an unhandled fault reach the customer.

## Test it and verify

1. Deploy the objects, fields, classes, permission set and Flow to a sandbox, then run `AgentActionsTest` and confirm all five tests pass.
2. Open the Flow in Flow Builder, review it, and activate it.
3. Add the three actions to a subagent in the current builder, following the official steps for your release, and write plain-language action instructions for each.
4. In the preview, ask for an order status with and without the email, and confirm the agent asks for what is missing.
5. Ask to return a delivered order, then ask again. Confirm one Case exists.
6. Ask to return an undelivered order and an old order and confirm the agent explains why it cannot.
7. Look at the trace to see which action ran and with what inputs.

## Common mistakes and fixes

- **Queries or DML inside the loop.** The action receives a list; collect first and query once.
- **Throwing exceptions to report business problems.** Return an error or message field so the agent can explain it.
- **Validating in the instructions.** A model can be talked around. Check in code.
- **Vague descriptions.** The model decides from them. Write plain, specific text.
- **Write actions with no idempotency.** Retries create duplicates. Check for an existing record first.
- **Over-sharing data.** Return only what the agent needs to say.

## Key takeaways

- Actions turn conversations into results; names and descriptions are their documentation for the model.
- Make Apex actions bulk-safe, user-mode and error-returning.
- Validate and deduplicate in code, especially for actions that change data.
- Use Flow for admin-maintained logic, with a fault path and clear output variables.
- Ship read-only actions first, then writes, and test with varied phrasing.

## Where to go next

- Read [Agentforce basics: topics, instructions and actions](/articles/agentforce-agent-actions-basics/) for the design model.
- Read [Writing instructions for AI agents](/articles/writing-agent-instructions/) to tell the agent when to use each action.
- Read [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/) to test it properly.
