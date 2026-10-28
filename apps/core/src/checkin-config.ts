import { readFileSync } from "node:fs";
import path from "node:path";

export function checkinCutoff(config: { eveningCheckIn?: { cutoff?: string } }): string {
  const value = config.eveningCheckIn?.cutoff ?? "22:00";
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new Error("eveningCheckIn.cutoff must be HH:mm");
  return value;
}
export const cutoff = checkinCutoff(JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "config.json"), "utf8")));
