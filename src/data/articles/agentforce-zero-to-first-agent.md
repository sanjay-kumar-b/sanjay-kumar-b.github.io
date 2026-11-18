---
title: "Agentforce from Zero: Concepts, Terminology and Building Your First Agent"
description: "Build your first Agentforce service agent: setup, agent user, subagents, Apex actions, preview and tests, with an order status and returns scenario."
category: agentforce
tags: [Agentforce, Beginner, Agent Builder, Apex]
publishedAt: 2026-11-10
updatedAt: 2026-11-13
cover: /images/covers/agentforce-zero-to-first-agent.jpg
featured: true
sources:
  - title: "Legacy Guide: Agentforce Reasoning, Subagents, Instructions, and Actions"
    url: "https://www.salesforce.com/agentforce/legacy-guide/"
  - title: "Introducing Hybrid Reasoning with Agent Script"
    url: "https://developer.salesforce.com/blogs/2025/10/introducing-hybrid-reasoning-with-agent-script"
  - title: "The Salesforce Developers Guide to the Summer '26 Release"
    url: "https://developer.salesforce.com/blogs/2026/06/the-salesforce-developers-guide-to-the-summer-26-release"
  - title: "Build With Confidence: Inside the New Agentforce Builder"
    url: "https://admin.salesforce.com/blog/2026/build-with-confidence-inside-the-new-agentforce-builder"
  - title: "Enhance Your Agents in the New Agentforce Builder (migration)"
    url: "https://www.salesforce.com/agentforce/agent-builder/migration/"
  - title: "Create Custom Actions Using Apex Invocable Method"
    url: "https://developer.salesforce.com/docs/einstein/genai/guide/agent-invocablemethod.html"
  - title: "Best Practices for Building Agentforce Apex Actions"
    url: "https://developer.salesforce.com/blogs/2025/07/best-practices-for-building-agentforce-apex-actions"
  - title: "Agent Script Reference: Actions"
    url: "https://developer.salesforce.com/docs/ai/agentforce/guide/ascript-ref-actions.html"
  - title: "Agentforce Metadata Types"
    url: "https://developer.salesforce.com/docs/ai/agentforce/references/agents-metadata-tooling/agents-metadata.html"
  - title: "CLI reference: org create agent-user"
    url: "https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_org_create_agent-user.html"
  - title: "CLI reference: agent generate agent-spec"
    url: "https://developer.salesforce.com/docs/platform/salesforce-cli-reference/guide/cli_reference_agent_generate_agent-spec.html"
  - title: "Trailhead project: Configure an Agentforce Service Agent"
    url: "https://trailhead.salesforce.com/content/learn/projects/quick-start-build-your-first-agent-with-agentforce/configure-an-agentforce-service-agent"
---

**Agentforce** is Salesforce's platform for AI agents that can understand a request, decide what to do and take actions in your systems, not just generate text. An agent is made of a few parts you configure (subagents, instructions and actions) and a reasoning engine that combines them on every message.

The hard part of a first agent is not the chat window. It is the plumbing around it: which user the agent runs as, which data that user can read, which actions it may run, and how you prove it behaves. This article builds a small customer-service agent end to end. You turn on the features, create the agent user, write two Apex actions, attach them to subagents, preview the agent, and test the action code. Where I could not verify a menu label or a command flag in the official documentation, I say so.

## The business scenario

Harbor & Pine Outfitters (a fictional outdoor-gear retailer) sells online and ships with a carrier. Support is flooded with two questions: "Where is my order?" and "I want to return this." Harbor & Pine wants an agent, **Harbor Helper**, that does exactly two jobs:

1. **Order status.** A customer gives an order number and the email on the order. The agent says whether the order is processing, shipped or delivered, and gives the tracking number if there is one.
2. **Start a return.** For an order that was delivered inside the return window (30 days by default), the agent creates a **Case** for the support team. It must not create a second open return for the same order, and it must not create one for an order that is not delivered or is too old.

Everything else (refunds, damaged goods, angry customers) is outside the agent's scope and goes to a person. The agent must never reveal whether an order number exists unless the email matches.

## Before you start: setup

Agentforce changes quickly and menu labels can differ slightly by release. Where a path below comes from Salesforce documentation or a Trailhead project I opened, I say so. Always cross-check against the current Agentforce documentation for your release.

### In Salesforce

1. **Use a safe org.** A Developer Edition org or a sandbox with Agentforce licensed. Never production. Why: you deploy metadata and create test data. The new Agentforce Builder is included in Developer Edition orgs (Salesforce admin blog, February 2026). Verify: the App Launcher shows **Agentforce Studio**.
2. **Turn on Einstein.** Setup, Quick Find, **Einstein Setup**, turn it on and refresh the browser. Why: agents depend on it. Verify: the toggle stays on after the refresh. (Path from the Trailhead project "Configure an Agentforce Service Agent".)
3. **Turn on Agentforce.** Setup, Quick Find, **Agentforce Agents**, set the Agentforce toggle to On. Verify: the toggle is on and the page lists agents. (Same Trailhead project.)
4. **Know your Data 360 position.** Salesforce's guide says Agentforce uses Data 360 (formerly Data Cloud) as an integral part, for features such as Agent Analytics, feedback logs, audit trail and data libraries. This article's agent reads and writes ordinary CRM records through Apex, so it needs no data library or retriever. Verify with your account team which Data 360 features are provisioned in your org, and do not assume that preview or analytics will behave the same without them.
5. **Check licensing for what you plan to use.** The guide notes that prompt template, MuleSoft API, External Service and predictive model actions need an additional license. Apex and Flow actions in this article do not appear on that list. Verify with your Salesforce contact before you rely on this in production.
6. **Deploy the data model and code.** The advanced section has the files: a `Store_Order__c` custom object, a `Case` lookup to it, a `Return_Policy__mdt` custom metadata type, two action classes, and a permission set. Verify: `sf project deploy start` finishes with no errors.
7. **Create the agent user.** A service agent that serves unauthenticated customers runs as a dedicated user, and what it can read is whatever that user can read. Two ways, both documented:
   - In the UI, as the Trailhead project does: open the `EinsteinServiceAgent User` record (Setup, Users) and set its profile to **Einstein Agent User**, or
   - With the CLI: `sf org create agent-user`. Per the CLI reference it creates a user on the **Einstein Agent User** profile with the permission sets `AgentforceServiceAgentBase`, `AgentforceServiceAgentUser` and `EinsteinGPTPromptTemplateUser`, no password, and it checks that the licenses exist.
   Verify: the user appears in Setup, Users, and has those permission sets under Permission Set Assignments.
