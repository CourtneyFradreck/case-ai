import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { isQuietMorning, quietText } from "../src/quiet.js";
import type { PastRun } from "../src/streaks.js";

// Wed 14 Oct, 07:00 Harare. The previous scheduled brief ran Tue 13 Oct, whose day began 12 Oct 22:00 UTC.
const NOW = DateTime.fromISO("2026-10-14T05:00:00Z");
const TODAY = new Date("2026-10-13T22:00:00Z");
const previous: PastRun = { id: 6, source: "schedule", status: "ok", windowEnd: new Date("2026-10-12T22:00:00Z"), findingIds: ["ci", "pr", "c1"], attentionIds: ["ci", "pr"] };

describe("quiet mornings", () => {
  it("is quiet with the same attention findings, in any order, and no activity since the previous brief's day", () => {
    expect(isQuietMorning(["pr", "ci"], previous, ["2026-10-12T10:00:00Z"], TODAY)).toBe(true);
    expect(isQuietMorning([], { ...previous, attentionIds: [] }, [], TODAY)).toBe(true);
  });
  it("isn't quiet when an attention finding appeared or went away", () => {
    expect(isQuietMorning(["ci", "pr", "new"], previous, [], TODAY)).toBe(false);
    expect(isQuietMorning(["ci"], previous, [], TODAY)).toBe(false);
    expect(isQuietMorning(["ci", "other"], previous, [], TODAY)).toBe(false);
  });
  it("isn't quiet with activity since the previous brief's day began", () => {
    expect(isQuietMorning(["ci", "pr"], previous, ["2026-10-12T22:00:00Z"], TODAY)).toBe(false);
    expect(isQuietMorning(["ci", "pr"], previous, ["2026-10-13T15:00:00Z"], TODAY)).toBe(false);
  });
  it("isn't quiet without a previous scheduled brief", () => {
    expect(isQuietMorning([], undefined, [], TODAY)).toBe(false);
  });
  it("names the last active day and asks about the focus or top item", () => {
    expect(quietText(["2026-10-12T10:00:00Z", "2026-10-09T10:00:00Z"], NOW, "Ship <it>")).toBe("Nothing has moved since Monday. Still on Ship &lt;it&gt;?");
    expect(quietText(["2026-10-13T10:00:00Z"], NOW)).toBe("Nothing has moved since yesterday.");
    expect(quietText([], NOW, "  ")).toBe("Nothing has moved in the past week.");
  });
});
