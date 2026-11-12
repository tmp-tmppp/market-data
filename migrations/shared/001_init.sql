-- Shared schema of market-data (plan section 6.3 SVC-MDA and section 9): everything that no single tenant owns. The read
-- model (market summaries, price points) and its replay source (consumed_events) are in migrations/tenant and exist once
-- per tenant schema (DM-01). market-data publishes nothing, so there is no outbox, and it never routes by market id, so
-- there is no directory either.
-- Timestamps come from the service clock. Constraints are the last guard (DM-10); foreign keys exist only inside this
-- database (DM-02).
--
-- shared.schema_migrations (version, checksum, applied_at) is created by the migration runner itself, before the
-- first file runs, because it records which files ran; every tenant schema has its own copy of it.

CREATE SCHEMA IF NOT EXISTS shared;

-- The tenants this service has a schema for. A row is written in the same transaction that creates and migrates the
-- schema (the TenantCreated inbox, or ensureTenant for a tenant that markets or trading name first), so a registered
-- tenant always has its schema, and the startup migration applies every tenant migration to every registered schema:
-- schemas never drift apart.
CREATE TABLE shared.tenant_registry (
    tenant_id   uuid        PRIMARY KEY,
    schema_name text        NOT NULL CONSTRAINT tenant_registry_schema_format CHECK (schema_name ~ '^tenant_[0-9a-f]{32}$'),
    created_at  timestamptz NOT NULL,
    CONSTRAINT tenant_registry_schema_key UNIQUE (schema_name),
    -- The schema name is derived from the id and from nothing else.
    CONSTRAINT tenant_registry_schema_matches_id CHECK (schema_name = 'tenant_' || replace(tenant_id::text, '-', ''))
);

-- Inbox of consumed events (ADR-053, DM-06): the id of a processed event is stored in the same transaction as its
-- change, so a redelivered event changes nothing. One consumer per kind of event ("tenant-created", "market-events",
-- "trade-events"), because the same id never repeats across kinds. The entries are purged after the retention of the
-- streams plus a margin (INBOX_RETENTION_MS). The replay does not need them: consumed_events (per tenant) is its source
-- and is never purged (ADR-032, ADR-058).
CREATE TABLE shared.inbox (
    consumer     text        NOT NULL CONSTRAINT inbox_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    event_id     text        NOT NULL CONSTRAINT inbox_event_id_length CHECK (char_length(event_id) BETWEEN 1 AND 255),
    event_type   text        NOT NULL,
    processed_at timestamptz NOT NULL,
    PRIMARY KEY (consumer, event_id)
);

CREATE INDEX inbox_processed_idx ON shared.inbox (processed_at);

-- Consumed events that failed PARK_AFTER_DELIVERIES deliveries in a row, or that cannot be attributed to a tenant (no
-- usable envelope: nothing to store them under). The consumer writes the message here and acknowledges it, so one
-- failing event cannot hold back the rest of its stream; "npm run parked" lists these rows and runs them again through
-- the same handler. The stream sequence identifies a message even when its body is not JSON.
CREATE TABLE shared.parked_events (
    consumer        text        NOT NULL CONSTRAINT parked_events_consumer_length CHECK (char_length(consumer) BETWEEN 1 AND 100),
    stream_sequence bigint      NOT NULL CONSTRAINT parked_events_stream_sequence_positive CHECK (stream_sequence >= 1),
    subject         text        NOT NULL,
    -- The raw message body as UTF-8 text.
    payload         text        NOT NULL,
    -- The last error (message and code), never a token.
    reason          text        NOT NULL,
    deliveries      integer     NOT NULL CONSTRAINT parked_events_deliveries_positive CHECK (deliveries >= 1),
    parked_at       timestamptz NOT NULL,
    PRIMARY KEY (consumer, stream_sequence)
);

CREATE INDEX parked_events_parked_idx ON shared.parked_events (parked_at);
