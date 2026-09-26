Storm Prep signal notes (risk rule v2). Still current for the risk rule and event schema; the ReserveGate plan is docs/agents/plan-of-attack.md.

# Research: ERCOT NP3-233-CD (Hourly Resource Outage Capacity)

Slice 0, researched 2026-09-25. This is reference knowledge for the plan, not a spec.

Sources, in order of trust:

1. A live read-only call made on 2026-09-25 at 11:47 CDT with the project's own
   credentials (throwaway script in `/tmp`, nothing kept in the repo, no secrets printed).
2. ERCOT's official OpenAPI spec: `https://github.com/ercot/api-specs` (`pubapi/pubapi-apim-api.json`).
3. ERCOT Developer Portal user guide:
   - Registration and auth: https://developer.ercot.com/applications/pubapi/user-guide/registration-and-authentication/
   - Using the API: https://developer.ercot.com/applications/pubapi/user-guide/using-api/
4. ERCOT data product page: https://www.ercot.com/mp/data-products/data-product-details?id=NP3-233-CD
5. The open-source `gridstatus` library (used only to cross-check, not as a dependency).

Each statement below is marked **Verified live**, **Documented** (ERCOT docs/spec), or
**Inferred** (our reading of the evidence, to be confirmed when we build that slice).

## 1. What the report is

- Name: Hourly Resource Outage Capacity. EMIL id `NP3-233-CD`, report type id `13103`. (Documented)
- It sums approved Planned, Forced and Maintenance outages of generation resources, by
  **load zone**, taken from ERCOT's Outage Scheduler. It includes full outages and de-rates.
  It does **not** use live telemetry. (Documented)
- ERCOT publishes a new posting every hour. Each posting forecasts outage MW for each hour
  ahead (ERCOT says "next 168 hours"). (Documented)
- A posting has 192 rows. The 12:00:47 posting on 2026-09-25 ran from `2026-09-24 HE24`
  to `2026-10-02 HE23`, so it starts with the last hour of the **previous** day.
  (Verified live, step 0 fixture)
- There are three outage categories, each split across four load zones:
  - **Resource**: all active resource outages except renewables (IRR) and new equipment.
  - **IRR**: intermittent renewable resources (wind, solar).
  - **New Equip Resource**: new equipment still being energized.

## 2. Getting access (one-time, done by the owner)

