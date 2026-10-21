import { DateTime } from "luxon";
import { esc } from "./render.js";
import { ZONE } from "./time.js";
import type { PastRun } from "./streaks.js";

// A quiet morning: the same attention findings as the previous scheduled brief, and no activity since
// that brief's day began (its recap could only cover activity before then).
export function isQuietMorning(attentionIds: string[], previous: PastRun | undefined, activity: string[], todayStart: Date): boolean {
  if (!previous) return false;
  const now = new Set(attentionIds);
  const before = new Set(previous.attentionIds);
  if (now.size !== before.size || [...now].some((id) => !before.has(id))) return false;
  return !activity.some((at) => new Date(at) >= previous.windowEnd && new Date(at) < todayStart);
}

// "Nothing has moved since Friday. Still on <focus or top item>?"
export function quietText(activity: string[], now: DateTime, still?: string): string {
  const latest = activity.map((at) => DateTime.fromISO(at)).sort((a, b) => b.toMillis() - a.toMillis())[0];
  const today = now.setZone(ZONE).startOf("day");
  const day = latest?.setZone(ZONE).setLocale("en");
  const since = !day ? "Nothing has moved in the past week."
    : day.hasSame(today.minus({ days: 1 }), "day") ? "Nothing has moved since yesterday."
    : `Nothing has moved since ${day.toFormat("cccc")}.`;
  return still?.trim() ? `${since} Still on ${esc(still.trim())}?` : since;
}