8. **Give the agent user your own permission set.** Assign `Harbor_Pine_Agent_Access` (from the advanced section) to the agent user. Why: the Apex actions run in user mode, so the agent user needs object, field and Apex class access. Verify: Setup, Users, the agent user, Permission Set Assignments lists it.
9. **Load test data.** Run the seed script from the advanced section. Verify: `SELECT COUNT() FROM Store_Order__c` returns 4.

### In the external system

None. Both actions use only data inside Salesforce. The sibling article [Agentforce agent actions basics](/articles/agentforce-agent-actions-basics/) adds a carrier tracking callout with a Named Credential.

### On your machine

1. Install or update the Salesforce CLI (`sf update`) and VS Code with the Salesforce Extension Pack. Verify: `sf --version` prints a version and `sf agent --help` lists agent commands.
2. Authorize the org: `sf org login web --alias harborpine`. Verify: `sf org list` shows it.

## How it works

### Terminology (updated in 2026)

Salesforce's own guide notes these renamings as of April 2026:

- **Topics are now subagents.**
- **Topic Selector is now Agent Router.**
- **Connected Agent is now Connected Subagent.**

Older tutorials and screens may still say "topic". It is the same concept. The Agent Script reference lists `topic` as a deprecated keyword for `subagent`.

### The mental model

The **reasoning engine** decides what to do using three levers.

| Lever | What it is | In Harbor Helper |
|---|---|---|
| Subagent | A job the agent can do. Has a name, a **classification description** used for routing, and a **scope** | `Order status`, `Returns` |
| Instructions | Natural-language guidance inside a subagent. Interpreted by an LLM, so not deterministic | "Ask for the order number and email first" |
| Action | A tool the agent can run: Apex, Flow, prompt template and others | `Check Order Status`, `Start Return` |

One turn of a conversation, per the guide:

```text
customer message
  -> Agent Router classifies it into a subagent
     (uses only the subagent name and classification description)
  -> the subagent scope, instructions and actions are added to the prompt
     together with the conversation history
  -> the LLM decides: run an action, ask a question, or answer
  -> an action runs, its output goes back to the LLM (this can repeat)
  -> grounding check on the draft reply
  -> reply to the customer
```

The **grounding check** verifies that the reply is based on source information, follows the subagent's scope and instructions, and is free of prompt injection. If it fails the agent retries, and if it still fails it sends a standard "I can't help with that" style message.

### Where determinism comes from

Instructions are guidance, not rules. The guide's design principle is to use **filters** (conditions that include or remove subagents and actions before the LLM sees them) for deterministic control, instructions for guidance, and **critical business logic in action code**. That is why the return window, the email check and the duplicate check in this article live in Apex, not in the instructions. **Agent Script** is the language of the new Agentforce Builder. It lets you write structured logic around the LLM, which Salesforce calls hybrid reasoning. Its blocks include `config`, `variables`, `system`, `start_agent`, `subagent`, `reasoning` and `after_reasoning`.

Sizing hints from the guide: roughly 10 to 15 subagents per agent and no more than about 15 actions per subagent.

### Two builders, and which one you use

The new **Agentforce Builder** lives in Agentforce Studio (App Launcher). It opens in **Canvas view**, which summarizes Agent Script in blocks, and has a **Script view** for writing Agent Script directly. Per Salesforce's migration page, starting the week of July 13, 2026 new agents can only be created in the new builder. Agents already built in the legacy Setup builder keep running and stay editable. Click-paths in older blog posts that start at Setup, Agentforce Agents, New Agent describe the legacy builder.

### Agent types and identity

An **employee agent** inherits the permissions of the logged-in user. A **service agent** runs as the assigned agent user for unauthenticated channels, or as the logged-in Experience Cloud user when Credential-Based User Verification is enabled (Salesforce developer blog on Apex actions). Harbor Helper is a service agent on a public website, so it runs as the agent user and you must assume the agent user can see more than the customer is allowed to see. That is why the action asks for the email and returns almost nothing when it does not match.

### Prompt template versus agent

A **prompt template** is single-turn and stateless: it generates output. An **agent** plans, reasons, calls actions and adapts over a conversation.

## Basic example

The smallest useful agent action: look up an order by number and return its status. It is intentionally missing the email check, so use it only to see the moving parts, then replace it with the advanced version.

```apex
public with sharing class BasicOrderStatusAction {

    public class Request {
        // The label and description are what the agent reads. Be specific.
        @InvocableVariable(required=true label='Order Number' description='Order number such as HP-1001')
        public String orderNumber;
    }

    public class Response {
        @InvocableVariable(label='Status' description='Processing, Shipped, Delivered or Cancelled')
        public String status;
        @InvocableVariable(label='Found' description='True when the order exists')
        public Boolean isFound;
    }

    @InvocableMethod(
        label='Check Basic Order Status'
        description='Returns the status of an order when given its order number'
    )
    public static List<Response> check(List<Request> requests) {
        List<Response> responses = new List<Response>();
        for (Request req : requests) {
            Response res = new Response();
            // BAD in production: a query inside a loop, and no identity check.
            // It is here only to keep the first example short.
            List<Store_Order__c> found = [
                SELECT Status__c FROM Store_Order__c
                WHERE Order_Number__c = :req.orderNumber WITH USER_MODE LIMIT 1
            ];
            res.isFound = !found.isEmpty();
            res.status = res.isFound ? found[0].Status__c : null;
            responses.add(res);
        }
        return responses;
    }
}
```

Three rules this example already follows. The method takes a `List` of request objects and returns a `List` of response objects, because the platform can hand a method several requests at once. Every `@InvocableVariable` has a `label` and `description`, which Agentforce Builder uses as defaults for the action's input and output instructions. The class is `with sharing`, and the query uses `WITH USER_MODE`.

To wire it into an agent, follow the path from the Trailhead module "Agent Customization with Apex" (verified on the Trailhead page; labels may differ in your release):

1. App Launcher, **Agentforce Studio**, **Agent Customization**, **New Version**.
2. Under Subagents, pick your subagent. Under "Actions Available For Reasoning", click **Select action**, then **Create a custom action**.
3. Set **Reference Action Type** to Apex, **Reference Action Category** to Invocable Method, and **Reference Action** to your method. Click **Create and Open**.
4. Review Inputs and Outputs. "Require input to execute action" is on by default when the Apex variable has `required=true`. Tick **Show in conversation** on outputs the customer should see.
5. **Save**, **Commit Version**, then **Activate**.
6. In the builder, click **Preview**, confirm **Live Test Mode**, and ask "Where is order HP-1001?". Open the conversation steps and confirm the agent chose your action.

