---
title: "Agentforce in Slack: Build Custom Slack Actions with Apex (Tutorial)"
description: "Connect Slack to Salesforce with an auth provider and Named Credential, build tested Apex actions for channels and messages, and deploy the agent to Slack."
category: agentforce
tags: [Agentforce, Slack, Apex, Named Credentials, Advanced]
publishedAt: 2026-11-11
updatedAt: 2026-11-15
cover: /images/covers/agentforce-slack-custom-actions.jpg
sources:
  - title: "Customizing Agentforce agents with custom Slack actions (Slack developer docs)"
    url: "https://docs.slack.dev/ai/customizing-agentforce-agents-with-custom-slack-actions"
  - title: "Set up and manage Agentforce in Slack (Slack Help)"
    url: "https://slack.com/help/articles/36218109305875-Set-up-and-manage-Agentforce-in-Slack"
---

This article follows the official Slack developer tutorial and adds explanations, working Apex with tests, and hardening advice. Names and screens change, so treat the source as the authority for every click.

## The business scenario

Redstone Software (a fictional company) has an Agentforce agent in Slack that answers support questions. The support lead wants the agent to **post a summary to a team channel** when a customer issue is escalated, by channel *name* ("post this in #support-escalations"), not by cryptic channel id. The agent must find the channel first, then post, and must not post to channels it should not touch.

## Before you start: setup

### In Salesforce

1. Use a sandbox or Developer Edition org with Agentforce and a connected Slack workspace. Per the tutorial you need a connected Salesforce org and Slack org, and an agent you can modify. The agent must be **Active** before you connect it to Slack.
2. Install the Salesforce CLI and VS Code with the Salesforce extensions. If Apex cannot find Java, the tutorial says to install OpenJDK 21.
3. Turn on **Einstein Bots** and install the **Slack Platform Connector** package, as required by the tutorial.
4. Create an **Auth Provider**, an **External Credential** and a **Named Credential** `Slack_API`, as described in the next section. These are where the Slack token is stored, so Apex never sees it.
5. Plan permissions: the tutorial grants principal access to the "Einstein Agent User" and "System Administrator" profiles, and later gives the "Einstein Agent User" profile Apex class access to the action classes.

### In the external system (Slack)

1. Create a Slack app called "Agentforce Custom Actions" from a manifest in your Slack workspace, install it to the organisation, and copy the Client ID and Client Secret.
2. The bot scopes in the tutorial's manifest are `chat:write`, `chat:write.public`, `mpim:read`, `reactions:write`, `channels:history`, `canvases:write`, `channels:join`, `channels:read` and `team:read`. For this article you need only `chat:write`, `channels:read`, `channels:join` and `team:read`; granting fewer scopes is safer.
3. Add the Auth Provider's Callback URL to the Slack app's Redirect URLs once you have created the provider.

## How it works

Custom actions let an agent use the Slack Web API, for example to post a message to a channel. The chain is: Slack app, Salesforce Auth Provider, External Credential, Named Credential, Apex actions, agent actions, deployment to Slack.

The steps, from the tutorial:

1. **Slack app:** create it from a manifest, install it, copy the Client ID and Secret.
2. **Auth Provider:** create an OpenID Connect provider called "Slack" with Slack's authorize and token endpoints. Add the provider's Callback URL to the Slack app's Redirect URLs.
3. **External Credential** "Slack": OAuth 2.0 with Browser Flow, a Named Principal with the scopes, authenticate, and grant principal access to the "Einstein Agent User" and "System Administrator" profiles.
4. **Named Credential** `Slack_API` with base URL `https://slack.com/api`, linked to the external credential.
5. **Project:** create an SFDX project and authorise your org.
6. **Apex actions:** deploy `GetSlackChannelAction` and `SendSlackMessageAction` and test with Anonymous Apex.
7. **Agent Builder:** give the "Einstein Agent User" profile Apex class access, create agent actions from the classes (Agentforce Assets), add them to a subagent, activate and test.
8. **Deploy to Slack:** add an API connection using the Slack connected app, install the agent under Salesforce > Agentforce in Slack, choose workspaces and set access, then test in the Agentforce tab.