1. Go to the ERCOT API Explorer (https://apiexplorer.ercot.com) and click **Sign In/Sign Up**.
   Verify your email, then choose a password. (Documented)
2. In API Explorer open **Products**, choose **Public API**, give the subscription a name,
   and click **Subscribe**. (Documented)
3. On your **Profile** page, click **Show** next to the subscription and copy the
   **Primary key**. This is the subscription key. You only need to do this once. (Documented)
4. Put three values in `.env` (never in code, logs or Git):
   `ERCOT_USERNAME`, `ERCOT_PASSWORD`, `ERCOT_SUBSCRIPTION_KEY`.

Status: all three are set in this project's `.env`, and they work. (Verified live)

## 3. How auth works

You need **two** things on every data request: an ID token and the subscription key.

### Step 1: exchange username and password for an ID token

- `POST https://ercotb2c.b2clogin.com/ercotb2c.onmicrosoft.com/B2C_1_PUBAPI-ROPC-FLOW/oauth2/v2.0/token`
- Form fields (`application/x-www-form-urlencoded`):

| Field | Value |
| --- | --- |
| `username` | from `.env` `ERCOT_USERNAME` |
| `password` | from `.env` `ERCOT_PASSWORD` |
| `grant_type` | `password` |
| `scope` | `openid fec253ea-0d06-4272-a5e6-b478baeecd70 offline_access` |
| `client_id` | `fec253ea-0d06-4272-a5e6-b478baeecd70` (public value, same for everyone) |
| `response_type` | `id_token` |

- The response is JSON with keys `access_token`, `expires_in` (`3600`), `id_token`,
  `refresh_token` and `token_type` (`Bearer`). (Verified live)
- Use the **`id_token`** value. ERCOT's guide says ID tokens last one hour and cannot be
  refreshed; you get a new one with another POST. (Documented; `id_token` verified live)
- ERCOT's examples put the password in the URL query string. We send it in the POST
  **body** instead so it can't end up in proxy logs or tracebacks. Sending it in the body works. (Verified live)

### Step 2: call the report with two headers

| Header | Carries |
| --- | --- |
| `Authorization` | `Bearer <id_token>` |
| `Ocp-Apim-Subscription-Key` | the subscription key (Primary key) |

- If the token is missing or wrong, you get HTTP 401:
  `{"statusCode": 401, "message": "Unauthorized. Access token is missing or invalid."}` (Verified live)
- The spec also lists 400 (bad parameters), 403 (no access) and 404. Their error body has
  `timestamp`, `code`, `status`, `message` and `data`. (Documented)
- The API rate-limits with HTTP 429. `gridstatus` retries on 429. We make about two calls
  per run, so this should not happen, but `validate()` must name it if it does.
  (Inferred; ERCOT does not publish an exact limit that we found)

## 4. Endpoint and query parameters

`GET https://api.ercot.com/api/public-reports/np3-233-cd/hourly_res_outage_cap` (Verified live)

All parameters are optional query strings. (Documented in the OpenAPI spec)

| Parameter | Format | Use for us |
| --- | --- | --- |
| `postedDatetimeFrom`, `postedDatetimeTo` | `yyyy-MM-ddTHH:mm:ss` (Central time) | Get only recent postings |
| `operatingDateFrom`, `operatingDateTo` | `yyyy-MM-dd` | Filter to one day |
| `hourEndingFrom`, `hourEndingTo` | integer 1–24 | Filter to one hour |
| `page`, `size` | integer | Paging. `size` up to at least 1000 works |
| `sort`, `dir` | field name, `asc`/`desc` | Ordering |
| `total…MWZone…From/To` | integer | MW range filters (not needed) |

- Default order is `postedDatetime DESC, operatingDate DESC, hourEnding ASC`. (Verified live)
- Query we verified: `postedDatetimeFrom=<now minus 2 hours>&size=400`. It returned the last
  two postings (384 rows, 1 page). (Verified live)
- A narrower query (today + one hour ending + `sort=postedDatetime&dir=desc`) should also
  work according to the spec, but we have **not** tested it. The plan uses the verified query.

## 5. Response shape and fields

The top-level JSON keys are `_meta`, `report`, `fields`, `data` and `_links`. (Verified live)

- `_meta`: `totalRecords`, `pageSize`, `totalPages`, `currentPage`, `query`.
- `report`: `reportName` (`hourly_res_outage_cap`), `reportEMIL` (`NP3-233-CD`), `reportId`.
- `fields`: a list that describes each column in order (`name`, `label`, `dataType`).
- `data`: a **list of lists**. Each row is one hour of one posting, and its values follow
  the same order as `fields`. Rows are not dictionaries. We should build each row's
  dictionary from `fields[i].name` and never hard-code column positions.

The 15 fields, in order (Verified live):

| # | Field name | Type | Meaning |
| --- | --- | --- | --- |
| 1 | `postedDatetime` | DATETIME | When ERCOT posted this report ("data as of") |
| 2 | `operatingDate` | DATE | The day the row is about |
| 3 | `hourEnding` | INTEGER | The hour the row is about (1–24) |
| 4 | `totalResourceMWZoneSouth` | INTEGER | Resource outage MW, South zone |
| 5 | `totalResourceMWZoneNorth` | INTEGER | Resource outage MW, North zone |
| 6 | `totalResourceMWZoneWest` | INTEGER | Resource outage MW, West zone |
| 7 | `totalResourceMWZoneHouston` | INTEGER | Resource outage MW, Houston zone |
| 8 | `totalIRRMWZoneSouth` | INTEGER | Renewable (IRR) outage MW, South |
| 9 | `totalIRRMWZoneNorth` | INTEGER | Renewable (IRR) outage MW, North |
| 10 | `totalIRRMWZoneWest` | INTEGER | Renewable (IRR) outage MW, West |
| 11 | `totalIRRMWZoneHouston` | INTEGER | Renewable (IRR) outage MW, Houston |
| 12 | `totalNewEquipResourceMWZoneSouth` | INTEGER | New-equipment outage MW, South |
| 13 | `totalNewEquipResourceMWZoneNorth` | INTEGER | New-equipment outage MW, North |
| 14 | `totalNewEquipResourceMWZoneWest` | INTEGER | New-equipment outage MW, West |
| 15 | `totalNewEquipResourceMWZoneHouston` | INTEGER | New-equipment outage MW, Houston |

### Which field is the total outage MW?

**No field holds the total.** Older CSV files had a `TotalResourceMW` column, but the
current API only has per-zone fields. (Verified live; `gridstatus` makes the same point)

Definitions (decided by the owner on 2026-09-25):

- **Zone outage MW** = Resource + IRR + New Equip for that zone. For South, that is
  `totalResourceMWZoneSouth + totalIRRMWZoneSouth + totalNewEquipResourceMWZoneSouth`.
- **Total outage MW** = the sum of the four zone totals, which is all 12 MW fields.
- **Driving zone** = the zone with the largest zone outage MW. Its three field names above
  are what the explanation will quote.

## 6. Which hour to rate

- `hourEnding` N covers the hour that **ends** at N:00 Central Prevailing Time. HE 1 is
  00:00–01:00 and HE 24 is 23:00–24:00. (ERCOT convention)
- Decided (for now): rate the **current hour**, `operatingDate = today` and `hourEnding = now.hour + 1`,
  both in `America/Chicago`, taken from the **most recent posting** only.
  At 11:47 CDT, that means today, HE 12.
- Why: it is the hour the batteries face right now, and the newest posting is ERCOT's best
  current view of it. Looking a few hours ahead would give earlier warning, but it adds a
  design choice we don't need yet (see Open questions).
- `validate()` must find **exactly one** row for that date and hour in the latest posting.
  Zero rows, or two (possible on the day clocks fall back, because there is no DST flag
  field), means fail safe.

## 7. "Data as of" / posted time

- `postedDatetime` is the posting time, for example `"2026-09-25T11:00:46"`. (Verified live)
- It has **no time zone**. ERCOT publishes in Central Prevailing Time (CST/CDT), so we read
  it as `America/Chicago`. (Documented ERCOT convention; the report has no DST flag)
- Postings arrive once an hour, shortly after the top of the hour (we saw `11:00:46`).
- Staleness rule (approved): if the newest posting is older than **90 minutes**, the data
  is stale and we call `fail_safe("stale data ...")`. That allows one late posting.
- `operatingDate` is a plain date string (`"2026-10-02"`), and `hourEnding` is an integer.

## 8. Trimmed sample response (real, 2026-09-25 11:47 CDT)

From query `postedDatetimeFrom=2026-09-25T09:47:26&size=400`. `fields` is trimmed to 3 of 15
entries and `data` to 2 of 384 rows. The row values are unchanged. The first rows are for
2026-10-02 because of the default sort order.

```json
{
  "_meta": {
    "totalRecords": 384, "pageSize": 400, "totalPages": 1, "currentPage": 1,
    "query": {
      "parameterCount": 1,
      "parameters": {"postedDatetimeFrom": "2026-09-25T09:47:26"},
      "sortedBy": "postedDatetime: DESC,operatingDate: DESC,hourEnding: ASC"
    }
  },
  "report": {
    "reportName": "hourly_res_outage_cap",
    "reportDisplayName": "Hourly Resource Outage Capacity",
    "reportId": "13103", "reportEMIL": "NP3-233-CD", "downloadLimit": 2000000
  },
  "fields": [
    {"name": "postedDatetime", "label": "Posted", "cardinality": 1, "dataType": "DATETIME",
     "searchable": true, "sortable": true, "hasRange": true},
    {"name": "operatingDate", "label": "Operating Date", "cardinality": 2, "dataType": "DATE",
     "searchable": true, "sortable": true, "hasRange": true},
    {"name": "hourEnding", "label": "Hour Ending", "cardinality": 3, "dataType": "INTEGER",
     "searchable": true, "sortable": true, "hasRange": true}
  ],
  "data": [
    ["2026-09-25T11:00:46", "2026-10-02", 1, 4075, 4338, 985, 2874, 1014, 914, 2881, 350, 450, 1328, 40, 300],
    ["2026-09-25T11:00:46", "2026-10-02", 2, 4075, 4338, 985, 2874, 1014, 914, 2881, 350, 450, 1328, 40, 300]
  ],
  "_links": null
}
```

Worked example for the first row, using the decided definitions:

| Zone | Resource | IRR | New Equip | Zone total |
| --- | --- | --- | --- | --- |
| South | 4075 | 1014 | 450 | 5539 |
| North | 4338 | 914 | 1328 | **6580** (driving zone) |
| West | 985 | 2881 | 40 | 3906 |
| Houston | 2874 | 350 | 300 | 3524 |
| **Total** | 12272 | 5159 | 2118 | **19549** |

## 9. Things `validate()` will need to name

Each of these becomes a clear reason passed to `fail_safe(reason)`:

- Network failures: timeout, connection error, token request refused, HTTP 401, 403, 429,
  5xx, or a response body that isn't JSON.
- The body is missing `fields` or `data`, or has an empty `data`.
- Any of the 15 expected field names is missing from `fields`.
- The newest `postedDatetime` is older than 90 minutes, or is in the future.
- There isn't exactly one row for today and the current hour ending.
- An MW value is not an integer, or is negative.

## 10. Open questions and owner answers (2026-09-25)

1. **Threshold**: resolved in the Slice 1 round. There is no absolute MW threshold (an
   absolute 5000 MW would always rate HIGH against a total of about 19,500 MW). Instead, a
   relative trigger (baseline + `RISK_MARGIN_PCT`) is applied over a `LOOKAHEAD_HOURS`
   window. See `docs/plan.md`, "Risk rule".
2. **Total definition**: all three categories across the 4 zones. The driving zone is the
   zone with the largest sum.
3. **Hour to rate**: first round, the current hour ending. Slice 1 round: the peak of the
   current hour plus the next `LOOKAHEAD_HOURS` − 1 hours, from the newest posting.
4. **`JEV_API_KEY`**: optional, for a later add-on worker. Not used in Slices 0–6 and never
   required.
5. **Python version**: 3.13 (the installed `.venv`, Python 3.13.3). `AGENTS.md` is updated.