## Advanced end-to-end example

The advanced build adds the identity check, the return policy, duplicate protection, bulk safety and tests. Files:

- Data model and configuration: the order object and fields, a `Case` lookup, a custom metadata type for the return window, a permission set.
- Code: `OrderSelector`, `OrderStatusAction`, `ReturnCaseGuard`, `StartReturnAction`.
- Agent: instructions text and a CLI path with commands whose syntax I verified.
- Tests: an Apex test class that runs as a user with only the permission set.

### Data model

**`force-app/main/default/objects/Store_Order__c/Store_Order__c.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Store Order</label>
    <pluralLabel>Store Orders</pluralLabel>
    <nameField>
        <label>Store Order Name</label>
        <type>Text</type>
    </nameField>
    <deploymentStatus>Deployed</deploymentStatus>
    <sharingModel>ReadWrite</sharingModel>
</CustomObject>
```

The sharing model is `ReadWrite` on purpose: the agent user has to read any customer's order. The protection is the email check inside the action, not record sharing.

**`force-app/main/default/objects/Store_Order__c/fields/Order_Number__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Order_Number__c</fullName>
    <label>Order Number</label>
    <length>20</length>
    <type>Text</type>
    <unique>true</unique>
    <caseSensitive>false</caseSensitive>
    <externalId>true</externalId>
</CustomField>
```

**`force-app/main/default/objects/Store_Order__c/fields/Customer_Email__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Customer_Email__c</fullName>
    <label>Customer Email</label>
    <type>Email</type>
</CustomField>
```

**`force-app/main/default/objects/Store_Order__c/fields/Status__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <label>Status</label>
    <type>Picklist</type>
    <valueSet>
        <restricted>true</restricted>
        <valueSetDefinition>
            <sorted>false</sorted>
            <value><fullName>Processing</fullName><default>true</default><label>Processing</label></value>
            <value><fullName>Shipped</fullName><default>false</default><label>Shipped</label></value>
            <value><fullName>Delivered</fullName><default>false</default><label>Delivered</label></value>
            <value><fullName>Cancelled</fullName><default>false</default><label>Cancelled</label></value>
        </valueSetDefinition>
    </valueSet>
</CustomField>
```

**`force-app/main/default/objects/Store_Order__c/fields/Placed_On__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Placed_On__c</fullName>
    <label>Placed On</label>
    <type>Date</type>
</CustomField>
```

**`force-app/main/default/objects/Store_Order__c/fields/Delivered_On__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Delivered_On__c</fullName>
    <label>Delivered On</label>
    <type>Date</type>
</CustomField>
```

**`force-app/main/default/objects/Store_Order__c/fields/Tracking_Number__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Tracking_Number__c</fullName>
    <label>Tracking Number</label>
    <length>40</length>
    <type>Text</type>
</CustomField>
```

**`force-app/main/default/objects/Case/fields/Store_Order__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Store_Order__c</fullName>
    <label>Store Order</label>
    <referenceTo>Store_Order__c</referenceTo>
    <relationshipLabel>Cases</relationshipLabel>
    <relationshipName>Cases</relationshipName>
    <deleteConstraint>SetNull</deleteConstraint>
    <type>Lookup</type>
</CustomField>
```

### Return policy in custom metadata

**`force-app/main/default/objects/Return_Policy__mdt/Return_Policy__mdt.object-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Return Policy</label>
    <pluralLabel>Return Policies</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>
```

**`force-app/main/default/objects/Return_Policy__mdt/fields/Return_Window_Days__c.field-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Return_Window_Days__c</fullName>
    <fieldManageability>DeveloperControlled</fieldManageability>
    <label>Return Window Days</label>
    <precision>3</precision>
    <scale>0</scale>
    <type>Number</type>
</CustomField>
```

**`force-app/main/default/customMetadata/Return_Policy.Default.md-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CustomMetadata xmlns="http://soap.sforce.com/2006/04/metadata"
                xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
                xmlns:xsd="http://www.w3.org/2001/XMLSchema">
    <label>Default</label>
    <protected>false</protected>
    <values>
        <field>Return_Window_Days__c</field>
        <value xsi:type="xsd:double">30.0</value>
    </values>
</CustomMetadata>
```

### Permission set for the agent user

**`force-app/main/default/permissionsets/Harbor_Pine_Agent_Access.permissionset-meta.xml`**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Harbor Pine Agent Access</label>
    <description>Lets the Harbor Helper agent user read orders and create return cases.</description>
    <hasActivationRequired>false</hasActivationRequired>
    <classAccesses>
        <apexClass>OrderStatusAction</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>StartReturnAction</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>OrderSelector</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <classAccesses>
        <apexClass>ReturnCaseGuard</apexClass>
        <enabled>true</enabled>
    </classAccesses>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Store_Order__c</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Case</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Store_Order__c.Order_Number__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Store_Order__c.Customer_Email__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Store_Order__c.Status__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Store_Order__c.Delivered_On__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>false</editable>
        <field>Store_Order__c.Tracking_Number__c</field>
        <readable>true</readable>
    </fieldPermissions>
    <fieldPermissions>
        <editable>true</editable>
        <field>Case.Store_Order__c</field>
        <readable>true</readable>
    </fieldPermissions>
