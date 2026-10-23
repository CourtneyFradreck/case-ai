import { describe, expect, it } from "vitest";
import { daysSince } from "../src/time.js";
import { staleBranches } from "../src/rules/index.js";
import { snap } from "./fixtures.js";

const cfg = { idlePrDays: 3, staleBranchDays: 7, oldBranchDays: 60, ciMaxAgeDays: 30, activeRepoDays: 7, ignoreBranchPrefixes: [] };

describe("days since activity", () => {
  it("counts Harare calendar days from the last commit", () => {
    // The taga branch: last commit Wed 14 Oct 07:00 Harare.
    const last = "2026-10-14T05:00:00Z";
    expect(daysSince(last, new Date("2026-10-22T05:00:00Z"))).toBe(8);   // Thu 22 Oct 07:00
    expect(daysSince(last, new Date("2026-10-23T05:00:00Z"))).toBe(9);   // Fri 23 Oct 07:00
    expect(daysSince(last, new Date("2026-10-23T04:59:00Z"))).toBe(9);   // whatever the hour on 23 Oct
  });
  it("turns over at Harare midnight, not 24 hours later or at UTC midnight", () => {
    // 23:50 Harare on 22 Oct is 21:50 UTC; ten minutes past Harare midnight, the commit is a day old.
    expect(daysSince("2026-10-22T21:50:00Z", new Date("2026-10-22T22:10:00Z"))).toBe(1);
    expect(daysSince("2026-10-22T21:50:00Z", new Date("2026-10-22T21:59:59Z"))).toBe(0);
    // 23:30 UTC on 22 Oct is already 01:30 on 23 Oct in Harare: the same local day as a 07:00 brief.
    expect(daysSince("2026-10-22T23:30:00Z", new Date("2026-10-23T05:00:00Z"))).toBe(0);
    expect(daysSince("2026-10-22T21:59:59Z", new Date("2026-10-23T05:00:00Z"))).toBe(1);
  });
  it("never goes negative for a clock a little ahead", () => {
    expect(daysSince("2026-10-23T05:10:00Z", new Date("2026-10-23T05:00:00Z"))).toBe(0);
  });
  it("gives the branch's finding, its suggestion and any later line the same count", () => {
    const branch = { name: "feat/update-product-section", sha: "s", lastCommitAt: "2026-10-14T21:30:00Z", aheadBy: 2, url: "u" };
    // 23:30 Harare on 14 Oct; a 07:00 brief on 23 Oct is 8 calendar days on, though 24-hour periods also say 8.
    const now = new Date("2026-10-23T05:00:00Z");
    const [f] = staleBranches(snap({ branches: [branch] }), now, cfg);
    expect(f.ageDays).toBe(daysSince(branch.lastCommitAt, now));
    expect(f.summary).toContain(`untouched for ${f.ageDays} days`);
  });
});
