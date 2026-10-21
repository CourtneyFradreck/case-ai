import { describe, expect, it } from "vitest";
import { FEATURES, features, readFeatures } from "../src/features.js";

const off = { focusButtons: false, snooze: false, streaks: false, quietMornings: false };

describe("feature flags", () => {
  it("treats a missing features object or key as false", () => {
    expect(readFeatures({})).toEqual(off);
    expect(readFeatures({ features: { snooze: true } })).toEqual({ ...off, snooze: true });
  });
  it("only turns a feature on for an explicit true", () => {
    expect(readFeatures({ features: { streaks: "true", quietMornings: 1, focusButtons: null } })).toEqual(off);
  });
  it("ignores unknown keys", () => {
    expect(Object.keys(readFeatures({ features: { unknown: true } }))).toEqual([...FEATURES]);
  });
  it("ships with every feature off", () => {
    expect(features).toEqual(off);
  });
});