</PermissionSet>
```

Standard Case fields such as Subject and Description are normally visible by default. If your org hides one, a user-mode insert fails with a field-level security error, and you add that field here.

### Apex: selector and the status action

**`force-app/main/default/classes/OrderSelector.cls`**

```apex
public with sharing class OrderSelector {

    // Order numbers are matched case-insensitively and without surrounding spaces.
    public static String key(String orderNumber) {
        return orderNumber == null ? null : orderNumber.trim().toUpperCase();
    }

    // One query for any number of order numbers. WITH USER_MODE enforces CRUD, FLS and sharing
    // for the running user, which is the agent user for a service agent.
    public static Map<String, Store_Order__c> byOrderNumber(Set<String> keys) {
        Map<String, Store_Order__c> result = new Map<String, Store_Order__c>();
        if (keys.isEmpty()) {
            return result;
        }
        for (Store_Order__c ord : [
            SELECT Id, Order_Number__c, Customer_Email__c, Status__c,
                   Delivered_On__c, Tracking_Number__c
            FROM Store_Order__c
            WHERE Order_Number__c IN :keys
            WITH USER_MODE
        ]) {
            result.put(key(ord.Order_Number__c), ord);
        }
        return result;
    }

    public static Boolean emailMatches(Store_Order__c ord, String email) {
        return ord != null
            && String.isNotBlank(email)
            && String.isNotBlank(ord.Customer_Email__c)
            && ord.Customer_Email__c.trim().equalsIgnoreCase(email.trim());
    }
}
```

**`force-app/main/default/classes/OrderStatusAction.cls`**

```apex
public with sharing class OrderStatusAction {

    // The same text for "no such order" and "wrong email", so the agent cannot be used
    // to find out which order numbers exist.
    @TestVisible
    private static final String NO_MATCH =
        'I could not find an order with that order number and email address.';

    public class Request {
        @InvocableVariable(
            required=true label='Order Number'
            description='The order number the customer gave, for example HP-1001.'
        )
        public String orderNumber;

        @InvocableVariable(
            required=true label='Customer Email'
            description='The email address on the order. Ask the customer for it. Never guess it.'
        )
        public String customerEmail;
    }

    public class Response {
        @InvocableVariable(label='Order Found' description='True only when the order number and email match.')
        public Boolean isFound;

        @InvocableVariable(label='Status' description='Processing, Shipped, Delivered or Cancelled.')
        public String status;

        @InvocableVariable(label='Delivered On' description='Delivery date when the status is Delivered.')
        public Date deliveredOn;

        @InvocableVariable(label='Tracking Number' description='Carrier tracking number, when there is one.')
        public String trackingNumber;

        @InvocableVariable(label='Message' description='A plain sentence the agent can repeat to the customer.')
        public String message;
    }

    @InvocableMethod(
        label='Check Order Status'
        description='Returns the status and tracking number of an order. Needs the order number and the email address on the order.'
    )
    public static List<Response> check(List<Request> requests) {
        System.debug(LoggingLevel.INFO, 'OrderStatusAction requests: ' + requests.size());
        Set<String> keys = new Set<String>();
        for (Request req : requests) {
            if (req != null && String.isNotBlank(req.orderNumber)) {
                keys.add(OrderSelector.key(req.orderNumber));
            }
        }
        Map<String, Store_Order__c> orders = OrderSelector.byOrderNumber(keys);

        List<Response> responses = new List<Response>();
        for (Request req : requests) {
            Response res = new Response();
            Store_Order__c ord = req == null ? null : orders.get(OrderSelector.key(req.orderNumber));
            if (!OrderSelector.emailMatches(ord, req == null ? null : req.customerEmail)) {
                res.isFound = false;
                res.message = NO_MATCH;
            } else {
                res.isFound = true;
                res.status = ord.Status__c;
                res.deliveredOn = ord.Delivered_On__c;
                res.trackingNumber = ord.Tracking_Number__c;
                res.message = 'Order ' + ord.Order_Number__c + ' is ' + ord.Status__c.toLowerCase() + '.';
            }
            responses.add(res);
        }
        return responses;
    }
}
```

### Apex: the return action

**`force-app/main/default/classes/ReturnCaseGuard.cls`**

```apex
// Without sharing on purpose, and it returns only Ids. The agent user owns the Cases it creates
// but cannot see Cases that people created, so a user-mode query would miss them and the agent
// would open a second return for the same order. The class exposes no field values.
public without sharing class ReturnCaseGuard {

    public static final String SUBJECT_PREFIX = 'Return request: ';

    public static Set<Id> orderIdsWithOpenReturn(Set<Id> orderIds) {
        Set<Id> result = new Set<Id>();
        if (orderIds.isEmpty()) {
            return result;
        }
        for (Case existing : [
            SELECT Store_Order__c
            FROM Case
            WHERE Store_Order__c IN :orderIds
              AND IsClosed = false
              AND Subject LIKE :(SUBJECT_PREFIX + '%')
            WITH SYSTEM_MODE
        ]) {
            result.add(existing.Store_Order__c);
        }
        return result;
    }
}
```

**`force-app/main/default/classes/StartReturnAction.cls`**

```apex
public with sharing class StartReturnAction {

    @TestVisible private static final String CREATED = 'CREATED';
    @TestVisible private static final String NOT_FOUND = 'NOT_FOUND';
    @TestVisible private static final String NOT_DELIVERED = 'NOT_DELIVERED';
    @TestVisible private static final String OUTSIDE_WINDOW = 'OUTSIDE_WINDOW';
    @TestVisible private static final String ALREADY_OPEN = 'ALREADY_OPEN';
    @TestVisible private static final String SAVE_FAILED = 'SAVE_FAILED';
    private static final Integer DEFAULT_WINDOW_DAYS = 30;

    public class Request {
        @InvocableVariable(required=true label='Order Number' description='The order number the customer wants to return.')
        public String orderNumber;

        @InvocableVariable(required=true label='Customer Email' description='The email address on the order.')
        public String customerEmail;

        @InvocableVariable(label='Return Reason' description='Why the customer is returning the order, in the customer\'s words. Maximum 500 characters.')
        public String reason;
    }

    public class Response {
        @InvocableVariable(label='Outcome' description='CREATED, NOT_FOUND, NOT_DELIVERED, OUTSIDE_WINDOW, ALREADY_OPEN or SAVE_FAILED.')
        public String outcome;

        @InvocableVariable(label='Case Number' description='The return case number when the outcome is CREATED.')
        public String caseNumber;

        @InvocableVariable(label='Message' description='A plain sentence the agent can repeat to the customer.')
        public String message;
    }

    @InvocableMethod(
        label='Start Return'
        description='Creates a return case for a delivered order inside the return window. Call it only after the customer confirmed they want to return the order.'
    )
    public static List<Response> start(List<Request> requests) {
        Integer windowDays = windowDays();
        Set<String> keys = new Set<String>();
        for (Request req : requests) {
            if (req != null && String.isNotBlank(req.orderNumber)) {
                keys.add(OrderSelector.key(req.orderNumber));
            }
        }
        Map<String, Store_Order__c> orders = OrderSelector.byOrderNumber(keys);
        Set<Id> orderIds = new Set<Id>();
        for (Store_Order__c ord : orders.values()) {
            orderIds.add(ord.Id);
        }
        Set<Id> alreadyOpen = ReturnCaseGuard.orderIdsWithOpenReturn(orderIds);

        List<Response> responses = new List<Response>();
        List<Case> newCases = new List<Case>();
        List<Integer> caseResponseIndex = new List<Integer>();
        Set<Id> queued = new Set<Id>();

        for (Integer i = 0; i < requests.size(); i++) {
            Request req = requests[i];
            Response res = new Response();
            responses.add(res);
            Store_Order__c ord = req == null ? null : orders.get(OrderSelector.key(req.orderNumber));
            if (!OrderSelector.emailMatches(ord, req == null ? null : req.customerEmail)) {
                fill(res, NOT_FOUND, 'I could not find an order with that order number and email address.');
            } else if (ord.Status__c != 'Delivered' || ord.Delivered_On__c == null) {
                fill(res, NOT_DELIVERED, 'This order has not been delivered yet, so it cannot be returned.');
            } else if (ord.Delivered_On__c.daysBetween(Date.today()) > windowDays) {
                fill(res, OUTSIDE_WINDOW, 'This order was delivered more than ' + windowDays + ' days ago.');
            } else if (alreadyOpen.contains(ord.Id) || queued.contains(ord.Id)) {
                fill(res, ALREADY_OPEN, 'A return is already open for this order.');
            } else {
                queued.add(ord.Id);
                newCases.add(buildCase(ord, req));
                caseResponseIndex.add(i);
            }
        }
        saveCases(newCases, caseResponseIndex, responses);
        return responses;
    }

    private static Integer windowDays() {
        Return_Policy__mdt policy = Return_Policy__mdt.getInstance('Default');
        if (policy == null || policy.Return_Window_Days__c == null) {
            return DEFAULT_WINDOW_DAYS;
        }
        return policy.Return_Window_Days__c.intValue();
    }

    private static void fill(Response res, String outcome, String message) {
        res.outcome = outcome;
        res.message = message;
    }

    private static Case buildCase(Store_Order__c ord, Request req) {
        String reason = String.isBlank(req.reason) ? 'No reason given' : req.reason.abbreviate(500);
        return new Case(
            Subject = ReturnCaseGuard.SUBJECT_PREFIX + ord.Order_Number__c,
            Description = 'Created by the Harbor Helper agent. Reason: ' + reason,
            Origin = 'Web',
            Priority = 'Medium',
            SuppliedEmail = req.customerEmail.trim(),
            Store_Order__c = ord.Id
        );
    }

    private static void saveCases(List<Case> newCases, List<Integer> index, List<Response> responses) {
        if (newCases.isEmpty()) {
            return;
        }
        // Partial success: one bad record does not block the others. User mode enforces CRUD and FLS.
        List<Database.SaveResult> results = Database.insert(newCases, false, AccessLevel.USER_MODE);
        Set<Id> savedIds = new Set<Id>();
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                savedIds.add(results[i].getId());
            } else {
                fill(responses[index[i]], SAVE_FAILED,
                    'I could not create the return. A support agent will follow up.');
                System.debug(LoggingLevel.ERROR, 'Return case failed: ' + results[i].getErrors()[0].getMessage());
            }
        }
        Map<Id, Case> numbers = new Map<Id, Case>([
            SELECT CaseNumber FROM Case WHERE Id IN :savedIds WITH USER_MODE
        ]);
        for (Integer i = 0; i < results.size(); i++) {
            if (results[i].isSuccess()) {
                Response res = responses[index[i]];
                res.caseNumber = numbers.get(results[i].getId()).CaseNumber;
                fill(res, CREATED, 'Your return request ' + res.caseNumber + ' has been created.');
            }
        }
    }
}
```

The action returns an `outcome` code and a sentence rather than throwing exceptions. An unhandled exception inside an action reaches the customer as a generic failure, and the agent cannot tell "not found" from "broken".

### The agent: instructions and CLI

Create two subagents in the builder. The text below is the content to paste into each. Refer to actions by their exact labels, state the order of steps, and keep absolutes out (the guide warns that words like "always" and "never" are taken very literally).

```text
AGENT
Name: Harbor Helper    API name: Harbor_Helper
Role: Answers order status questions and starts returns for Harbor & Pine Outfitters customers.
Company: Harbor & Pine Outfitters sells outdoor gear online and ships by carrier.
Agent user: the user from setup step 7, selected from the picker.