## Basic example

The callout pattern, straight from the tutorial:

```apex
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:Slack_API/chat.postMessage');
req.setMethod('POST');
req.setHeader('Content-Type', 'application/json');
req.setBody(JSON.serialize(new Map<String, Object>{
    'channel' => channelId,
    'team_id' => workspaceId,
    'text'    => messageText
}));
HttpResponse res = new Http().send(req);
```

`callout:Slack_API` makes Salesforce add the OAuth token for you. Slack returns HTTP 200 even for failures and puts `"ok": false` and an `error` string in the body, so a real action must read the body, not only the status code.

## Advanced end-to-end example

In the tutorial, `GetSlackChannelAction` calls `auth.teams.list` and `conversations.list` (with pagination) to turn a channel name into an id, with inputs `channel_name` and `workspace_name` and outputs `channel_id`, `channel_name`, `num_members`, `topic` and `error_message`. `SendSlackMessageAction` calls `chat.postMessage` with inputs `channel_id`, `workspace_id` and `text` and outputs `is_success`, `message_ts` and `error_message`. The classes below follow those names and add an allow-list and tests.

**force-app/main/default/classes/SlackApi.cls** holds the callout logic once.

```apex
public with sharing class SlackApi {

    public class SlackException extends Exception {}

    public static Map<String, Object> get(String method, Map<String, String> params) {
        List<String> parts = new List<String>();
        for (String key : params.keySet()) {
            parts.add(EncodingUtil.urlEncode(key, 'UTF-8') + '=' + EncodingUtil.urlEncode(params.get(key), 'UTF-8'));
        }
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Slack_API/' + method + (parts.isEmpty() ? '' : '?' + String.join(parts, '&')));
        req.setMethod('GET');
        req.setTimeout(10000);
        return parse(new Http().send(req));
    }

    public static Map<String, Object> post(String method, Map<String, Object> body) {
        HttpRequest req = new HttpRequest();
        req.setEndpoint('callout:Slack_API/' + method);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json');
        req.setTimeout(10000);
        req.setBody(JSON.serialize(body));
        return parse(new Http().send(req));
    }

    private static Map<String, Object> parse(HttpResponse res) {
        if (res.getStatusCode() != 200) {
            throw new SlackException('Slack returned HTTP ' + res.getStatusCode());
        }
        Map<String, Object> body = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
        if (body.get('ok') != true) {
            throw new SlackException('Slack error: ' + body.get('error'));
        }
        return body;
    }
}
```

**force-app/main/default/classes/GetSlackChannelAction.cls**

