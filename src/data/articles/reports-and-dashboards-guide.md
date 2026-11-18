---
title: "Salesforce Reports and Dashboards: Report Types, Filters, Joined Reports and the Reports API"
description: "Build reports and dashboards that answer real questions: report types, groupings, filters, formulas, dashboard components and the Reports API in Apex."
category: salesforce-administration
tags: [Reports, Dashboards, Analytics, Beginner]
publishedAt: 2026-11-16
updatedAt: 2026-11-16
sources:
  - title: "Salesforce Help: Reports and Dashboards"
    url: "https://help.salesforce.com/s/articleView?id=sf.analytics_overview.htm"
  - title: "Analytics REST API and Apex Reports API"
    url: "https://developer.salesforce.com/docs/atlas.en-us.api_analytics.meta/api_analytics/"
---

Reports turn records into answers, and dashboards put those answers on one screen. Most reporting problems are not about clicking the right button; they come from choosing the wrong report type, filtering in the wrong place or building a dashboard nobody uses. This article teaches the model, then builds a pipeline report and dashboard as metadata and reads the report from Apex.

> Report and dashboard metadata is easiest to create in the report builder and retrieve with the CLI. The XML below shows the structure so you can review and version it; confirm element names against what a retrieve returns in your org.

## The business scenario

Juniper Consulting's sales director asks: "What is our open pipeline this quarter, by stage and by owner, and which deals are slipping?" The VP wants a dashboard that updates daily, and a finance analyst wants the same numbers inside an Apex-driven email each Monday so that figures never disagree. You will build one report, one dashboard and one service that reads the report through the Reports API.

## Before you start: setup

### In Salesforce

1. Use a Developer Edition org or sandbox, with some Opportunities across stages and owners (a few dozen is enough). Use the data script from the SOQL article if you want ready-made rows.
2. **Check access.** Users need the **Run Reports** permission to run, **Create and Customize Reports** to build, and **Create and Customize Dashboards** for dashboards. Report visibility also depends on **folder** sharing.
3. **Create folders.** In Reports and Dashboards, create a folder "Sales Pipeline" and share it with the roles that need it (Viewer or Editor). Everything below lives in it.
4. **Choose or create a report type.** The standard "Opportunities" type is enough here. A custom report type is needed when you must report across a custom relationship (for example Projects with Tasks).
5. **Dashboard running user.** A dashboard shows data as a **running user** (a fixed person, or the viewer through "Let dashboard viewers choose whom they view the dashboard as" where enabled). Create a dedicated, correctly scoped user for scheduled dashboards.
6. For the Apex part, create a DX project and set `"sourceApiVersion": "67.0"`.

### In the external system

If numbers are also shown in an external BI tool, do not rebuild the logic there. Call the **Analytics REST API** (or the Reports API) with an integration user so that the same report definition is the source. If the external tool must read raw data, agree on a scheduled export and a single owner for the definitions.

## How it works

A **report type** decides which objects and relationships a report can see. Pick it first, because it cannot be changed freely afterwards.

**Report formats:**

| Format | Use it for |
|---|---|
| **Tabular** | A simple list of records; no groupings or charts on a dashboard |
| **Summary** | Group rows (by stage, owner) and show subtotals; the workhorse |
| **Matrix** | Group by rows **and** columns (stage by quarter) |
| **Joined** | Combine up to five blocks from different report types |

**Filters** narrow the rows. Standard filters (date range, "My opportunities") sit alongside field filters. Use **filter logic** (`1 AND (2 OR 3)`) for complex rules. A **cross filter** (with or without a related object) keeps parents that do or do not have matching children, like the semi-join in SOQL.

**Summary fields** (SUM, AVERAGE, MIN, MAX) and **custom summary formulas** calculate across groups. **Bucket fields** group values without creating a field on the object.

**Dashboards** are made of components (chart, gauge, metric, table) built from **source reports**. The dashboard cannot change the report logic; it only displays what the report returns, and **grouped** reports are required for most charts.

**Limits to remember:** a report displays up to 2,000 detail rows in the UI (export for more), a joined report has at most five blocks, and a dashboard can have up to 20 components.

## Basic example

The same question as a report and as SOQL. Reports are a view over the same data, so SOQL is a good way to check a report.