SUBAGENT: Order status
Classification description: Customer asks where an order is, whether it shipped or when it arrives.
Scope: Looking up the status and tracking number of one order. Not refunds, price changes or edits.
Instructions:
- Ask for the order number and the email address on the order if the customer has not given both.
- Run Check Order Status with exactly what the customer typed.
- If Order Found is false, say you could not find a match and offer to try again once. Do not say
  which of the two values was wrong.
- If found, give the status. If a tracking number exists, include it.
- If the customer asks about anything else, say a team member will help and stop.

SUBAGENT: Returns
Classification description: Customer wants to return an order or asks if an order can be returned.
Scope: Starting a return for one delivered order. Not refunds, exchanges, damage claims or complaints.
Instructions:
- Ask for the order number and the email address on the order.
- Run Check Order Status first. Only continue if the status is Delivered.
- Ask for a short reason and ask the customer to confirm they want to start the return.
- After they confirm, run Start Return. Repeat the Message back and give the Case Number.
- If the Outcome is OUTSIDE_WINDOW, ALREADY_OPEN or SAVE_FAILED, repeat the Message and offer to
  pass the conversation to a person. Do not try Start Return again.
```

The CLI route generates an agent spec, turns it into an authoring bundle (an Agent Script file plus metadata) and publishes it. These flags are from the CLI reference pages and the CLI README:

```bash
# 1. Generate an agent spec (YAML) with AI-suggested subagents (max 2 here)
sf agent generate agent-spec --type customer \
  --role "Answers order status questions and starts returns for customers" \
  --company-name "Harbor & Pine Outfitters" \
  --company-description "Outdoor gear retailer that ships by carrier" \
  --max-topics 2 --agent-user "$AGENT_USER" \
  --output-file specs/harborHelperSpec.yaml --target-org harborpine

# 2. Create a local authoring bundle (an Agent Script file plus metadata) from the spec
sf agent generate authoring-bundle --spec specs/harborHelperSpec.yaml \
  --name "Harbor Helper" --api-name Harbor_Helper --target-org harborpine

# 3. Publish it to the org, then activate it (only one version is active at a time)
sf agent publish authoring-bundle --api-name Harbor_Helper --target-org harborpine
sf agent activate --api-name Harbor_Helper --target-org harborpine