```apex
public with sharing class GetSlackChannelAction {

    public class Request {
        @InvocableVariable(label='Channel Name' description='Channel name without the leading #, for example support-escalations' required=true)
        public String channel_name;
        @InvocableVariable(label='Workspace Name' description='Slack workspace name')
        public String workspace_name;
    }

    public class Response {
        @InvocableVariable(label='Channel Id' description='Slack channel id to use when posting')
        public String channel_id;
        @InvocableVariable(label='Channel Name') public String channel_name;
        @InvocableVariable(label='Members') public Integer num_members;
        @InvocableVariable(label='Topic') public String topic;
        @InvocableVariable(label='Workspace Id' description='Slack workspace (team) id for the post action')
        public String workspace_id;
        @InvocableVariable(label='Error' description='Set when the channel could not be found') public String error_message;
    }

    @InvocableMethod(label='Get Slack Channel' description='Finds a Slack channel by name and returns its id')
    public static List<Response> run(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            out.add(find(r));
        }
        return out;
    }

    @TestVisible
    private static Response find(Request r) {
        Response res = new Response();
        String wanted = r.channel_name == null ? '' : r.channel_name.removeStart('#').trim().toLowerCase();
        try {
            Map<String, Object> teams = SlackApi.get('auth.teams.list', new Map<String, String>());
            for (Object t : (List<Object>) teams.get('teams')) {
                Map<String, Object> team = (Map<String, Object>) t;
                if (r.workspace_name == null || ((String) team.get('name')).equalsIgnoreCase(r.workspace_name)) {
                    res.workspace_id = (String) team.get('id');
                    break;
                }
            }

            String cursor = '';
            Integer pages = 0;
            do {
                Map<String, String> params = new Map<String, String>{ 'limit' => '200', 'exclude_archived' => 'true' };
                if (!String.isBlank(cursor)) {
                    params.put('cursor', cursor);
                }
                Map<String, Object> page = SlackApi.get('conversations.list', params);
                for (Object c : (List<Object>) page.get('channels')) {
                    Map<String, Object> channel = (Map<String, Object>) c;
                    if (((String) channel.get('name')).equalsIgnoreCase(wanted)) {
                        res.channel_id = (String) channel.get('id');
                        res.channel_name = (String) channel.get('name');
                        res.num_members = (Integer) channel.get('num_members');
                        Map<String, Object> topic = (Map<String, Object>) channel.get('topic');
                        res.topic = topic == null ? null : (String) topic.get('value');
                        return res;
                    }
                }
                Map<String, Object> meta = (Map<String, Object>) page.get('response_metadata');
                cursor = meta == null ? '' : (String) meta.get('next_cursor');
                pages++;
            } while (!String.isBlank(cursor) && pages < 5);
            res.error_message = 'No channel named ' + wanted + ' was found.';
        } catch (Exception e) {
            res.error_message = e.getMessage();
        }
        return res;
    }
}
```

**force-app/main/default/classes/SendSlackMessageAction.cls** (with an allow-list in custom metadata)

```apex
public with sharing class SendSlackMessageAction {

    public class Request {
        @InvocableVariable(label='Channel Id' description='Slack channel id from the Get Slack Channel action' required=true)
        public String channel_id;
        @InvocableVariable(label='Workspace Id' description='Slack workspace id')
        public String workspace_id;
        @InvocableVariable(label='Text' description='Message text, at most 2000 characters' required=true)
        public String text;
    }

    public class Response {
        @InvocableVariable(label='Success') public Boolean is_success;
        @InvocableVariable(label='Message Timestamp') public String message_ts;
        @InvocableVariable(label='Error') public String error_message;
    }

    // Channels the agent may post to. Empty set means "no restriction", which you should avoid in production.
    @TestVisible
    private static Set<String> allowedChannels = loadAllowed();

    private static Set<String> loadAllowed() {
        Set<String> ids = new Set<String>();
        for (Slack_Allowed_Channel__mdt row : [SELECT Channel_Id__c FROM Slack_Allowed_Channel__mdt]) {
            ids.add(row.Channel_Id__c);
        }
        return ids;
    }

    @InvocableMethod(label='Send Slack Message' description='Posts a message to an allowed Slack channel')
    public static List<Response> run(List<Request> requests) {
        List<Response> out = new List<Response>();
        for (Request r : requests) {
            Response res = new Response();
            res.is_success = false;
            if (String.isBlank(r.text) || r.text.length() > 2000) {
                res.error_message = 'Message must be 1 to 2000 characters.';
            } else if (!allowedChannels.isEmpty() && !allowedChannels.contains(r.channel_id)) {
                res.error_message = 'The agent is not allowed to post to that channel.';
            } else {
                try {
                    Map<String, Object> body = new Map<String, Object>{ 'channel' => r.channel_id, 'text' => r.text };
                    if (!String.isBlank(r.workspace_id)) {
                        body.put('team_id', r.workspace_id);
                    }
                    Map<String, Object> reply = SlackApi.post('chat.postMessage', body);
                    res.is_success = true;
                    res.message_ts = (String) reply.get('ts');
                } catch (Exception e) {
                    res.error_message = e.getMessage();
                }
            }
            out.add(res);
        }
        return out;
    }
}
```

**force-app/main/default/classes/SlackActionsTest.cls**