```apex
// "Open pipeline this fiscal quarter by stage"
for (AggregateResult row : [
    SELECT StageName stage, COUNT(Id) deals, SUM(Amount) amount
    FROM Opportunity
    WHERE IsClosed = false AND CloseDate = THIS_FISCAL_QUARTER
    GROUP BY StageName
    ORDER BY SUM(Amount) DESC
]) {
    System.debug(row.get('stage') + ': ' + row.get('deals') + ' deals, ' + row.get('amount'));
}
```

## Advanced end-to-end example

**force-app/main/default/reports/Sales_Pipeline/Open_Pipeline_By_Stage.report-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Report xmlns="http://soap.sforce.com/2006/04/metadata">
    <columns>
        <field>OPPORTUNITY_NAME</field>
    </columns>
    <columns>
        <field>ACCOUNT_NAME</field>
    </columns>
    <columns>
        <field>OWNER_FULL_NAME</field>
    </columns>
    <columns>
        <field>CLOSE_DATE</field>
    </columns>
    <columns>
        <field>AMOUNT</field>
    </columns>
    <description>Open opportunities closing this fiscal quarter, grouped by stage.</description>
    <filter>
        <criteriaItems>
            <column>CLOSED</column>
            <columnToColumn>false</columnToColumn>
            <isUnlocked>true</isUnlocked>
            <operator>equals</operator>
            <value>0</value>
        </criteriaItems>
    </filter>
    <format>Summary</format>
    <groupingsDown>
        <dateGranularity>Day</dateGranularity>
        <field>STAGE_NAME</field>
        <sortOrder>Asc</sortOrder>
    </groupingsDown>
    <name>Open Pipeline By Stage</name>
    <params>
        <name>open</name>
        <value>all</value>
    </params>
    <params>
        <name>probability</name>
        <value>&gt;0</value>
    </params>
    <reportType>Opportunity</reportType>
    <scope>organization</scope>
    <showDetails>true</showDetails>
    <showGrandTotal>true</showGrandTotal>
    <showSubTotals>true</showSubTotals>
    <timeFrameFilter>
        <dateColumn>CLOSE_DATE</dateColumn>
        <interval>INTERVAL_CURRENTQ</interval>
    </timeFrameFilter>
</Report>
```

**force-app/main/default/dashboards/Sales_Pipeline/Pipeline_Overview.dashboard-meta.xml**

```xml
<?xml version="1.0" encoding="UTF-8"?>
<Dashboard xmlns="http://soap.sforce.com/2006/04/metadata">
    <backgroundEndColor>#FFFFFF</backgroundEndColor>
    <backgroundFadeDirection>Diagonal</backgroundFadeDirection>
    <backgroundStartColor>#FFFFFF</backgroundStartColor>
    <dashboardType>SpecifiedUser</dashboardType>
    <description>Daily view of the open pipeline.</description>
    <isGridLayout>true</isGridLayout>
    <runningUser>pipeline.reports@example.com</runningUser>
    <textColor>#000000</textColor>
    <title>Pipeline Overview</title>
    <titleColor>#000000</titleColor>
    <titleSize>12</titleSize>
    <leftSection>
        <columnSize>Medium</columnSize>
        <components>
            <chartAxisRange>Auto</chartAxisRange>
            <componentType>Column</componentType>
            <dashboardFilterColumns>
                <column>OWNER_FULL_NAME</column>
            </dashboardFilterColumns>
            <displayUnits>Auto</displayUnits>
            <drillEnabled>false</drillEnabled>
            <groupingColumn>STAGE_NAME</groupingColumn>
            <header>Open pipeline by stage</header>
            <legendPosition>Bottom</legendPosition>
            <report>Sales_Pipeline/Open_Pipeline_By_Stage</report>
            <showPercentage>false</showPercentage>
            <showValues>true</showValues>
            <sortBy>RowLabelAscending</sortBy>
        </components>
    </leftSection>
    <rightSection>
        <columnSize>Medium</columnSize>
        <components>
            <componentType>Metric</componentType>
            <displayUnits>Auto</displayUnits>
            <drillEnabled>false</drillEnabled>
            <header>Total open pipeline</header>
            <metricLabel>Total</metricLabel>
            <report>Sales_Pipeline/Open_Pipeline_By_Stage</report>
            <showPercentage>false</showPercentage>
            <showValues>true</showValues>
        </components>
    </rightSection>
