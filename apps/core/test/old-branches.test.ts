import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { gateOldBranches, oldBranchesDay } from "../src/old-branches.js";
import { finding } from "./fixtures.js";

// 07:00 Harare: Mon 19 Oct and Thu 22 Oct 2026.
const monday = DateTime.fromISO("2026-10-19T05:00:00Z");
const thursday = DateTime.fromISO("2026-10-22T05:00:00Z");
const old = finding({ id: "old-2", rule: "old_branches", severity: "low", summary: "2 old unmerged branches across attachcv, crc-app (oldest 120 days)" });
const pr = finding({ id: "pr", rule: "idle_pr", severity: "medium" });
const run = (findingIds: string[]) => ({ id: 6, source: "schedule", status: "ok", windowEnd: new Date(), findingIds, attentionIds: findingIds });

describe("old unmerged branches", () => {
  it("are shown weekly on Mondays by default, or every day when configured", () => {
    expect(oldBranchesDay(monday, {})).toBe(true);
    expect(oldBranchesDay(thursday, {})).toBe(false);
    expect(oldBranchesDay(thursday, { oldBranchesShow: "daily" })).toBe(true);
    expect(oldBranchesDay(thursday, { oldBranchesWeekday: 4 })).toBe(true);
  });
  it("stay out of the brief on other days while the same branches were in the last scheduled brief", () => {
    expect(gateOldBranches([pr, old], false, run(["pr", "old-2"]))).toEqual([pr]);
    expect(gateOldBranches([pr, old], true, run(["pr", "old-2"]))).toEqual([pr, old]);
  });
  it("come back as soon as the set of branches changes, or with nothing to compare against", () => {
    expect(gateOldBranches([pr, old], false, run(["pr", "old-1"]))).toEqual([pr, old]);
    expect(gateOldBranches([pr, old], false, undefined)).toEqual([pr, old]);
  });
});