```apex
@IsTest
private class SlackActionsTest {

    private class SlackMock implements HttpCalloutMock {
        public List<String> urls = new List<String>();
        public HttpResponse respond(HttpRequest req) {
            urls.add(req.getEndpoint());
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            String ep = req.getEndpoint();
            if (ep.contains('auth.teams.list')) {
                res.setBody('{"ok":true,"teams":[{"id":"T1","name":"Redstone"}]}');
            } else if (ep.contains('conversations.list') && !ep.contains('cursor=')) {
                res.setBody('{"ok":true,"channels":[{"id":"C0","name":"general","num_members":50}],'
                    + '"response_metadata":{"next_cursor":"abc"}}');
            } else if (ep.contains('conversations.list')) {
                res.setBody('{"ok":true,"channels":[{"id":"C9","name":"support-escalations","num_members":7,"topic":{"value":"Escalations"}}],'
                    + '"response_metadata":{"next_cursor":""}}');
            } else if (ep.contains('chat.postMessage')) {
                res.setBody('{"ok":true,"ts":"1731660000.0001"}');
            } else {
                res.setBody('{"ok":false,"error":"unknown_method"}');
            }
            return res;
        }
    }

    private class ErrorMock implements HttpCalloutMock {
        public HttpResponse respond(HttpRequest req) {
            HttpResponse res = new HttpResponse();
            res.setStatusCode(200);
            res.setBody('{"ok":false,"error":"channel_not_found"}');
            return res;
        }
    }

    @IsTest
    static void findsChannelOnSecondPage() {
        Test.setMock(HttpCalloutMock.class, new SlackMock());
        GetSlackChannelAction.Request r = new GetSlackChannelAction.Request();
        r.channel_name = '#Support-Escalations';
        r.workspace_name = 'Redstone';
        GetSlackChannelAction.Response res = GetSlackChannelAction.run(new List<GetSlackChannelAction.Request>{ r })[0];
        System.assertEquals('C9', res.channel_id);
        System.assertEquals('T1', res.workspace_id);
        System.assertEquals(7, res.num_members);
        System.assertEquals(null, res.error_message);
    }

    @IsTest
    static void reportsAMissingChannel() {
        Test.setMock(HttpCalloutMock.class, new SlackMock());
        GetSlackChannelAction.Request r = new GetSlackChannelAction.Request();
        r.channel_name = 'does-not-exist';
        GetSlackChannelAction.Response res = GetSlackChannelAction.run(new List<GetSlackChannelAction.Request>{ r })[0];
        System.assertEquals(null, res.channel_id);
        System.assert(res.error_message.contains('No channel named'));
    }

    @IsTest
    static void postsToAnAllowedChannel() {
        Test.setMock(HttpCalloutMock.class, new SlackMock());
        SendSlackMessageAction.allowedChannels = new Set<String>{ 'C9' };
        SendSlackMessageAction.Request r = new SendSlackMessageAction.Request();
        r.channel_id = 'C9';
        r.text = 'Escalation summary';
        SendSlackMessageAction.Response res = SendSlackMessageAction.run(new List<SendSlackMessageAction.Request>{ r })[0];
        System.assertEquals(true, res.is_success);
        System.assertEquals('1731660000.0001', res.message_ts);
    }

    @IsTest
    static void refusesAChannelOutsideTheAllowList() {
        Test.setMock(HttpCalloutMock.class, new SlackMock());
        SendSlackMessageAction.allowedChannels = new Set<String>{ 'C9' };
        SendSlackMessageAction.Request r = new SendSlackMessageAction.Request();
        r.channel_id = 'C0';
        r.text = 'Hello everyone';
        SendSlackMessageAction.Response res = SendSlackMessageAction.run(new List<SendSlackMessageAction.Request>{ r })[0];
        System.assertEquals(false, res.is_success);
        System.assert(res.error_message.contains('not allowed'));
    }

    @IsTest
    static void slackErrorsInsideA200AreSurfaced() {
        Test.setMock(HttpCalloutMock.class, new ErrorMock());
        SendSlackMessageAction.allowedChannels = new Set<String>();
        SendSlackMessageAction.Request r = new SendSlackMessageAction.Request();
        r.channel_id = 'CX';
        r.text = 'Hi';
        SendSlackMessageAction.Response res = SendSlackMessageAction.run(new List<SendSlackMessageAction.Request>{ r })[0];
        System.assertEquals(false, res.is_success);
        System.assert(res.error_message.contains('channel_not_found'));
    }
}
```