</Dashboard>
```

**force-app/main/default/classes/PipelineMetrics.cls** computes the same figures directly, so a Monday email and the dashboard can be reconciled.

```apex
public with sharing class PipelineMetrics {

    public class StageTotal {
        @AuraEnabled public String stage;
        @AuraEnabled public Integer deals;
        @AuraEnabled public Decimal amount;
    }

    public static List<StageTotal> openByStage() {
        List<StageTotal> totals = new List<StageTotal>();
        for (AggregateResult row : [
            SELECT StageName stage, COUNT(Id) deals, SUM(Amount) amount
            FROM Opportunity
            WHERE IsClosed = false AND CloseDate = THIS_FISCAL_QUARTER
            GROUP BY StageName
            ORDER BY SUM(Amount) DESC NULLS LAST
        ]) {
            StageTotal t = new StageTotal();
            t.stage = (String) row.get('stage');
            t.deals = (Integer) row.get('deals');
            t.amount = (Decimal) row.get('amount');
            totals.add(t);
        }
        return totals;
    }

    public static Decimal total(List<StageTotal> totals) {
        Decimal sum = 0;
        for (StageTotal t : totals) {
            sum += t.amount == null ? 0 : t.amount;
        }
        return sum;
    }

    public static String asText(List<StageTotal> totals) {
        if (totals.isEmpty()) {
            return 'No open pipeline this quarter.';
        }
        List<String> lines = new List<String>();
        for (StageTotal t : totals) {
            lines.add(t.stage + ': ' + t.deals + ' deals, ' + (t.amount == null ? 0 : t.amount));
        }
        lines.add('Total: ' + total(totals));
        return String.join(lines, '\n');
    }
}
```

**force-app/main/default/classes/PipelineReportRunner.cls** reads the report itself through the Reports API.

```apex
public with sharing class PipelineReportRunner {

    // Runs a report by developer name and returns the grand total of the first summary column.
    public static Decimal grandTotal(String reportDeveloperName) {
        List<Report> found = [SELECT Id FROM Report WHERE DeveloperName = :reportDeveloperName LIMIT 1];
        if (found.isEmpty()) {
            throw new IllegalArgumentException('Report not found: ' + reportDeveloperName);
        }
        Reports.ReportResults results = Reports.ReportManager.runReport(found[0].Id, false);
        Reports.ReportFactWithSummaries grand =
            (Reports.ReportFactWithSummaries) results.getFactMap().get('T!T');
        List<Reports.SummaryValue> values = grand.getAggregates();
        Object amount = values.isEmpty() ? 0 : values[0].getSummaryValue();
        return (Decimal) amount;
    }
}
```

**force-app/main/default/classes/PipelineMetricsTest.cls**

```apex
@IsTest
private class PipelineMetricsTest {

    @TestSetup
    static void setup() {
        Date soon = Date.today();
        insert new List<Opportunity>{
            new Opportunity(Name = 'A', StageName = 'Prospecting', CloseDate = soon, Amount = 1000),
            new Opportunity(Name = 'B', StageName = 'Prospecting', CloseDate = soon, Amount = 500),
            new Opportunity(Name = 'C', StageName = 'Negotiation/Review', CloseDate = soon, Amount = 4000),
            new Opportunity(Name = 'D', StageName = 'Closed Won', CloseDate = soon, Amount = 9999)
        };
    }

    @IsTest
    static void groupsOpenDealsByStageLargestFirst() {
        List<PipelineMetrics.StageTotal> totals = PipelineMetrics.openByStage();
        System.assertEquals(2, totals.size(), 'Closed deals are excluded');
        System.assertEquals('Negotiation/Review', totals[0].stage);
        System.assertEquals(4000, totals[0].amount);
        System.assertEquals(2, totals[1].deals);
        System.assertEquals(1500, totals[1].amount);
    }

    @IsTest
    static void totalsAcrossStages() {
        System.assertEquals(5500, PipelineMetrics.total(PipelineMetrics.openByStage()));
    }

