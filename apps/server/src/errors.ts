/**
 * Shared across RunManager and AgentScheduleManager (and their route
 * handlers) so `instanceof` checks work across module boundaries --
 * duplicating these classes per-file would break `instanceof` even with
 * identical code, since it compares prototype identity, not shape.
 */
export class PolicyDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyDeniedError";
  }
}

export class ResourceLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceLimitError";
  }
}
