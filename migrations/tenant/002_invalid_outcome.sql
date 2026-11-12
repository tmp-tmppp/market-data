-- UC-16: markets' MarketResolved may carry the outcome INVALID (the question could not be answered; trading refunded
-- every stake). The summary keeps it like YES and NO; an INVALID market has no final price, so the read side shows its
-- last price (else the starting price; src/domain/projection.ts, currentPriceYesMicro). Only the list of allowed values
-- grows: the constraint keeps its name and every stored row passes the new check. The check is on the table, so it holds
-- for every projection version (the live one and a replay's build alike).
ALTER TABLE market_summaries DROP CONSTRAINT market_summaries_outcome_values;
ALTER TABLE market_summaries ADD CONSTRAINT market_summaries_outcome_values CHECK (outcome IN ('YES', 'NO', 'INVALID'));