The agent's subagent instructions then tell it how to chain the actions. The tutorial's guidance is to look up the channel first whenever a user supplies a name, and to remove a leading `#`:

```text
When the user asks you to post in a Slack channel by name:
1. Remove a leading "#" from the name.
2. Call Get Slack Channel with the name. If it returns an error, tell the user the channel was not found.
3. Show the user the message and the channel, and ask them to confirm.
4. After confirmation, call Send Slack Message with the channel id, workspace id and text.
5. Say whether it was posted. Never post without confirmation.
Do not post to direct messages or to channels you did not look up.
```

## What happens behind the scenes

When Apex calls `callout:Slack_API/...`, Salesforce looks up the Named Credential, finds its External Credential, and attaches the OAuth token obtained through the Auth Provider and Slack app, so your code never touches the secret. A Named Principal means one shared identity for everyone; a User Principal would keep credentials per user. With a Named Principal, the agent posts as the app, so the allow-list and confirmation step matter more.

Slack answers almost every API call with HTTP 200 and signals failure in the JSON (`"ok": false` with an `error` code). That is why `SlackApi.parse` checks the body. The channel list is paged by a cursor; the code follows `next_cursor` but stops after five pages to stay inside limits. The Apex actions return error text in a field instead of throwing, so the agent can explain the problem to the user.

When a person talks to the agent in Slack, the platform connector passes the message to the agent, which chooses the subagent, follows the instructions, runs the actions as the agent user, and replies in the thread.

## Test it and verify

1. Deploy the classes and the custom metadata type `Slack_Allowed_Channel__mdt` (field `Channel_Id__c`), then run `SlackActionsTest`. All five tests should pass.
2. Test with Anonymous Apex in the sandbox, for example `System.debug(GetSlackChannelAction.run(new List<GetSlackChannelAction.Request>{ r }));` with a real channel name. The tutorial's sample test scripts use camelCase names such as `channelName` that do not match the declared snake_case fields such as `channel_name`, so fix them before running.
3. Add one allow-list record with your test channel's id.
4. In Agent Builder, create agent actions from both classes, add them to a subagent with the instructions above, activate the agent and test in the builder.
5. Deploy to Slack as in step 8 and ask the agent to post in your test channel. Confirm it asks for confirmation first.
6. Ask it to post to a channel that is not on the allow-list and confirm it refuses.

## Common mistakes and fixes

- **Treating HTTP 200 as success.** Slack reports errors in the body. Check `ok`.
- **Connecting the agent before it is Active.** The agent must be Active before connecting to Slack.
- **Browser sessions in several orgs.** Login problems can occur if your browser is signed in to other Salesforce or Slack orgs; use a private window.
- **Test scripts with the wrong field names.** Match the declared snake_case names.
- **Too many scopes.** Grant only what the actions need.
- **Posting anywhere.** Use an allow-list and a confirmation step.
- **Only two methods.** The tutorial covers only two Slack methods; others need more Apex actions.

## Key takeaways

- Custom Slack actions are Apex invocable methods that call the Slack Web API through a Named Credential.
- Slack returns errors inside HTTP 200 bodies, so always read `ok` and `error`.
- A Named Principal shares one identity, so limit scopes, restrict channels and confirm before posting.
- Look up the channel id first, then post, and return errors as fields for the agent to explain.
- Treat the official tutorial as the authority for screens and settings.

## Where to go next

- Read [Agentforce channels overview](/articles/agentforce-channels-overview/) to compare Slack with the other channels.
- Read [REST callouts with Named Credentials](/articles/rest-callouts-named-credentials/) for the credentials model in depth.
- Read [Agentforce actions with Apex and Flow](/articles/agentforce-actions-apex-flow/) for general action design.