# 4. Talk to the local agent with real org actions and Apex debug logging
sf agent preview --authoring-bundle Harbor_Helper --use-live-actions --apex-debug \
  --output-dir transcripts/harbor --target-org harborpine
```

Set `AGENT_USER` to the username of your agent user. Open the generated Agent Script file in VS Code or in the builder's Script view and connect each action to your Apex class. The developer blog example keeps the file under an `aiAuthoringBundles` folder (`.agent` extension). Agent Script defines an action with a `target` in the form `{TARGET_TYPE}://{DEVELOPER_NAME}` where the type is `apex`, `flow` or `prompt`, plus `description`, `inputs` and `outputs`:

```text
# Shape only. Names follow the Agent Script reference page for actions. Do not paste this
# as a full file: generate the bundle with the CLI and edit what it produces.
actions:
    check_order_status:
        description: "Returns the status and tracking number of an order."
        target: "apex://OrderStatusAction"
        inputs:
            order_number: string
            customer_email: string
        outputs:
            is_found: boolean
```

The reference documents the target format and the property names. I did not verify the exact developer name an `apex` target expects, so confirm it against a bundle generated in your org. Agent Script outputs are remembered for the whole session by default, and `filter_from_agent: True` hides an output from the agent.

### Metadata types you will meet

From the Agentforce metadata types page: `Bot` (the top-level agent record), `BotVersion` (one version, only one active), `GenAiPlannerBundle` (the agent's planner, holding its subagents and actions), `GenAiPlugin` (a subagent that groups actions), `GenAiFunction` (an action) and `AiAuthoringBundle` (the container for an agent's Agent Script file). Treat the builder as the source of truth for their contents, and retrieve them with the CLI rather than hand-writing them.

### Tests and seed data

**`force-app/main/default/classes/OrderActionsTest.cls`**

```apex
@IsTest
private class OrderActionsTest {
    private static final String AGENT_LAST_NAME = 'HarborAgentTest';

    @TestSetup
    static void setup() {
        // Setup objects (User, PermissionSetAssignment) and data objects cannot be mixed
        // in one transaction, so the user is created inside runAs.
        System.runAs(new User(Id = UserInfo.getUserId())) {
            Profile prof = [SELECT Id FROM Profile WHERE Name = 'Standard User' LIMIT 1];
            User agent = new User(
                Alias = 'hpagent', Email = 'agent@harborpine.example', LastName = AGENT_LAST_NAME,
                Username = 'agent.' + UserInfo.getOrganizationId() + '@harborpine.example',
                ProfileId = prof.Id, EmailEncodingKey = 'UTF-8', LanguageLocaleKey = 'en_US',
                LocaleSidKey = 'en_US', TimeZoneSidKey = 'America/New_York'
            );
            insert agent;
            PermissionSet ps = [SELECT Id FROM PermissionSet WHERE Name = 'Harbor_Pine_Agent_Access'];
            insert new PermissionSetAssignment(AssigneeId = agent.Id, PermissionSetId = ps.Id);
        }

        List<Store_Order__c> orders = new List<Store_Order__c>{
            order('HP-1001', 'pat@example.com', 'Shipped', null, 'TRK100'),
            order('HP-1002', 'sam@example.com', 'Delivered', Date.today().addDays(-5), 'TRK200'),
            order('HP-1003', 'lee@example.com', 'Delivered', Date.today().addDays(-45), 'TRK300'),
            order('HP-1004', 'kai@example.com', 'Processing', null, null)
        };
        for (Integer i = 0; i < 200; i++) {
            orders.add(order('BULK-' + i, 'bulk' + i + '@example.com', 'Delivered',
                Date.today().addDays(-3), null));
        }
        insert orders;
    }

    private static Store_Order__c order(String num, String email, String status, Date delivered, String trk) {
        return new Store_Order__c(
            Name = num, Order_Number__c = num, Customer_Email__c = email, Status__c = status,
            Delivered_On__c = delivered, Tracking_Number__c = trk, Placed_On__c = Date.today().addDays(-10)
        );
    }

    private static User agentUser() {
        return [SELECT Id FROM User WHERE LastName = :AGENT_LAST_NAME LIMIT 1];
    }

    private static OrderStatusAction.Request statusReq(String num, String email) {
        OrderStatusAction.Request req = new OrderStatusAction.Request();
        req.orderNumber = num;
        req.customerEmail = email;
        return req;
    }

    private static StartReturnAction.Request returnReq(String num, String email) {
        StartReturnAction.Request req = new StartReturnAction.Request();
        req.orderNumber = num;
        req.customerEmail = email;
        req.reason = 'Wrong size';
        return req;
    }

    @IsTest
    static void statusIsReturnedWhenEmailMatches() {
        List<OrderStatusAction.Response> out;
        System.runAs(agentUser()) {
            out = OrderStatusAction.check(new List<OrderStatusAction.Request>{
                statusReq(' hp-1001 ', 'PAT@example.com')
            });
        }
        Assert.isTrue(out[0].isFound);
        Assert.areEqual('Shipped', out[0].status);
        Assert.areEqual('TRK100', out[0].trackingNumber);
    }

    @IsTest
    static void wrongEmailAndUnknownOrderLookTheSame() {
        List<OrderStatusAction.Response> out;
        System.runAs(agentUser()) {
            out = OrderStatusAction.check(new List<OrderStatusAction.Request>{
                statusReq('HP-1001', 'someone.else@example.com'),
                statusReq('HP-9999', 'pat@example.com'),
                statusReq(null, null)
            });
        }
        for (OrderStatusAction.Response res : out) {
            Assert.isFalse(res.isFound);
            Assert.isNull(res.status);
            Assert.areEqual(OrderStatusAction.NO_MATCH, res.message);
        }
    }

    @IsTest
    static void twoHundredStatusRequestsUseOneQuery() {
        List<OrderStatusAction.Request> reqs = new List<OrderStatusAction.Request>();
        for (Integer i = 0; i < 200; i++) {
            reqs.add(statusReq('BULK-' + i, 'bulk' + i + '@example.com'));
        }
        List<OrderStatusAction.Response> out;
        Integer queries;
        System.runAs(agentUser()) {
            Test.startTest();
            out = OrderStatusAction.check(reqs);
            queries = Limits.getQueries();
            Test.stopTest();
        }
        Assert.areEqual(200, out.size());
        Assert.areEqual(1, queries);
        Assert.isTrue(out[199].isFound);
    }

    @IsTest
    static void deliveredOrderInsideTheWindowCreatesACase() {
        List<StartReturnAction.Response> out;
        System.runAs(agentUser()) {
            out = StartReturnAction.start(new List<StartReturnAction.Request>{
                returnReq('HP-1002', 'sam@example.com')
            });
        }
        Assert.areEqual('CREATED', out[0].outcome);
        Case created = [
            SELECT Subject, Store_Order__r.Order_Number__c, SuppliedEmail
            FROM Case WHERE CaseNumber = :out[0].caseNumber
        ];
        Assert.areEqual('Return request: HP-1002', created.Subject);
        Assert.areEqual('HP-1002', created.Store_Order__r.Order_Number__c);
    }

    @IsTest
    static void returnsAreRefusedForTheWrongReasons() {
        List<StartReturnAction.Response> out;
        System.runAs(agentUser()) {
            out = StartReturnAction.start(new List<StartReturnAction.Request>{
                returnReq('HP-1001', 'pat@example.com'),    // shipped, not delivered
                returnReq('HP-1003', 'lee@example.com'),    // delivered 45 days ago
                returnReq('HP-1002', 'wrong@example.com')   // email does not match
            });
        }
        Assert.areEqual('NOT_DELIVERED', out[0].outcome);
        Assert.areEqual('OUTSIDE_WINDOW', out[1].outcome);
        Assert.areEqual('NOT_FOUND', out[2].outcome);
        Assert.areEqual(0, [SELECT COUNT() FROM Case]);
    }

    @IsTest
    static void aSecondReturnForTheSameOrderIsBlocked() {
        List<StartReturnAction.Response> first;
        List<StartReturnAction.Response> second;
        System.runAs(agentUser()) {
            first = StartReturnAction.start(new List<StartReturnAction.Request>{
                returnReq('HP-1002', 'sam@example.com')
            });
            second = StartReturnAction.start(new List<StartReturnAction.Request>{
                returnReq('HP-1002', 'sam@example.com')
            });
        }
        Assert.areEqual('CREATED', first[0].outcome);
        Assert.areEqual('ALREADY_OPEN', second[0].outcome);
        Assert.areEqual(1, [SELECT COUNT() FROM Case]);
    }

    @IsTest
    static void duplicatesInsideOneBatchCreateOnlyOneCase() {
        List<StartReturnAction.Response> out;
        System.runAs(agentUser()) {
            out = StartReturnAction.start(new List<StartReturnAction.Request>{
                returnReq('HP-1002', 'sam@example.com'),
                returnReq('HP-1002', 'sam@example.com')
            });
        }
        Assert.areEqual('CREATED', out[0].outcome);
        Assert.areEqual('ALREADY_OPEN', out[1].outcome);
    }

    @IsTest
    static void twoHundredReturnsUseOneDmlStatement() {
        List<StartReturnAction.Request> reqs = new List<StartReturnAction.Request>();
        for (Integer i = 0; i < 200; i++) {
            reqs.add(returnReq('BULK-' + i, 'bulk' + i + '@example.com'));
        }
        List<StartReturnAction.Response> out;
        Integer queries;
        Integer dml;
        System.runAs(agentUser()) {
            Test.startTest();
            out = StartReturnAction.start(reqs);
            queries = Limits.getQueries();
            dml = Limits.getDmlStatements();
            Test.stopTest();
        }
        Assert.areEqual(200, [SELECT COUNT() FROM Case WHERE Subject LIKE 'Return request: BULK-%']);
        Assert.areEqual('CREATED', out[199].outcome);
        Assert.areEqual(1, dml);
        Assert.isTrue(queries <= 3, 'Queries used: ' + queries);
    }
}
```

