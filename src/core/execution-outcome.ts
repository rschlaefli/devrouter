export type ExecutionOutcomeStatus = "completed" | "not-started" | "completion-unknown";

export interface ExecutionTransport {
  exitCode: number | null;
  signal: string | null;
}

export interface ExecutionOutcome {
  status: ExecutionOutcomeStatus;
  exitCode: number | null;
  transport: ExecutionTransport;
}

export class ExecutionOutcomeError extends Error {
  readonly outcome: ExecutionOutcome;

  constructor(message: string, outcome: ExecutionOutcome) {
    super(message);
    this.name = "ExecutionOutcomeError";
    this.outcome = outcome;
  }
}

export function unwrapExecutionOutcome(outcome: ExecutionOutcome, message?: string): number {
  if (outcome.status === "completed" && outcome.exitCode !== null) {
    return outcome.exitCode;
  }

  throw new ExecutionOutcomeError(
    message ??
      (outcome.status === "not-started"
        ? "Execution did not start."
        : "Execution completion is unknown."),
    outcome,
  );
}
