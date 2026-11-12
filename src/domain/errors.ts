// Rule violations of the domain. They carry a stable code; the use cases decide what each one means for a caller.
export type DomainErrorCode =
  // Input that breaks a rule of its own (the use cases answer 400).
  | "invalid_market_id"
  | "invalid_tenant_id"
  | "invalid_price"
  | "invalid_interval"
  | "invalid_range"
  | "invalid_sequence"
  // A number left the range of exact integers, or an event would break an invariant of the read model (a trade
  // sequence below 1, a negative volume). Both mean a bug or corrupt data: the transaction is refused, nothing is written.
  | "amount_out_of_range"
  | "invariant_violated";

export class DomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    message: string,
    readonly field?: string,
    /** Machine-readable facts for the caller, for example the largest range a history request may span. */
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