**`scripts/apex/seed-harbor-pine.apex`**

```apex
// Anonymous Apex
// Four demo orders for manual preview. Safe to run twice: it upserts on the order number.
List<Store_Order__c> orders = new List<Store_Order__c>{
    new Store_Order__c(Name = 'HP-1001', Order_Number__c = 'HP-1001',
        Customer_Email__c = 'pat@example.com', Status__c = 'Shipped',
        Tracking_Number__c = 'TRK100', Placed_On__c = Date.today().addDays(-4)),
    new Store_Order__c(Name = 'HP-1002', Order_Number__c = 'HP-1002',
        Customer_Email__c = 'sam@example.com', Status__c = 'Delivered',
        Delivered_On__c = Date.today().addDays(-5), Placed_On__c = Date.today().addDays(-10)),
    new Store_Order__c(Name = 'HP-1003', Order_Number__c = 'HP-1003',
        Customer_Email__c = 'lee@example.com', Status__c = 'Delivered',
        Delivered_On__c = Date.today().addDays(-45), Placed_On__c = Date.today().addDays(-50)),
    new Store_Order__c(Name = 'HP-1004', Order_Number__c = 'HP-1004',
        Customer_Email__c = 'kai@example.com', Status__c = 'Processing',
        Placed_On__c = Date.today().addDays(-1))
};
Database.upsert(orders, Store_Order__c.Order_Number__c, true);
System.debug('Orders in org: ' + [SELECT COUNT() FROM Store_Order__c]);
```

### Deploy and test the code

```bash
sf project deploy start --source-dir force-app --target-org harborpine
sf org assign permset --name Harbor_Pine_Agent_Access --on-behalf-of "$AGENT_USER" --target-org harborpine
sf apex run --file scripts/apex/seed-harbor-pine.apex --target-org harborpine
sf apex run test --class-names OrderActionsTest --code-coverage --result-format human \
  --wait 10 --target-org harborpine
```

Every class needs a `-meta.xml` file with an API version. `sf apex generate class` creates it with your project's current API version, so use your org's current API version instead of copying a number from an article. The `--on-behalf-of` flag of `sf org assign permset` is not something I checked in the CLI reference. If your CLI version rejects it, assign the permission set in Setup, Users, the agent user, Permission Set Assignments.

### Testing the agent itself

Apex tests prove the actions. To test the conversation, the CLI has `sf agent generate test-spec` (writes a YAML spec of test cases) and `sf agent test create --spec <file> --api-name <name>` (deploys it as test metadata). Per the CLI reference, `sf agent test create` creates an `AiEvaluationDefinition` by default, or an `AiTestingDefinition` with `--test-runner agentforce-studio`. I could not verify the YAML schema, so generate it with the CLI and edit it, and check `sf agent test run --help` for the run flags. Start with these cases:

| Utterance | Expected subagent | Expected action | Expected result |
|---|---|---|---|
| "Where is HP-1001? pat@example.com" | Order status | Check Order Status | Shipped, TRK100 |
| "Where is HP-1001?" (no email) | Order status | none | Asks for the email |
| "I want to return HP-1002, sam@example.com" | Returns | Check Order Status, then Start Return after confirming | A case number |
| "Return HP-1003, lee@example.com" | Returns | Start Return | Outside the 30 day window, offers a person |
| "Can I get a refund for my ruined tent?" | none of these | none | Out of scope, hands off |

## What happens behind the scenes

Take the conversation "Return HP-1002, sam@example.com".

1. **Routing.** The Agent Router classifies the message using only the subagent names and classification descriptions. `Returns` wins. Its scope, instructions and actions are added to the prompt along with the history.
2. **Planning.** The LLM sees two actions with their labels and descriptions, which came from your Apex annotations. It slot-fills the two required inputs from the text. If a required input is missing, the agent asks the customer, which is why `required=true` matters.
3. **Action 1.** `Check Order Status` runs as the agent user in its own Apex transaction. The platform builds the `List<Request>`, calls `check`, and serializes the `List<Response>` back. The SOQL runs in user mode, so it uses the agent user's object and field permissions (Case sharing does not matter here).
4. **Back to the LLM.** The outputs return to the model. Outputs marked "Show in conversation" can be displayed; the model decides what to say. The instructions say to confirm, so it asks.
5. **Action 2.** After the customer confirms, `Start Return` runs in another transaction. It makes three queries (orders, open-return guard, case numbers) and one DML statement. Apex governor limits apply to each invocation separately: for example 100 SOQL queries and 150 DML statements in a synchronous transaction. The guide for Apex actions notes that actions do not bulkify by default and each runs in its own transaction, so a list-based signature protects you when the platform or a flow sends several at once.
6. **Reply.** The LLM drafts a reply, the grounding check verifies it against the action output and the instructions, and the customer sees the case number.

In the builder's Preview, open the reasoning summary or conversation steps to see which subagent and action ran with which inputs. The new builder shows per-message reasoning summaries and session traces. With `sf agent preview --apex-debug`, Apex debug logs are enabled and you can read lines like these:

```text
USER_DEBUG|[8]|INFO|OrderStatusAction requests: 1
SOQL_EXECUTE_BEGIN|[18]|Aggregations:0|SELECT Id, Order_Number__c ... FROM Store_Order__c WHERE ...
SOQL_EXECUTE_END|[18]|Rows:1
```

## Test it and verify

1. Deploy, assign the permission set to the agent user and run the seed script (commands above). Verify: `Store_Order__c` has 4 rows.
2. Run `OrderActionsTest`. Expect 8 passing tests. A failure on `Harbor_Pine_Agent_Access` not found means the permission set did not deploy.
3. In the builder, open Preview with live actions and send, in this order:
   - "Where is order HP-1001?" The agent should ask for the email, then answer "shipped" with `TRK100` after you give `pat@example.com`.
   - "Where is order HP-1001?" with `wrong@example.com`. The reply must not say whether the order exists.
   - "Return HP-1002" with `sam@example.com`, then confirm. A case number appears.
4. Open the Case list. You should see `Return request: HP-1002` with the Store Order lookup filled.
5. Ask for the same return again. The agent should say a return is already open and offer a person.
6. Ask for `HP-1003`. The agent should say the order is outside the window.
7. Ask "Can I get a refund for my ruined tent?" It should hand off rather than invent a policy.

## Common mistakes and fixes

- **Symptom: the agent never picks your action.** Cause: vague or missing `label` and `description` on the method or variables, or the action is not attached to the active subagent. Fix: write descriptions that say what the action does, when to use it and what each input means. The agent chooses by names, descriptions, inputs, instructions and context.
- **Symptom: the action runs but returns nothing, or a field-level security error appears.** Cause: the agent user lacks the permission set, class access or field access, and the Apex runs in user mode. Fix: check Permission Set Assignments on the agent user and the permission set's class and field access.
- **Symptom: the agent skips the email check or reveals which orders exist.** Cause: security written only in instructions, or different messages for "no order" and "wrong email". Fix: keep the check in Apex and return one message for both cases, as `OrderSelector.emailMatches` and `NO_MATCH` do.
- **Symptom: a duplicate return case is created.** Cause: the guard query ran in user mode, and the agent user cannot see Cases created by people. Fix: use a narrow `without sharing` helper that returns only Ids, as `ReturnCaseGuard` does, and explain why in a comment.
- **Symptom: the agent gives a refund promise that is not in policy.** Cause: policy text in instructions that the LLM paraphrases. Fix: put the rule in code or custom metadata, return the sentence from the action, and keep refunds out of scope.
- **Symptom: instructions that worked in testing break after an edit.** Cause: instructions are interpreted by an LLM and change behavior when reworded; absolutes such as "never" are taken very literally. Fix: keep a written test set (the table above) and re-run it after every change.
- **Symptom: you cannot find Setup, Agentforce Agents, New Agent.** Cause: since the week of July 13, 2026 new agents are created only in the new builder, in Agentforce Studio. Fix: App Launcher, Agentforce Studio, Agents.
- **Symptom: an Apex test fails with a mixed DML error.** Cause: creating a user and data records in one transaction. Fix: wrap the user and permission set assignment in `System.runAs`, as `@TestSetup` does above.

## Key takeaways

- An agent is subagents, instructions and actions on top of a reasoning engine. Instructions guide, filters and code decide.
- A service agent runs as its agent user. Give that user a narrow permission set and design every action as if the caller were anonymous.
- Put business rules (identity, return window, duplicates) in Apex or custom metadata, and return clear outcome codes.
- Write `label` and `description` on every invocable method and variable. They are the agent's only view of your code.
- Test twice: Apex tests for the actions, and a written conversation test set for the agent.
- Say "subagent" and "Agent Router". Older material says "topic" and "Topic Selector".

## Where to go next

- [Agentforce agent actions basics](/articles/agentforce-agent-actions-basics/)
- [Writing agent instructions](/articles/writing-agent-instructions/)
- [Agentforce guardrails and testing](/articles/agentforce-guardrails-and-testing/)
- [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/)
- [Agentforce channels overview](/articles/agentforce-channels-overview/)
- [Agent Script complete guide](/articles/agent-script-complete-guide/)
- [Apex security and user mode](/articles/apex-security-and-user-mode/)
