import type { Finding, Severity } from "../types.js";

const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

// Most severe first, then oldest first within a severity.
export const byPriority = (a: Finding, b: Finding) =>
  order[a.severity] - order[b.severity] || (b.ageDays ?? 0) - (a.ageDays ?? 0);
