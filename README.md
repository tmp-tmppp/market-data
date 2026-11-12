# market-data

The **read side** of **Chance** (CQRS, plan EP-4, ADR-021). Inside one tenant (an organization), a user opens a list of
markets with their current prices, one market's header and a price chart. This service answers exactly those three
questions, fast, from tables built for them. It never decides anything: it only listens to what **markets** (a market
was opened, closed, resolved) and **trading** (a trade was executed) have published, and keeps the result in a shape that
is cheap to read. Every market and price belongs to exactly one tenant, and a user's tenant always comes from the token.

market-data publishes no events and calls no other service. The gateway calls **it** (public API); it consumes events
(see "Events").

## What it does, in plain words

- **Market list** (`GET /v1/market-data/markets`): the tenant's markets, newest first, each with its question, status
  (`open`, `closed`, `resolved`), close time, current YES price, number of trades and volume. One call can also fetch a
  given set of markets (`?ids=`), which is what the portfolio page needs (DM-12).
- **Market detail** (`GET /v1/market-data/markets/{marketId}`): the same facts for one market, plus the outcome once it
  is resolved.
- **Price history** (`GET /v1/market-data/markets/{marketId}/history`): the chart: open, high, low, close and volume per
  time bucket (1 minute to 1 day), starting at the market's starting price.
- **GraphQL** (`POST /v1/market-data/graphql`, REQ-17): the same three reads as queries, over the same use cases, with the
  same token rules and the same error codes (see "GraphQL").
- **It lags a moment behind a trade** (DM-13: 1 to 2 seconds), because the data arrives by events. A client that has just
  traded passes `afterSequence` with the trade's sequence number and gets `409 updating` until the read model has that
  trade, so a chart never shows the user a state older than their own order (DM-17).
- **It can rebuild itself** (REQ-12, DM-09): it keeps its own copy of every event it consumed, empties the read tables and
  rebuilds them from that copy into a new version while events keep flowing, then switches to the new version in one step.
  See "The replay demo".

## The read model

Two tables per tenant schema hold what the API serves, and every row carries the **projection version** it belongs to:

| Table | One row per | Holds |
|---|---|---|
| `market_summaries` | projection version and market | market version (DM-04), status, question, close time, starting price, opened, closed and resolved times, outcome, last YES price, last trade sequence and time, trade count, volume |
| `price_points` | projection version, market and trade sequence | time, YES price and running volume; sequence 0 is the opening point (the starting price at the time the market opened, volume 0), trades start at 1 |

Next to them: `consumed_events` (every event received, as received: the source of a replay) and `projection_checkpoints`
(which versions exist and which one is active). The rules that fill the tables are small and live in
[`src/domain/projection.ts`](src/domain/projection.ts):

- **A lifecycle event changes status and version only if its version is higher** (DM-04), so a late `MarketOpened` never
  reopens a closed market. An older event can still fill a fact that is not known yet (the question, the close time).
- **A trade is added once per market and sequence number** (DM-10): only a new price point adds to the volume and the
  trade count, and only a point with a higher sequence moves the "last price". A repeated or redelivered trade changes
  nothing; a trade that arrives late still gets its point, so the history has no hole.
- **The rules commute**: every order of the same events gives the same tables. That is what makes it safe to run several
  replicas, to redeliver messages and to run a replay while live events arrive.
- A market that was first seen through a trade is not shown (404, left out of lists) until its `MarketOpened` has arrived.
- The current price of a **resolved** market is its final price: 1 000 000 (YES) or 0 (NO). A market resolved
  **INVALID** (UC-16: the question could not be answered, trading refunded every stake) has no final price: it keeps its
  last trade's price, else its starting price, and its `outcome` is `INVALID` (REST and the GraphQL enum `Outcome`).

## Units

