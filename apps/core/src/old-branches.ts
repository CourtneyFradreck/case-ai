import { DateTime } from "luxon";
import { ZONE } from "./time.js";
import type { Finding } from "./types.js";
import type { PastRun } from "./streaks.js";

// oldBranchesShow: "weekly" (the default) or "daily". oldBranchesWeekday: ISO weekday, 1 (Monday) by default.
export interface OldBranchConfig { oldBranchesShow?: string; oldBranchesWeekday?: number }

// Whether today's brief is one the old-branches line always appears on.
export function oldBranchesDay(now: DateTime, cfg: OldBranchConfig): boolean {
  return cfg.oldBranchesShow === "daily" || now.setZone(ZONE).weekday === (cfg.oldBranchesWeekday ?? 1);
}

// Old unmerged branches are often kept on purpose, so their line appears on the weekly day, or when the
// set of branches has changed since the last scheduled brief (its finding ID is built from the branches).
// The finding is still stored every run, so the comparison holds. No other finding is affected.
export function gateOldBranches<F extends Pick<Finding, "id" | "rule">>(findings: F[], showDay: boolean, last: PastRun | undefined): F[] {
  if (showDay) return findings;
  return findings.filter((f) => f.rule !== "old_branches" || !last || !last.findingIds.includes(f.id));
}
