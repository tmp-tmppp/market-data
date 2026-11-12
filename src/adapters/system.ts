import type { Clock } from "../usecases/ports.js";

/** The wall clock. market-data makes no ids of its own (every id comes from an event), so there is no id generator. */
export const systemClock: Clock = { now: () => new Date() };
