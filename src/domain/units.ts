import { DomainError } from "./errors.js";

// Prices and volumes as exact integers in micro-units, the units of trading's events (ADR-055): 1 credit = 1 000 000
// microcredits, prices in microcredits per share (0.01 .. 0.99 credits = 10 000 .. 990 000, steps of 10 000). A YES
// and a NO share together are worth exactly one credit, so the NO price is always 1 000 000 minus the YES price. JSON
// fields that carry micro-units end in `Micro`. No floating point touches a price or a volume.

export const MICROS_PER_UNIT = 1_000_000;

export const PRICE_STEP_MICRO = 10_000;
export const MIN_PRICE_MICRO = 10_000;
export const MAX_PRICE_MICRO = 990_000;

/** The YES price of a market resolved YES (a winning share pays one credit); a market resolved NO has a YES price of 0. */
export const RESOLVED_YES_PRICE_MICRO = MICROS_PER_UNIT;
export const RESOLVED_NO_PRICE_MICRO = 0;

export const SIDES = ["YES", "NO"] as const;
export type Side = (typeof SIDES)[number];

export function isSide(value: unknown): value is Side {
  return value === "YES" || value === "NO";
}

/**
 * The outcome of a resolved market (markets' MarketResolved): a side, or INVALID (UC-16: the question could not be
 * answered and trading refunded the stakes). An INVALID market has no final price (currentPriceYesMicro).
 */
export const OUTCOMES = ["YES", "NO", "INVALID"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export function isOutcome(value: unknown): value is Outcome {
  return isSide(value) || value === "INVALID";
}

/** A non-negative safe integer: a volume or a sum of volumes in microcredits. */
export function isMicroQuantity(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** A price on trading's grid: 10 000 .. 990 000 microcredits per share in steps of 10 000. */
export function isPriceMicro(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= MIN_PRICE_MICRO &&
    value <= MAX_PRICE_MICRO &&
    value % PRICE_STEP_MICRO === 0
  );
}

/**
 * A trade's YES price as trading's contract allows it: an integer from 10 000 to 990 000. Trading's levels are on the
 * grid today, but its TradeExecuted schema does not promise steps of 10 000, so market-data accepts what the publisher's
 * contract accepts and is never stricter than it (a stricter reader would silently lose valid trades).
 */
export function isYesPriceMicro(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= MIN_PRICE_MICRO && value <= MAX_PRICE_MICRO;
}

export function parsePriceMicro(value: unknown, field = "priceMicro"): number {
  if (!isPriceMicro(value)) {
    throw new DomainError("invalid_price", `${field} must be an integer from ${MIN_PRICE_MICRO} to ${MAX_PRICE_MICRO} in steps of ${PRICE_STEP_MICRO} (0.01 to 0.99 credits per share)`, field);
  }
  return value;
}

/**
 * markets' `startingPrice` (a number with at most two decimals, 0.01 .. 0.99) as microcredits per share, exactly: the
 * number is rounded to whole cents first, and a value that is not within 1e-6 of a whole cent is refused.
 */
export function decimalPriceToMicro(price: number, field = "startingPrice"): number {
  if (typeof price !== "number" || !Number.isFinite(price)) throw new DomainError("invalid_price", `${field} must be a number`, field);
  const cents = Math.round(price * 100);
  if (Math.abs(price * 100 - cents) > 1e-6) throw new DomainError("invalid_price", `${field} must have at most two decimals`, field);
  return parsePriceMicro(cents * PRICE_STEP_MICRO, field);
}

/** a + b for micro quantities, exact; throws when the sum leaves the safe integer range (a bug or corrupt data). */
export function addMicro(a: number, b: number): number {
  if (!isMicroQuantity(a) || !isMicroQuantity(b)) throw new DomainError("amount_out_of_range", "Volumes must be non-negative safe integers");
  const sum = a + b;
  if (!Number.isSafeInteger(sum)) throw new DomainError("amount_out_of_range", "A volume sum left the range of exact integers");
  return sum;
}