Exactly as the other services (proposed ADR-055): every quantity is an exact integer in micro-units and its JSON field ends
in `Micro`. **Prices are microcredits per share of YES**, `10000` (0.01) to `990000` (0.99); the NO price is always
`1000000` minus the YES price. **Volume is microcredits traded** (the sum of the trades' costs; 1 credit = 1 000 000).
A sale (trading's UC-08, `TradeExecuted` with `kind: "sale"`) is, for trading, a buy of the other side followed by the
redemption of the pairs, and its event describes that buy: its price point is that buy's YES price and its volume
the `costMicro` paid into the market maker's offers, exactly as for any buy (`kind` is not read).
Divide by 1 000 000 to show credits or a price. Sums are checked, never floating point. A trade's price is accepted as
trading's contract publishes it (any integer of that range); the starting price of a market, which markets sends as a
decimal with two places, is converted exactly.

## The replay demo (REQ-12, DM-09, ADR-032, ADR-058)

The read tables are a disposable copy: the truth is the stream of events, and market-data keeps its own copy of it. The
demo empties the read model and rebuilds it **while the service keeps answering and keeps consuming**, without losing or
double-counting an event, and without a user ever seeing a half-built chart. It works like this (the full reasoning is
ADR-058, "market-data rebuilds into a new projection version while the live consumer writes both, then switches
atomically" (Proposed, in the project's `docs/adr`), which builds on ADR-032):

1. **Versions.** Version 1 is `active`: every read uses it. A replay creates version 2, `building`, and notes the newest
   `consumed_events` row at that moment (the high water mark).
2. **Two writers, no gap.** From then on every live event is written to both versions (the live consumer reads the
   versions after it has stored the event, so it always sees the new one). The replay applies the stored rows up to the
   high water mark in batches of at most 1000 rows or about one second, each in its own transaction. Everything at or below
   the mark is applied by the replay, everything after it by the live consumer: nothing is lost, nothing is applied twice
   in effect, because the rules commute and are idempotent per market version and per trade sequence.
3. **Compare.** When the replay has caught up, it compares the two versions (summaries and price points) and reports the
   markets that differ. Normally there are none; a difference means the live version had drifted or the reader changed.
4. **Switch.** In one transaction the active version is retired and the new one activated. Every read resolves the active
   version inside its single SQL statement, so a request sees the old version until the commit and the new one after it.
5. **Clean up.** The rows of retired versions are deleted ("v1 emptied, v2 built"); with differences they are kept for
   comparison and the next run deletes them. The checkpoint rows stay as history.

A rebuild that meets a stored event it **cannot read** (a later event version, or a value the current reader rejects) does
not skip it silently: the event is counted, and the switch is **held** (`outcome: "held"`, the version stays `building`).
The operator then fixes the reader and **runs the replay again**: a held version is not continued but read again from
the start, up to a new high water mark (`resumed` and `rescanned` are both `true` in the report), so the event the old
reader could not read is applied this time and the switch goes ahead. `--allow-unreadable` is the other way out: it
switches although some events still cannot be read, and the new version then **leaves those events out**; a second full
replay after the fix is what recovers them. A stopped replay whose version met no unreadable event resumes where it
stopped; two replays of one tenant at once share the building version, and the one that does not switch ends with
`finished_elsewhere`.

**Run the demo** (the tenant id is the organization's UUID; in the cluster use the `kubectl exec` form of "Commands"):

```bash
npm run replay -- --tenant <tenantId> --status     # 1. version 1 active, its row counts, nothing else
# 2. keep events flowing: trade in the web app, or publish MarketOpened/TradeExecuted events to NATS
npm run replay -- --tenant <tenantId>              # 3. build version 2 while events flow, compare, switch, clean up
npm run replay -- --tenant <tenantId> --status     # 4. version 2 active, version 1 retired with 0 rows
```

Step 3 prints one JSON line per tenant: `outcome` (`switched`, `held` or `finished_elsewhere`), `resumed`, `rescanned`,
`fromVersion`, `toVersion`, `eventsApplied`, `eventsNotProjected` (event types this read model does not use, such as `MarketCreated`),
`eventsUnreadable`, `summaries`, `points`, `differences`, `retiredRowsDeleted`, `startedAt`, `switchedAt`. In the browser
the market list and the charts keep working during all of it and look the same afterwards. `HISTORY_ENABLED=false` (see
"Runtime configuration") pauses only the history while the rebuild runs, if the database needs the room.

## API

Contract first: [`contracts/openapi.yaml`](contracts/openapi.yaml) (served prefix `/v1/market-data` on port 8080, the
gateway routes it). The contract tests fail when a route is missing from the file or the other way round.

| Method and path | Answers |
|---|---|
| `GET /v1/market-data/markets?status&limit&cursor` | `200` a page of listed markets, newest first (market id descending), `limit` 1 to 100 (default 20), `status` `open`, `closed` or `resolved`, an opaque `cursor`. `?ids=a,b,...` (1 to 100 UUIDs) instead returns those markets in the given order in one batch, unknown, other-tenant and not-yet-listed ones left out; `ids` with another parameter is `400` |
| `GET /v1/market-data/markets/{marketId}?afterSequence` | `200` the market, `404` unknown (also another tenant's market and one not listed yet), `409 updating` while the read model has not got trade `afterSequence` yet (the problem carries `lastTradeSequence`) |
| `GET /v1/market-data/markets/{marketId}/history?interval&from&to&limit&cursor&afterSequence` | `200` buckets of `1m`, `5m`, `15m`, `1h` (default), `4h` or `1d`, aligned to the Unix epoch in UTC and sparse (empty buckets are not returned), with open, high, low, close, volume and trade count, and `previousCloseYesMicro` (the close before the page); a range of more than `HISTORY_MAX_POINTS` buckets is `400` (the problem carries `maxPoints`); a page `limit` of 1 to 500 (default 100) and a cursor that keeps the range of page 1 |
| `POST /v1/market-data/graphql` | The three reads as GraphQL queries (REQ-17); its contract is [`contracts/graphql/schema.graphql`](contracts/graphql/schema.graphql), see "GraphQL" below |
| `GET /health/startup`, `/health/ready`, `/health/live` | Kubernetes probes; readiness pings the database and answers `503` while the service drains |

- **Token contract v2** (the same in every service): a bearer JWT, signature checked against the identity provider's keys
  (asymmetric algorithms only), issuer, audience and `exp` required. The tenant is the single alias of the `organization`
  claim (the tenant id, a UUID); the role is that organization's group, exactly one of `/tenant-admin` or `/trader`.
  Traders and tenant admins read everything of their tenant. A `platform-admin` (a realm role), a token without a tenant
  or without a tenant role, or with an unknown or several groups gets `403`; a token of more than one organization, with
  a bad signature or without `exp` is `401`; keys that cannot be fetched are `503 identity_provider_unavailable`.
- **Order of checks**: role, then request shape (`400`), then `HISTORY_ENABLED` (`503 history_paused`, history only), then
  the tenant (`503 tenant_not_ready` until its schema exists), then the market (`404`), then `afterSequence` (`409`), then
  the range and the cursor (`400`).
- Errors are RFC 9457 `application/problem+json` with a stable `code`. Every `/v1/` answer carries
  `Cache-Control: private, no-store` and an `X-Correlation-Id`. Unknown query parameters are `400`.
- **Local only** (`APP_ENV=local` without `NATS_URL`): `POST /local/events` takes one CloudEvent with any valid bearer
  token and runs the same use case as the consumers. It is outside `/v1` (the gateway never routes it) and not in the
  contract.

### GraphQL

**`POST /v1/market-data/graphql`** (REQ-17, ADR-023) answers queries only, over the same use cases as the REST routes: there is
no second data path. The contract is [`contracts/graphql/schema.graphql`](contracts/graphql/schema.graphql), written first;
the service builds its schema from that file at start, and `tests/contracts/graphql.test.ts` compares the schema a running
application serves (its introspection answer) with the file. The engine is `mercurius` 16.12.1 (Fastify 5.x, peer
`graphql` `^16 || ^17`) with `graphql` pinned to 16.14.2, the last 16.x release that is more than two weeks old (16.15.0 of
4 November is a backport of some twenty validator changes and waits until it has been in use for a while). mercurius runs
the queries; the HTTP route is this service's own (`routes: false`), so the endpoint is POST only and has the checks below.

| Query | Arguments | Same as REST |
|---|---|---|
| `markets` | `status`, `ids`, `first` (1 to 100, default 20), `after` | `GET /markets` (`first` is `limit`, `after` is `cursor`); a page `MarketPage { items, pageInfo { hasNextPage, endCursor } }`; `ids` is the batch of DM-12 |
| `market` | `id`, `afterSequence` | `GET /markets/{marketId}` (DM-17 `afterSequence`) |
| `history` | `marketId`, `interval`, `from`, `to`, `first` (1 to 500, default 100), `after`, `afterSequence` | `GET /markets/{marketId}/history`; the interval is an enum (`ONE_MINUTE` to `ONE_DAY`), `buckets` and `previousCloseYesMicro` as there |

```graphql
query Chart($id: ID!) {
  market(id: $id) { question status currentPriceYesMicro volumeMicro }
  history(marketId: $id, interval: ONE_HOUR, first: 24) { buckets { start openYesMicro closeYesMicro trades } pageInfo { endCursor } }
}
```

- **Queries only, POST only.** No mutation and no subscription exist (a read model has nothing to write). A `GET` (which a page
  of another site could trigger) is `405` with `Allow: POST` and never runs a query. The body is one JSON object
  `{ "query", "variables"?, "operationName"? }` (`extensions` is accepted and ignored): a batch (an array), a body that is
  not `application/json` (`415`, and `text/plain` is `400`), a query over 10 000 characters or 2 000 tokens and a body over
  16 KiB are refused. No GraphiQL, no persisted queries.
- **Same token rules.** Token contract v2 as for REST: signature, issuer, audience and `exp` are verified, and a trader or
  a tenant admin of the one tenant in the token reads that tenant's data; a platform admin, a token without a tenant or
  without exactly one valid group gets `403`. These checks run before the body is read, so a caller without rights learns
  nothing from a validation error. The schema has no tenant argument or field: the tenant comes from the token only
  (the contract test fails when a name contains `tenant`). `401`, `403` and `503 identity_provider_unavailable` keep their
  HTTP status and headers (`WWW-Authenticate`, `Retry-After`).
- **Same errors, as GraphQL errors.** Every failure has one shape, `{ message, locations?, path?, extensions: { code,
  status, ... } }`, never problem+json. `code` is the code of the REST problem (`validation_failed`, `not_found`,
  `updating` with `lastTradeSequence`, `history_paused`, `tenant_not_ready`, `forbidden`, `unauthorized`,
  `identity_provider_unavailable`, `bad_request`, `internal_error`); `status` is the HTTP status REST gives for it;
  `fields` lists the invalid arguments (by the name the caller sent: `first`, `after`, `id`); a 503 carries
  `retryAfterSeconds`, a too wide range `maxPoints`. One function maps an error to a status and a code for both APIs
  (`describeError` in `src/web/problems.ts`). A query that ran is `200` with the failed field `null` and its error in
  `errors` (the other fields of the query still answer); a query that cannot run is `400` without `data`, with
  `graphql_syntax_error`, `graphql_validation_failed` (it does not fit the schema: that includes a variable of the wrong
  type, such as a text for an `Int` or an unknown enum value, exactly as the same value written in the query), `depth_limit_exceeded`,
  `complexity_limit_exceeded` or `introspection_disabled`. An unexpected error shows a fixed text and is logged; a mistake
  of the caller is never logged as one.
- **Limits** (settings, see "Configuration"; a query over a limit never runs). *Depth* is the levels of nested fields
  (`{ markets { items { marketId } } }` is 3; fragments add none; introspection is not counted). The schema has no
  recursive type, so its deepest legal query is 3 levels: the limit (5) guards the schema growing and a client that nests
  nonsense. *Complexity* counts every selected field once (an alias or a fragment used twice counts twice, because it runs
  twice), a root field 20 more (one database round trip), and the fields of `items` and `buckets` once per row the page
  asks for (`first`, or the number of `ids`): a full page of 100 markets with every field costs 1 824, a full page of 500
  buckets 4 029, the default limit is 5000. A page size that comes from a variable is the value the request sends, or, when
  it sends none, the default declared with the variable (`query($n: Int = 500)` costs 500 rows, as it runs). Fragment walks
  are memoized, so a document of fragments that spread each other is measured in proportion to its size.
  *Repeated fields*: graphql compares every pair of fields that share a response name while it validates, which grows with
  the square of the repeats (1 400 times `status` is about 250 ms of the one event loop, 250 times `markets { items {
  status } }` about as much, against 2 ms for a plain query), and the length and token limits do not bound it. So a
  document may select a field again under a name its level already has (directly, or through inline fragments and spread
  fragments) at most 50 times in all, otherwise it is `400 complexity_limit_exceeded` (with `field` and `maxRepeatedFields`
  in the extensions) before anything is validated; the worst document under the limit validates in about 12 ms. Aliases are
  not repeats, and the fragments of a client's components that each select `marketId` repeat it a handful of times.
- **No introspection in production** (`GRAPHQL_INTROSPECTION`, default `false`, `true` for `APP_ENV=local`): `__schema` and
  `__type` are `400 introspection_disabled`, `__typename` always works, and the "Did you mean ..." of a query error is cut so
  that the error texts do not list the schema either. The schema file is the documentation.
- **Cache-Control and correlation.** Every answer carries `Cache-Control: private, no-store` and `X-Correlation-Id`, like
  every `/v1/` answer (INF-02).
- **The gateway** needs no change: its `market-data` route sends the prefix `/v1/market-data` (class `user`: any valid
  token, the rate limit) to `market-data:8080`, which covers `/v1/market-data/graphql`; the NetworkPolicy already admits the
  gateway to the one port. The schema file is part of the image (`COPY contracts/graphql`); adding a field is a change of
  that file, of `src/web/graphql/resolvers.ts` and of the contract test, in one commit.

## Metrics

Rate, errors and duration of the HTTP API (REQ-20), in the Prometheus text format. The Node services of the platform
use the same names, labels and port (the convention agreed on 2026-11-11), so one dashboard can read them all; the module is
[`src/adapters/metrics/metrics.ts`](src/adapters/metrics/metrics.ts) (prom-client 15).

- **Endpoint.** `GET /metrics` on `METRICS_PORT` (default `9464`), a listener of its own: any other path there answers
  `404`, and the API port (`PORT`) never serves `/metrics`, so the gateway can never route it. The listener starts with
  the service and closes with it on shutdown (after the API server). Services started natively on one host need a
  different `METRICS_PORT` each (in a cluster every Pod has its own address).
- **`http_requests_total`** (counter) and **`http_request_duration_seconds`** (histogram, the default buckets), both
  with the labels `method`, `route`, `status_code` and `tenant`. Errors are the `status_code` values 4xx and 5xx; the
  duration runs from the arrival of the request to the end of its response.
- **`route`** is the route template (`/v1/market-data/markets/:marketId/history`), or `unmatched` for a request that
  matched no route (a 404, or the 400 and 414 of a URL Fastify cannot route, counted by `recordFrameworkError` because those
  answers bypass the hooks), so a raw URL or an id never becomes a label value. The GraphQL endpoint is one route
  template, `/v1/market-data/graphql`, whatever the query.
- **`tenant`** is the tenant id in the token the service verified, `none` when the request has no verified token or the
  token names no tenant. It is never read from a header or the body.
- **`graphql_errors_total{code}`** counts the errors in the answers of the GraphQL endpoint by their stable
  `extensions.code` (`validation_failed`, `forbidden`, `depth_limit_exceeded`, `method_not_allowed`, ...; a value that is
  not a short snake_case word is `unknown`). The operation name, the field and the message are never labels. One answer
  with two errors counts two.
- **`market_data_projection_events_total{result}`** counts the projection events after their transaction committed:
  `applied`, `stale` (an older or repeated fact), `unprojected` (stored, not projected: MarketCreated and the other
  types) and `duplicate` (a redelivery).
- **`market_data_projection_trade_sequence_gap`** (histogram) observes, for every trade that changed the active
  projection, how many trades of its market with a lower sequence the projection has not seen yet (the highest
  sequence seen minus the trades seen): 0 means complete up to the last trade, a positive value a trade that arrived
  before an earlier one (the readers' `409 updating` with `afterSequence` waits for exactly that).
- The default process metrics of prom-client (`process_*`, `nodejs_*`) are on the same registry.
- **Chart.** The Pod has a container port `metrics` and the annotations `prometheus.io/scrape: "true"`,
  `prometheus.io/port: "9464"` and `prometheus.io/path: /metrics` (the port is the chart value `metrics.port`, also
  rendered as `METRICS_PORT`; the Service does not expose it). With `networkPolicy.enabled`, the namespace
  `networkPolicy.metrics.namespace` (default `monitoring`) is admitted on that port, and only on that port.

## Events

market-data only consumes; the contracts are [`contracts/asyncapi.yaml`](contracts/asyncapi.yaml) and the publishers'
own, kept as copies in [`contracts/external`](contracts/external) (see `contracts/README.md`).

| Stream | Durable consumer | Subjects | What it does |
|---|---|---|---|
| `TENANTS` | `market-data` | `chance.tenants.TenantCreated.*` | provisions the tenant's schema |
| `MARKETS` | `market-data` | `chance.markets.>` | `MarketOpened`, `MarketClosed`, `MarketResolved` change the markets; every other type is stored and skipped |
| `TRADING` | `market-data` | `chance.trading.TradeExecuted.*` | adds the trade's price point and volume |

All three share the delivery rules: at most 10 unacknowledged messages, explicit acknowledgement only after the
transaction has committed, 30 seconds to acknowledge, redelivery without limit with a 5 second delay after an error, a
missing stream is logged and retried, and a message that fails 20 deliveries is **parked** in `shared.parked_events` and
acknowledged. They differ on a message that cannot be attributed to a tenant. `MARKETS` and `TRADING` park it at once (not
a CloudEvent, no tenant id), so `npm run parked` shows it and nothing is dropped silently. `TENANTS` acknowledges and
skips a message that is not a usable `TenantCreated` (not JSON, not a CloudEvent 1.0, another type, a `tenantid` that is
missing or differs from `data.tenantId`) after one warning in the log, and parks nothing: `TenantCreated` is not a replay
source, and a tenant whose event was missed is created from the first market or trading event it sends (`ensureTenant`);
until then it answers `503 tenant_not_ready`. One transaction per event: the inbox row (the same event id twice is
applied once), the `consumed_events` row, then the projections. Every message of the `MARKETS` and `TRADING` consumers
with a usable envelope is stored in `consumed_events`, projected or not (`ShareLinkCreated` and `ShareLinkRevoked` of
markets among them), so a replay after a fixed or extended reader recovers what the old reader rejected. Several replicas
share each durable consumer; the rules commute, so that is safe.

## Commands

All three need the built code (`npm run build`) and `DATABASE_URL` (only `backfill --dry-run` does without); in the
cluster run them inside the Pod of the deployment (`node dist/<command>.js`). They never touch NATS. Wrong use (an unknown
option, an option without its value, a stray argument, a bad `--batch-size`, no `DATABASE_URL`) exits with `64`, the reason
and a usage line on stderr; `1` is reserved for a tenant or a line that failed.

```bash
npm run replay   -- [--tenant <tenantId>] [--batch-size <n>] [--keep-old] [--allow-unreadable] [--status]
npm run backfill -- --file <events.ndjson> [--dry-run]
npm run parked   -- [--consumer <name>] [--retry]
```

- `replay` rebuilds the projections of one tenant into a new version and switches to it (see "The replay demo"). Without
  `--tenant` it covers every registered tenant, one after the other. `--batch-size` is 1 to 1000 (default 500).
  `--keep-old` keeps the rows of the retired version. `--allow-unreadable` lets the switch go ahead although the build
  met stored events it could not read, which stay out of the new version (otherwise the outcome is `held`; fix the reader
  and rerun, without the flag: the rerun reads the stored events again from the start and applies the ones that can be
  read now). `--status` prints the checkpoints and the row counts of every version and changes nothing (it does
  not run the migrations either). It prints one JSON line per tenant (a tenant that fails is a line with `"outcome":
  "failed"`, the error and its code, and the others still run) and exits `1` when a tenant failed, `2` when none failed but
  one was held. The command runs the migrations first, as the service does at its start.
- `backfill` loads events older than the streams' retention before go-live, see "First deployment".
- `parked` lists the parked events; with `--retry` it runs them again (after the cause is fixed).

**In the cluster** the commands run as a second Node process inside the service's container. That process shares the
container's memory limit with the server, so cap its heap:

```bash
kubectl exec deploy/market-data -- node --max-old-space-size=96 dist/replay.js --tenant <tenantId>
kubectl exec deploy/market-data -- node dist/replay.js --status
kubectl exec deploy/market-data -- node dist/parked.js
```

There is no Job: the replay is something an operator starts and watches. The chart's limit is `384Mi` (not `256Mi`) for
that reason, see "Delivery".

## First deployment: state older than the streams

The read model is fed only by the streams. `MARKETS` and `TRADING` keep 30 days by default (the `STREAM_MAX_AGE_DAYS`
of each publisher, 1 to 365: long on purpose, so that a consumer started later still sees the older events, and
lowered again once every consumer is live). markets and trading go live before market-data does. If market-data's
consumers start while the streams still hold every event (within that time of the first one; the consumers deliver
all, from the start of the stream), nothing is missing and no backfill is needed. After that, everything older than
the streams' max age is gone from the streams: such a market would never be listed, its early trades would be missing
from the volume and the history, and a tenant with no market or trade event in that time would answer
`503 tenant_not_ready` for good. A replay cannot help, because `consumed_events` never held those events. Before
go-live load them once:

```bash
npm run backfill -- --file events.ndjson --dry-run       # reads and counts, writes nothing
npm run backfill -- --file events.ndjson                 # applies
kubectl exec -i deploy/market-data -- node --max-old-space-size=96 dist/backfill.js --file /dev/stdin < events.ndjson
```

Each line of the file is one CloudEvent in the publishers' published schemas: `TenantCreated` provisions the tenant, every
other line goes through the same use case as a consumed message (inbox, `consumed_events`, projections). The command is
idempotent and does not care about order, provided each market's lifecycle lines carry their own versions (see below): an
event id seen before is a duplicate, and the projection rules are idempotent per market version and per trade sequence, so
a synthetic event next to the original one still in the stream is applied once in effect. It reads the file as a stream, line by line, so `--file /dev/stdin` works. It prints one JSON line for each
problem line (an unattributable one, with its line number and the reason, is skipped; one whose use case failed, with the
error, does not stop the run) and a last JSON line with the number of lines and the count of each result (`provisioned`,
`applied`, `stale`, `unprojected`, `duplicate`, `unattributable`, `failed`). It exits `1` when a line failed; an
unattributable line is reported but does not fail the run, because no retry can change it, only a corrected export.
`--dry-run` only classifies the lines (`tenant_created`, `event`, `unattributable`) and needs no database. The order of the
go-live: deploy market-data first (its consumers start collecting), then produce the files and run the backfill; the
overlap with the stream is harmless.

The files come from the publishers (follow-ups, not built here): tenants exports `TenantCreated` for every tenant; markets
exports, per market, the lifecycle events its current state implies, each with **the version the market had at that
transition** (DM-04) and a fresh event id; trading exports `TradeExecuted` for every trade from its ledger. markets keeps
one `version` column that rises by 1 per transition, so with V the current version of the row: an open market exports
`MarketOpened(V)`; a closed one `MarketOpened(V-1)` and `MarketClosed(V)`; a resolved one `MarketOpened(V-2)`,
`MarketClosed(V-1)` and `MarketResolved(V)`. Never stamp V on all of them (do not call markets' own event builders on the
current row unchanged): the projection changes a status only for a strictly higher version, so three lines with one version
give a result that depends on the order of the lines, and the original `MarketResolved` still in the stream carries V
too. The command refuses the second of two lifecycle lines of one market that carry the same version (reported as
`unattributable`, with the line number and the reason). The infrastructure side of the same problem is what the publishers
do by default now: their streams keep 30 days (`STREAM_MAX_AGE_DAYS`, up to 365), which covers a deployment of
market-data inside that time without any export; raise the value for a later one.

## Configuration

Settings come from environment variables; the service refuses to start with a clear message when a required one is
missing or invalid, and never prints a value. In Kubernetes the non-secret ones come from the chart's ConfigMap and the
secret one from the Secret `market-data-env`. The rows marked **runtime** can also change while the service runs (see
"Runtime configuration"). The source of truth is [`src/config.ts`](src/config.ts) with `tests/config.test.ts`;
`APP_ENV=local` is the only mode that may leave out the settings marked "required" below (it then uses in-memory
replacements).

| Variable | Default | Secret | Meaning |
|---|---|---|---|
| `APP_ENV` | `production` | no | Lowercase letters, digits and dashes. `local` allows in-memory replacements for the database and NATS (see "Run locally"); tokens are still verified against `AUTH_JWKS_URL`. Any other value needs every required setting, and the chart refuses `local` |
| `PORT` | `8080` | no | The API and the health probes (1 to 65535). market-data has no internal port |
| `METRICS_PORT` | `9464` | no | Port of the separate listener that serves `GET /metrics` (1 to 65535); must differ from `PORT` (see "Metrics") |
| `LOG_LEVEL` | `info` | no | **runtime.** `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent` |
| `HISTORY_MAX_POINTS` | `1000` | no | **runtime.** The most buckets one history request may span (10 to 10000); a wider range is `400` with `maxPoints` |
| `HISTORY_ENABLED` | `true` | no | **runtime.** `false` pauses the price history (`503 history_paused`) while the market list and the detail keep working |
| `RUNTIME_CONFIG_FILE` | none | no | Path of the watched runtime file (the chart sets `/etc/market-data/runtime/runtime.env`); without it no file is watched |
| `RUNTIME_CONFIG_POLL_MS` | `10000` | no | How often that file is read again (1000 to 3600000) |
| `DATABASE_URL` | required | **yes** | PostgreSQL connection string of the service's own database `market_data` (`postgres://` or `postgresql://`) |
| `DATABASE_POOL_MAX` | `5` | no | Maximum database connections (1 to 50) |
| `NATS_URL` | required | no | NATS server (`nats://` or `tls://`, no user name or password in the URL) |
| `AUTH_JWKS_URL` | required (local default) | no | Where the token signing keys are published |
| `AUTH_ISSUER` | required (local default) | no | Expected `iss` of the tokens |
| `AUTH_AUDIENCE` | required (local default) | no | Expected `aud` of the tokens |
| `AUTH_ROLES_CLAIM` | `realm_access.roles` | no | Claim path of the realm roles; only `platform-admin` is read from it |
| `AUTH_TENANT_CLAIM` | `organization` | no | Claim of the organizations, an object keyed by alias (the alias is the tenant id) whose entry holds the `groups`: the tenant role is its one group, `/tenant-admin` or `/trader` |
| `SHUTDOWN_DELAY_MS` | `5000` (`0` when `APP_ENV=local`) | no | Drain delay after SIGTERM, 0 to 15000 (see "Shutdown") |
| `GRAPHQL_INTROSPECTION` | `false` (`true` when `APP_ENV=local`) | no | Whether the GraphQL endpoint answers `__schema` and `__type` (see "GraphQL"); off in a cluster |
| `GRAPHQL_MAX_DEPTH` | `5` | no | The deepest query the GraphQL endpoint runs, 1 to 10 levels of nested fields; a deeper one is `400 depth_limit_exceeded` |
| `GRAPHQL_MAX_COMPLEXITY` | `5000` | no | The most expensive query it runs, 10 to 100000 (fields, with page fields counted per row; see "GraphQL"); a dearer one is `400 complexity_limit_exceeded` |

With `APP_ENV=local` the token settings default to a Keycloak on port 8081 of the developer's machine
(`http://localhost:8081/realms/chance`, audience `chance`, keys at `/protocol/openid-connect/certs`); tokens are always
verified.

### Runtime configuration

Three keys (`LOG_LEVEL`, `HISTORY_MAX_POINTS`, `HISTORY_ENABLED`) can change without a restart (ADR-037). The order is:
defaults, then the watched file `RUNTIME_CONFIG_FILE`, then environment variables, so a key set in the environment always
wins and the file's value for it is ignored (and logged); the chart therefore sets these keys only in the file. The file's
lines are `KEY=value` (blank lines and lines starting with `#` are skipped). The service reads the file at start and then
every `RUNTIME_CONFIG_POLL_MS`; a key that is missing from the file keeps its startup value, so deleting a line undoes an
override. A missing, unreadable or invalid file never stops the service: it keeps what it has, and logs the problem. A key
whose value is invalid (`HISTORY_ENABLED=flase`, `HISTORY_MAX_POINTS=5O`) keeps the value that is in force, not the
startup value, so a typo never lifts a pause; a key name that is misspelled is only logged and counts as a key that is
missing.

In the chart the three keys are the `runtime` block of the values. They are rendered into a second ConfigMap,
`<release>-runtime` (key `runtime.env`), which the Pods mount as the directory `/etc/market-data/runtime` (never as a
`subPath`, which would not update). That ConfigMap is left out of the Deployment's checksum annotation on purpose: a
change reaches the running Pods within about a minute (the kubelet refreshes the mount, then the poll) and does not
restart them. Everything else in `env` is read at start, and a change restarts the Pods.

## Shutdown

On SIGTERM (Kubernetes) or SIGINT the service shuts down in two steps, so that a rolling deploy does not fail requests
that were already on their way:

1. **Drain.** `GET /health/ready` answers `503` from this moment. The service keeps serving requests and keeps consuming
   for `SHUTDOWN_DELAY_MS` (default 5 seconds), the time the load balancer needs to take the Pod out of rotation.
2. **Close**, in this order: the HTTP server, the three consumers (a message being handled is finished and
   acknowledged, the rest stay on the stream), the inbox maintenance, the runtime-file watcher, NATS, the database
   pool. It exits with `0`; if closing takes more than 10 seconds after the delay, it exits with `1`.

The chart keeps `terminationGracePeriodSeconds: 30`: the delay is limited to 15 seconds, so delay plus close always ends
before Kubernetes sends SIGKILL.

## Run locally

Node.js 24 is required.

```bash
npm ci
npm run build
APP_ENV=local npm start          # everything in memory, no consumers
```

In local mode without a database the memory store provisions a tenant the first time it sees it, so any token with a
tenant claim works at once. There are no consumers without NATS, so feed the read model through the local route with any
valid token, one CloudEvent per call (the shapes are in `contracts/asyncapi.yaml`):

```bash
curl -s -X POST http://localhost:8080/local/events -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data @market-opened.json
```

Tokens are always verified: point `AUTH_JWKS_URL`, `AUTH_ISSUER` and `AUTH_AUDIENCE` at the identity provider (the realm of
the `identity` repository) or at a key set of your own.

The GraphQL endpoint is on the same port. A local run answers introspection by default (`GRAPHQL_INTROSPECTION=true`), so a
client such as Altair or `graphql-codegen` can read the schema from it; everywhere else the file
[`contracts/graphql/schema.graphql`](contracts/graphql/schema.graphql) is the documentation:

```bash
curl -s -X POST http://localhost:8080/v1/market-data/graphql -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  --data '{"query":"{ markets { items { marketId question currentPriceYesMicro } pageInfo { hasNextPage } } }"}'
```

With a real database and NATS (Docker needed): `docker compose up -d`, then start with `DATABASE_URL` and `NATS_URL` as
shown at the top of [`compose.yaml`](compose.yaml); `docker compose --profile app up --build` runs the service itself in a
container as well (API on `localhost:8083`). With NATS the local events route is not there: a tenant is provisioned by
`TenantCreated` or by the first market or trade event that names it, so run tenants, markets and trading against the
same NATS (or publish the events by hand); until then user requests answer `503 tenant_not_ready`. The replay demo then runs
with `docker compose --profile app exec market-data node dist/replay.js ...` or with `npm run replay` against the
published PostgreSQL port.

## Tests

```bash
npm run lint                     # ESLint, including the layer rules below
npm run typecheck
npm test                         # unit, web and contract tests; npm test -- --coverage for the coverage report (80 % threshold)
npm run test:integration         # PostgreSQL 18 in a container (Testcontainers); needs Docker
```

The domain is tested on its own (the projection rules over every order of a set of events, the bucketing, the units), the
use cases run against the in-memory store, the web tests send real signed JWTs, the GraphQL tests (`tests/web/graphql*.test.ts`:
every query, every auth case, the limits, the error mapping, and the same questions put to GraphQL and to REST over the real
use cases) compare the two APIs field by field, and the contract tests fail when a route
is missing from `openapi.yaml` (or the other way round), when a response does not match its documented schema, or when an
event built from a publisher's schema (`contracts/external`) is not accepted by the reader. The integration tests cover the
migrations per tenant schema, every constraint of the tables and the append-only trigger, the SQL buckets against the
domain's bucketing, the version switch and the cleanup, two replays starting at once, and the real use cases running
concurrently on the PostgreSQL store (`tests/integration/use-cases-concurrency.test.ts`: live events from two consumers
during a replay; afterwards the active version equals a fold of every stored event, the report has no differences, a poller
never saw a trade count go down or a half-built version, and the old version's rows are gone).

The chart is checked the way the pipeline checks it: `helm lint helm -f helm/values-dev.yaml` (and the prod values), and
`helm template market-data helm -f helm/values-prod.yaml` through `kubeconform -strict` (also with
`--set networkPolicy.enabled=true`).

## Layout (Clean Architecture)

| Folder | Holds | May import |
|---|---|---|
| `src/domain` | Units, the consumed events and their reader, the projection rules, history buckets, the tenant schema naming; no I/O | nothing outside the domain |
| `src/usecases` | One class per use case, the ports (interfaces), errors and shared helpers; `apply-event.ts` is the only code that writes an event into a projection version | the domain |
| `src/adapters` | PostgreSQL store and migrator, the generic JetStream consumer with its message handlers, the inbox maintenance, the runtime-file watcher, the metrics modules (HTTP, projection and GraphQL metrics), the in-memory store for local runs and tests | use cases and domain |
| `src/web` | The Fastify app and routes, token checks, problem details | use cases and domain |
| `src/web/graphql` | The GraphQL endpoint: the route and the mercurius setup (`endpoint.ts`), the three queries (`resolvers.ts`), the two scalars, the depth, complexity, repeated-field and introspection limits (`limits.ts`), the error shape (`errors.ts`) and the one place that loads `graphql` (`graphql-js.ts`) | use cases, domain and `src/web` |
| `src/main.ts` | Composition root: configuration, adapters, use cases, the server and the consumers | everything |
| `src/replay.ts`, `src/backfill.ts`, `src/parked.ts` | The three commands; the loops of the first two are in `src/replay-run.ts` and `src/backfill-run.ts`, which are tested without a database | use cases and adapters |
| `src/config.ts`, `src/shutdown.ts` | Typed configuration and the shutdown sequence (its steps are passed in, so it is tested with fake timers) | the logger port |
| `migrations/shared`, `migrations/tenant` | Versioned SQL: the shared schema (tenant registry, inbox, parked events), and the tables of one tenant (checkpoints, consumed events, summaries, price points), applied to every tenant schema | |
| `contracts` | The OpenAPI file, the GraphQL schema (`graphql/schema.graphql`), the AsyncAPI file and the publishers' contracts as copies | |
| `helm` | Chart with dev and prod values, a watched runtime ConfigMap and a `helm test` smoke test | |

The lint fails when an inner layer imports an outer one. `GetMarket`, `ListMarkets` and `GetHistory` know nothing of HTTP:
the REST routes and the GraphQL resolvers both call them, and that is the whole of their relation.

`graphql` ships an ES module build and a CommonJS build, and mercurius loads the CommonJS one; an `import "graphql"` from
this package would load the other, and graphql refuses to mix them ("Cannot use GraphQLObjectType from another module or
realm"). So `src/web/graphql/graphql-js.ts` loads it with `createRequire`, and every other file of the endpoint imports its
values from there (types are safe from anywhere).

## Delivery

Pull requests run lint, type check, tests with coverage, chart checks and an image build; a merge to `main` builds the
image once, pushes it to Docker Hub and deploys it to the prod namespace with Helm, followed by the smoke test and an
automatic rollback on failure. The steps live in the organization's shared workflow; see
[`.github/workflows/ci-cd.yml`](.github/workflows/ci-cd.yml). That workflow does not run the integration tests, and the
coverage gate leaves out the PostgreSQL and NATS adapters, so this repository has its own workflow for them,
[`.github/workflows/integration.yml`](.github/workflows/integration.yml) (`npm run test:integration` on pull requests and on
`main`; make it a required check). The image holds `dist/`, the production dependencies, the whole `migrations` tree and
`contracts/graphql` (the schema file the service reads at start; `.dockerignore` keeps the rest of `contracts/` out),
exposes port 8080, and runs as a non-root user on a read-only file system.

The chart (`helm`) creates a Deployment, a Service with the one port `http` 8080, the environment ConfigMap, the runtime
ConfigMap, a `helm test` smoke test (the readiness endpoint through the Service, no token; the Pod also has a container port `metrics` with the Prometheus annotations, not on the Service) and, when
`networkPolicy.enabled` is set, a NetworkPolicy. The Secret `market-data-env` (`DATABASE_URL`) is created by the pipeline
from the organization secret `MARKET_DATA_ENV` and is never part of the chart. The NetworkPolicy admits only the API
gateway (and the smoke test) to the port, only the namespace `networkPolicy.metrics.namespace` to the metrics port, and lets the Pods reach only PostgreSQL (5432), NATS (4222), the identity
provider (8080) and DNS (53): market-data calls no other service. The probes and the smoke test use the one port. The
readiness probe has its own `timeoutSeconds` (4, below `periodSeconds`): the handler waits for a pool connection like any
request, up to 3 seconds, and the kubelet's default timeout of 1 second would take a busy Pod out of the Service while the
database is fine. The schema of the chart bounds the startup settings that the service checks at start
(`DATABASE_POOL_MAX`, `SHUTDOWN_DELAY_MS`, `RUNTIME_CONFIG_POLL_MS`), the three runtime keys and the memory of the
container, and the template refuses `metrics.port` equal to `service.port`, so a bad value fails `helm lint` and not the rollout. One replica is the default; several are safe (shared
durable consumers, rules that commute).

**Memory.** The container's limit is `384Mi` and its request `128Mi`, where the services that run one process get `256Mi`:
the replay and the backfill run as a second Node process inside the container (`kubectl exec`), and an out-of-memory kill
would take the API and the consumers down in the middle of the demo. The replay's heap is capped
(`node --max-old-space-size=96`) and it reads at most 1000 rows per batch. The schema refuses a smaller limit. The numbers
below are measured, not assumed: `node dist/main.js` ran with every setting of production (three consumers connected, a
pool of 5) against PostgreSQL 18 and NATS 2.15, Node 24.21, no image build. A demo tenant of 12 markets with 3,612 events
was loaded with `backfill`, then `node --max-old-space-size=96 dist/replay.js` rebuilt it while 480 more `TradeExecuted`
events arrived on the stream, and again once the tenant was settled (4,092 stored events). The resident set size
(`VmRSS`, `VmHWM` of `/proc/<pid>/status`, sampled every 10 to 25 ms) is the peak of the process.

| Process | Resident set | Share of 384 MiB |
|---|---|---|
| `node dist/main.js` (server and consumers) at rest, before the load | 101 MiB | 26 % |
| `node dist/main.js` at its peak while the replays ran and the live events arrived | 105 MiB | 27 % |
| `node --max-old-space-size=96 dist/replay.js`, peak, while live events arrived | 108 MiB | 28 % |
| `node --max-old-space-size=96 dist/replay.js`, peak, settled tenant (the larger of the two) | 121 MiB | 32 % |
| `node --max-old-space-size=96 dist/backfill.js`, peak, 3,613 lines | 130 MiB | 34 % |
| Server at its peak plus the larger replay | 226 MiB | 59 % (limit for action: 75 % = 288 MiB) |

The two together stay under the limit for action, so `384Mi` stays. The server and the largest command at once would be
235 MiB, 61 %. The measurement ran on the host, not in a container: the container also counts page cache, which the kernel
reclaims before it kills anything. Repeat it with `ps -o rss` when a dependency or the batch size changes.

The table above was measured before the GraphQL endpoint existed. The endpoint (mercurius, graphql, graphql-jit and what they
load) adds about 10 to 12 MiB to the server: a bare Fastify application of this service had a resident set of 81 MiB and 92 MiB
with the endpoint registered (three runs each, `/proc/self/status` after 1.5 s idle, 2026-11-11, Node 24.21). The server's
peak with the larger replay is then about 238 MiB, 62 % of the limit and under the 75 % limit for action; the full
measurement against PostgreSQL and NATS was not repeated.

## What it needs

- **PostgreSQL 18**: the database `market_data` and the login role `market_data` on the shared server (DM-01, DM-10); one
  schema per tenant plus the schema `shared`.
- **NATS with JetStream**: the streams `TENANTS` (tenants), `MARKETS` (markets) and `TRADING` (trading), which the
  publishers create; this service creates its three durable consumers `market-data` on them and logs and retries while a
  stream is missing.
- **The identity provider**: the signing keys of the tokens (token contract v2).
- **markets** and **trading**: publish the events this read model is built from; **tenants** publishes `TenantCreated`.
- **The API gateway**, which routes the prefix `/v1/market-data` to `market-data:8080` (the health paths are not routed).

## Follow-ups

Recorded, not built here:

- **GraphQL (REQ-17, ADR-023) is built** (see "GraphQL"). Not built, on purpose: mutations and subscriptions (a read model has
  none), persisted queries, a cache of parsed queries (the complexity depends on the variables) and a GraphQL step in the
  chart's smoke test (it would need a token). The web UI may use it for the portfolio and chart pages; the REST routes
  stay the default.
- **Infrastructure.** The database and login role `market_data` (DM-01) and the organization secret `MARKET_DATA_ENV` (the
  Secret `market-data-env`, `DATABASE_URL`). The gateway already routes `/v1/market-data` to `market-data:8080`.
- **Backfill exports** (see "First deployment"): `TenantCreated` for every tenant (tenants), the lifecycle events of every
  market from its current state (markets), `TradeExecuted` for every trade from its ledger (trading); needed only if market-data
  goes live later than the publishers' streams keep their messages (30 days by default, `STREAM_MAX_AGE_DAYS`, up to 365:
  raising it is the other way).
- **web.** The portfolio page calls `?ids=` once (DM-12); the charts pass the order's trade sequence as `afterSequence` (DM-17).
- **Token contract v2 in the other services.** market-data implements it first; the others follow.
- **ADR-058** (Proposed) goes to the team together with ADR-032.
- **trading (optional).** `multipleOf: 10000` on `TradeExecuted`'s `yesPriceMicro` if the price grid is a promise;
  market-data accepts any integer of the range either way.
- **Chart.** `AUTH_ISSUER` is empty in `helm/values-prod.yaml`; the pipeline fills it in from the organization variable
  `PUBLIC_HOST` (`host-values` in `.github/workflows/ci-cd.yml`), and a deploy without it stops at start (INF-01).
  The NetworkPolicy is off by default: it needs a network policy engine in the cluster, and the labels in `networkPolicy`
  must match the Pods of the gateway and the shared PostgreSQL, NATS and identity.
- **Delivery.** The repository secret `MARKET_DATA_ENV` has to exist before the first deploy, and the Docker image is not
  built locally (the pull-request pipeline builds it).
