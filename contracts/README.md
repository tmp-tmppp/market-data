# Contracts of market-data

Written first; the code follows them (plan section 7: the event contracts are the agreement between the services).

| File | What it is |
|---|---|
| `openapi.yaml` | The public REST API under `/v1/market-data` (gateway prefix) and the health probes. market-data has no internal API. |
| `graphql/schema.graphql` | The GraphQL query endpoint `POST /v1/market-data/graphql` (REQ-17, ADR-023): the same three reads as the REST API, queries only, over the same use cases. The service builds its schema from this file at start, and a contract test compares the schema a running application serves with it. The gateway's prefix `/v1/market-data` already routes it. |
| `asyncapi.yaml` | The events market-data consumes: TenantCreated (stream TENANTS), MarketOpened, MarketClosed, MarketResolved (MARKETS), TradeExecuted (TRADING), with the fields it reads and its three durable consumers. It publishes nothing. |
| `external/*.yaml` | Copies of the publishers' contracts, read by the contract tests (never skipped, so a CI run does not depend on the other repositories). |

## External copies

Copied on 2026-11-11 from the working trees of the sibling repositories (none of the three files was committed yet).
When a publisher changes its contract, copy the file again, update the hash below and run the contract tests.

| Copy | Origin | SHA-256 |
|---|---|---|
| `external/markets-asyncapi.yaml` | `markets/contracts/asyncapi.yaml` | `acf84a54d60b39dc6f40e1e046afe8f58387abd0bde30bbae75285ff69c55ff8` |
| `external/trading-asyncapi.yaml` | `trading/contracts/asyncapi.yaml` | `1f6c5807c5e230e055abf98143fd428feeae9218b7a929ef2ba24819b3dafb61` |
| `external/tenants-asyncapi.yaml` | `tenants/contracts/asyncapi.yaml` | `750a0e1ad12d4b3f5e131c956220f953ec736fde4dca20f26dfb915b926e02d7` |

markets added the event types `ShareLinkCreated` and `ShareLinkRevoked` to the MARKETS stream; the `chance.markets.>`
consumer stores them in `consumed_events` as unprojected (cause `other_type`), and `MarketOpened` is unchanged, so the
new copy changes no code. markets' schemas have `additionalProperties: false` on the data, so the contract test builds
its sample events from the copy and checks that `readProjectionEvent` accepts every valid sample, that every other event
of the copy (the two share-link events among them) is read as unprojected, and that the fields it reads (`asyncapi.yaml`
here) are a subset of the publisher's required fields. A field a publisher adds later to an event market-data reads is
ignored (a test plays that with an invented optional field).

trading added the optional field `kind` (`buy` or `sale`, UC-08) to `TradeExecuted` (copy of 2026-11-11, contract
version 0.2.0). A sale of S shares of one side is published as the buy of S shares of the other side it makes, so
market-data reads it unchanged: the price point is `yesPriceMicro`, the volume `costMicro` (the credits paid into the
market maker's offers, as for a buy); `kind` is not read. A contract test reads a sale and the same event as a buy and
gets the same facts.

## Rules the code keeps

- Units (ADR-055): every `...Micro` field is an exact integer; prices are microcredits per share of YES.
- Problems: RFC 9457 `application/problem+json`, `type` = `urn:chance:problem:<code with dashes>`.
- Every `/v1/` answer: `Cache-Control: private, no-store` and `X-Correlation-Id`.
- GraphQL (REQ-17, ADR-023) has its own schema file here and is not in `openapi.yaml`: the contract test of the routes
  lists `POST /v1/market-data/graphql` beside the local events route as the one route outside it. Its errors are GraphQL
  errors whose `extensions.code` is the code of the REST problem for the same condition (the codes and what each means are
  in the README, "GraphQL"); every answer carries `Cache-Control: private, no-store` like the REST answers.
