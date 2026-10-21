import { readFileSync } from "node:fs";
import path from "node:path";

export const FEATURES = ["focusButtons", "snooze", "streaks", "quietMornings"] as const;
export type Feature = typeof FEATURES[number];
export type Features = Record<Feature, boolean>;

// Only an explicit true turns a feature on; a missing key or any other value is off.
export function readFeatures(config: { features?: Record<string, unknown> }): Features {
  return Object.fromEntries(FEATURES.map((f) => [f, config.features?.[f] === true])) as Features;
}

export const features: Features = readFeatures(
  JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "config.json"), "utf8")),
);
