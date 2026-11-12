-- Tables of one tenant (plan sections 6.3 and 9). This file is applied once to every tenant schema, with the schema as
-- the only entry of the search path: the names below are therefore not qualified. A tenant schema holds nothing that
-- belongs to another tenant, so a forgotten tenant filter cannot reach another tenant's rows (DM-01).
-- Prices are microcredits per share of YES (1 credit = 10^6 microcredits, ADR-055): 10 000 .. 990 000, the opening
-- price on the two-decimal grid of markets' startingPrice, a trade's price any integer of the range (trading's contract
-- has no grid). Volumes are microcredits in bigint columns. Constraints are the last guard (DM-10): the domain refuses
-- the same things first, and a bug in a use case stops here instead of corrupting a summary.

-- Projection versions (DM-09, ADR-032, Proposed ADR-058). One row per version of the read model (market_summaries and
-- price_points together): exactly one is "active" (every read uses it), at most one is "building" (a replay is filling
-- it and the live consumer writes it too), the rest are "retired" (their rows are deleted, the checkpoint stays as
-- history). Version 1 exists from the start and is filled live.
CREATE TABLE projection_checkpoints (
    version             integer     PRIMARY KEY CONSTRAINT projection_checkpoints_version_positive CHECK (version >= 1),
    state               text        NOT NULL CONSTRAINT projection_checkpoints_state_values CHECK (state IN ('building', 'active', 'retired')),
    -- A building version's target: max(consumed_events.position) when the replay started, under LOCK consumed_events IN
    -- EXCLUSIVE MODE, so every row up to it was committed then. Null for version 1.
    high_water_position bigint      CONSTRAINT projection_checkpoints_high_water_nonnegative CHECK (high_water_position >= 0),
    -- The position of the last consumed_events row the replay has read into this version (positions have gaps: it is a
    -- position, never a count).
    rebuilt_through     bigint      NOT NULL DEFAULT 0 CONSTRAINT projection_checkpoints_rebuilt_through_nonnegative CHECK (rebuilt_through >= 0),
    -- Stored events of a projected type that the replay's reader could not read; above 0 holds the switch (ADR-058).
    unreadable_events   bigint      NOT NULL DEFAULT 0 CONSTRAINT projection_checkpoints_unreadable_nonnegative CHECK (unreadable_events >= 0),
    created_at          timestamptz NOT NULL,
    activated_at        timestamptz,
    retired_at          timestamptz,
    CONSTRAINT projection_checkpoints_activated_unless_building CHECK ((state = 'building') = (activated_at IS NULL)),
    CONSTRAINT projection_checkpoints_retired_has_time CHECK ((state = 'retired') = (retired_at IS NOT NULL))
);

-- At most one active and at most one building version: two replays that start together share one (the start takes the
-- table lock before it looks, ADR-058), and a read never has two versions to choose from.
CREATE UNIQUE INDEX projection_checkpoints_one_active ON projection_checkpoints ((true)) WHERE state = 'active';
CREATE UNIQUE INDEX projection_checkpoints_one_building ON projection_checkpoints ((true)) WHERE state = 'building';

INSERT INTO projection_checkpoints (version, state, high_water_position, rebuilt_through, unreadable_events, created_at, activated_at)
VALUES (1, 'active', NULL, 0, 0, now(), now());

-- The replay source (DM-09, ADR-032): every consumed message with a usable envelope, projected or not, exactly as it
-- arrived, so a reader that is fixed or extended later recovers what the earlier one could not read. Written in the
-- transaction of the event, never purged, append-only. A message without a usable envelope cannot be attributed to a
-- tenant and is parked in shared.parked_events instead.
CREATE TABLE consumed_events (
    -- Increasing in the order of INSERT, not of commit, and with gaps: a rolled-back transaction and an INSERT ... ON
    -- CONFLICT DO NOTHING of a stored id use values up (ADR-058). The protocol relies only on this: every row at or below
    -- a building version's high water mark was committed when the replay started.
    position    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    event_id    uuid        NOT NULL CONSTRAINT consumed_events_event_id_key UNIQUE,
    -- The CloudEvent type as received; no list of types, so a later version of an event is stored too.
    event_type  text        NOT NULL CONSTRAINT consumed_events_event_type_length CHECK (char_length(event_type) BETWEEN 1 AND 200),
    -- The market of a projection event, else data.marketId when it is a UUID; null for events that name none.
    market_id   uuid,
    -- The whole CloudEvent.
    event       jsonb       NOT NULL CONSTRAINT consumed_events_event_object CHECK (jsonb_typeof(event) = 'object'),
    received_at timestamptz NOT NULL
);

CREATE INDEX consumed_events_market_idx ON consumed_events (market_id, position);

-- Append-only (DM-09): an UPDATE, DELETE or TRUNCATE of the replay source is refused, whatever statement or tool sends
-- it. As in trading's ledger, the single database role "market_data" (DM-01) owns the table, so the trigger protects
-- the code paths and catches a mistake; it is no defence against someone who holds the credentials.
CREATE FUNCTION consumed_events_append_only() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    RAISE EXCEPTION 'consumed_events is append-only: % is refused', TG_OP USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER consumed_events_no_update_delete
    BEFORE UPDATE OR DELETE ON consumed_events
    FOR EACH ROW EXECUTE FUNCTION consumed_events_append_only();

CREATE TRIGGER consumed_events_no_truncate
    BEFORE TRUNCATE ON consumed_events
    FOR EACH STATEMENT EXECUTE FUNCTION consumed_events_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON consumed_events FROM PUBLIC;