    @IsTest
    static void textSummaryListsEveryStageAndTheTotal() {
        String text = PipelineMetrics.asText(PipelineMetrics.openByStage());
        System.assert(text.contains('Prospecting: 2 deals, 1500'));
        System.assert(text.endsWith('Total: 5500'));
    }

    @IsTest
    static void emptyPipelineHasAFriendlyMessage() {
        System.assertEquals('No open pipeline this quarter.', PipelineMetrics.asText(new List<PipelineMetrics.StageTotal>()));
        System.assertEquals(0, PipelineMetrics.total(new List<PipelineMetrics.StageTotal>()));
    }

    @IsTest
    static void unknownReportsAreRejected() {
        try {
            PipelineReportRunner.grandTotal('No_Such_Report');
            System.assert(false, 'Expected an exception');
        } catch (IllegalArgumentException e) {
            System.assert(e.getMessage().contains('Report not found'));
        }
    }
}
```

Deploy, test and open the dashboard:

```bash
sf project deploy start --source-dir force-app --target-org dev
sf apex run test --class-names PipelineMetricsTest --result-format human --wait 10 --target-org dev
sf org open --target-org dev --path lightning/o/Dashboard/home
```

## What happens behind the scenes

When you run a report, Salesforce translates the report definition into a query against the same tables SOQL uses. It applies the report type's joins, your filters, the running user's **sharing and field-level security**, then groups and summarises the rows. That is why two users can run the same report and see different totals: each sees only what their access allows. A dashboard differs: it caches the results of its source reports **as the running user**, so every viewer sees what that user could see unless the dashboard is dynamic.

Dashboard refresh is on demand or scheduled. A component does not run a new query when a viewer opens the page; it shows the last refreshed results, which is why the page shows a "Last refreshed" time and why a scheduled refresh at a quiet time of day keeps things fast.

The Reports API (`Reports.ReportManager.runReport`) executes a **saved** report and returns a fact map. The key `T!T` is the grand total; keys like `0!T` are the first group's subtotal and `0_0!T` nested ones. Reading the grand total this way guarantees that code and screen use the same filters. In tests, reports are not visible by default, so a test that needs a real report must use `@IsTest(SeeAllData=true)`, which is why the tests above exercise the SOQL-based class and only check the "not found" path of the runner.

Aggregate SOQL and a report should agree. If they do not, the difference is nearly always the filter: fiscal versus calendar quarter, a report's "probability > 0" parameter, or the running user's sharing. Reconciling them is the quickest way to find out which assumption is different.

## Test it and verify

1. Run the five tests and confirm they pass.
2. Open the report in the UI and compare its grand total with `PipelineMetrics.total`. Explain any difference.
3. Open the dashboard, click **Refresh**, and then change a deal's amount; confirm the component updates only after the next refresh.
4. Log in as a user with a different role and compare what they see. Check the dashboard's running user setting.
5. Add a cross filter "Opportunities with Products" and watch the row count change.
6. Export the report details and confirm they match the on-screen rows.

## Common mistakes and fixes

- **Wrong report type.** Choose the type that contains the objects you need before building.
- **Filtering with the wrong date.** Fiscal and calendar periods differ; check the org's fiscal year.
- **A dashboard that nobody opens.** Ask what decision it supports and who owns it.
- **Charts from tabular reports.** Group the report first.
- **Running user with too much access.** A dashboard can expose data to viewers who could not run the report.
- **Too many components.** Keep to the few numbers that drive decisions.
- **Counting rows when you need unique records.** A report type with children can repeat the parent.
- **Hard-coding report ids in code.** Use the developer name or a custom metadata value.

## Key takeaways

- Report type first, then format, filters and groupings.
- Summary reports feed dashboard charts.
- A dashboard is a cached view as its running user.
- Use the Reports API so that code and screens share one definition.
- Reconcile reports with SOQL to find hidden assumptions.

## Where to go next

- Read [SOQL relationships and aggregate queries](/articles/soql-relationships-and-aggregate-queries/) for the queries behind reports.
- Read [Salesforce data model and relationships](/articles/salesforce-data-model-and-relationships/) to design objects that report well.
- Read [The Salesforce sharing model explained](/articles/sharing-model-explained/) to understand why users see different numbers.
