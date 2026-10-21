import { describe, expect, it } from "vitest";
import { countStreaks, lastScheduledRun, type PastRun } from "../src/streaks.js";

let nextId = 100;
const run = (findingIds: string[], over: Partial<PastRun> = {}): PastRun => ({
  id: nextId--, source: "schedule", status: "ok", windowEnd: new Date(), findingIds, attentionIds: [], ...over,
});

describe("finding streaks", () => {
  it("counts consecutive previous scheduled runs containing each id", () => {
    nextId = 100;
    const runs = [run(["a", "b"]), run(["a", "b"]), run(["a"]), run(["c"])];
    expect(countStreaks(["a", "b", "c", "new"], runs)).toEqual(new Map([["a", 3], ["b", 2], ["c", 0], ["new", 0]]));
  });
  it("stops at a gap", () => {
    nextId = 100;
    expect(countStreaks(["a"], [run(["a"]), run([]), run(["a"]), run(["a"])]).get("a")).toBe(1);
    expect(countStreaks(["a"], [run([]), run(["a"])]).get("a")).toBe(0);
  });
  it("skips command, failed and unfinished runs without breaking the streak", () => {
    nextId = 100;
    const runs = [
      run([], { source: "command" }), run(["a"]), run(["a"], { source: "command" }), run([], { status: "failed" }),
      run(["a"], { status: "partial" }), run([], { status: "running" }), run(["a"]), run([]),
    ];
    expect(countStreaks(["a"], runs).get("a")).toBe(3);
  });
  it("orders runs by id, whatever order they arrive in", () => {
    nextId = 100;
    const runs = [run(["a"]), run([]), run(["a"])].reverse();
    expect(countStreaks(["a"], runs).get("a")).toBe(1);
  });
  it("returns zero for every id with no history", () => {
    expect(countStreaks(["a"], [])).toEqual(new Map([["a", 0]]));
  });
  it("finds the last completed scheduled run", () => {
    nextId = 100;
    const runs = [run([], { source: "command" }), run([], { status: "failed" }), run(["x"]), run(["y"])];
    expect(lastScheduledRun(runs)?.findingIds).toEqual(["x"]);
    expect(lastScheduledRun([run([], { source: "command" })])).toBeUndefined();
  });
});