-- The summary of one market in one projection version: the list and the detail header (EP-4, plan 6.3). The rules that
-- fill it are pure functions in src/domain/projection.ts and commute, so a replay and the live consumer give the same
-- row whatever the order of the events.
CREATE TABLE market_summaries (
    projection_version       integer     NOT NULL CONSTRAINT market_summaries_version_fkey REFERENCES projection_checkpoints (version),
    market_id                uuid        NOT NULL,
    -- markets' version of the market (DM-04): an event changes the status only when its version is higher. 0 while no
    -- lifecycle event was applied (the market was seen first through a trade).
    market_version           integer     NOT NULL CONSTRAINT market_summaries_market_version_nonnegative CHECK (market_version >= 0),
    status                   text        CONSTRAINT market_summaries_status_values CHECK (status IN ('open', 'closed', 'resolved')),
    -- Counted in code points, as the reader counts them (1..200; char_length counts characters, not bytes or UTF-16 units).
    question                 text        CONSTRAINT market_summaries_question_length CHECK (char_length(question) BETWEEN 1 AND 200),
    close_time               timestamptz,
    -- markets' two-decimal startingPrice in microcredits: 0.01 .. 0.99.
    starting_price_yes_micro integer     CONSTRAINT market_summaries_starting_price_grid CHECK (
                                             starting_price_yes_micro BETWEEN 10000 AND 990000 AND starting_price_yes_micro % 10000 = 0),
    opened_at                timestamptz,
    closed_at                timestamptz,
    resolved_at              timestamptz,
    outcome                  text        CONSTRAINT market_summaries_outcome_values CHECK (outcome IN ('YES', 'NO')),
    -- The YES price of the trade with the highest sequence. Any integer of the range: the grid of trading's levels is not
    -- a promise of its contract, and a consumer is never stricter than the contract of its publisher (ADR-058).
    last_price_yes_micro     integer     CONSTRAINT market_summaries_last_price_range CHECK (last_price_yes_micro BETWEEN 10000 AND 990000),
    last_trade_sequence      bigint      NOT NULL CONSTRAINT market_summaries_last_trade_sequence_nonnegative CHECK (last_trade_sequence >= 0),
    last_trade_at            timestamptz,
    trade_count              bigint      NOT NULL CONSTRAINT market_summaries_trade_count_nonnegative CHECK (trade_count >= 0),
    volume_micro             bigint      NOT NULL CONSTRAINT market_summaries_volume_nonnegative CHECK (volume_micro >= 0),
    -- When the row last changed; comparisons between versions ignore it.
    updated_at               timestamptz NOT NULL,
    PRIMARY KEY (projection_version, market_id),
    -- A status exists exactly after a lifecycle event.
    CONSTRAINT market_summaries_status_matches_version CHECK ((market_version = 0) = (status IS NULL)),
    -- The outcome belongs to the resolved status and to nothing else.
    CONSTRAINT market_summaries_outcome_matches_status CHECK ((outcome IS NOT NULL) = (status IS NOT DISTINCT FROM 'resolved')),
    CONSTRAINT market_summaries_last_price_matches_count CHECK ((trade_count = 0) = (last_price_yes_micro IS NULL)),
    CONSTRAINT market_summaries_last_trade_time_matches_sequence CHECK ((last_trade_sequence = 0) = (last_trade_at IS NULL)),
    -- Distinct trades seen cannot exceed the highest sequence seen (sequences are 1, 2, 3 ... without gaps).
    CONSTRAINT market_summaries_count_within_sequence CHECK (trade_count <= last_trade_sequence),
    -- A market with a question is complete: MarketOpened filled every opening fact together.
    CONSTRAINT market_summaries_opening_facts_together CHECK (
        question IS NULL OR (close_time IS NOT NULL AND starting_price_yes_micro IS NOT NULL AND opened_at IS NOT NULL))
);

-- The list serves listed markets only (question known), newest first by market id (UUIDv7), optionally one status.
CREATE INDEX market_summaries_listed_idx ON market_summaries (projection_version, market_id DESC) WHERE question IS NOT NULL;
CREATE INDEX market_summaries_listed_status_idx ON market_summaries (projection_version, status, market_id DESC) WHERE question IS NOT NULL;

-- The price series (plan 6.3, DM-10): one point per version, market and trade sequence, so a trade delivered twice
-- makes one point. Sequence 0 is the opening point: the series starts at the starting price at openedAt with volume 0.
CREATE TABLE price_points (
    projection_version integer     NOT NULL,
    market_id          uuid        NOT NULL,
    trade_sequence     bigint      NOT NULL CONSTRAINT price_points_sequence_nonnegative CHECK (trade_sequence >= 0),
    time               timestamptz NOT NULL,
    price_yes_micro    integer     NOT NULL CONSTRAINT price_points_price_range CHECK (price_yes_micro BETWEEN 10000 AND 990000),
    volume_micro       bigint      NOT NULL CONSTRAINT price_points_volume_nonnegative CHECK (volume_micro >= 0),
    PRIMARY KEY (projection_version, market_id, trade_sequence),
    CONSTRAINT price_points_opening_has_no_volume CHECK (trade_sequence > 0 OR volume_micro = 0),
    -- Deferred: a point is inserted before the summary of a market that was seen first through a trade, and both are
    -- there at commit.
    CONSTRAINT price_points_summary_fkey FOREIGN KEY (projection_version, market_id)
        REFERENCES market_summaries (projection_version, market_id) DEFERRABLE INITIALLY DEFERRED
);

-- The history reads the points of one market in a time range and the latest point before a time.
CREATE INDEX price_points_time_idx ON price_points (projection_version, market_id, time, trade_sequence);
