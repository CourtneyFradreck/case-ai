import { DateTime } from "luxon";

export const ZONE = "Africa/Harare";

export interface Window { start: Date; end: Date; label: string }

export function yesterdayWindow(now: DateTime = DateTime.now()): Window {
  const today = now.setZone(ZONE).startOf("day");
  const start = today.minus({ days: 1 });
  return {
    start: start.toUTC().toJSDate(),
    end: today.toUTC().toJSDate(),
    label: "yesterday",
  };
}

// Collect completed local days; today's activity belongs in the next brief.
export function pastWeekWindow(now: DateTime = DateTime.now()): Window {
  const today = now.setZone(ZONE).startOf("day");
  return { start: today.minus({ days: 7 }).toJSDate(), end: today.toJSDate(), label: "past week" };
}

// Days since some activity (a branch's last commit, a PR's last update), counted as Harare calendar days:
// a commit at 23:50 is a day old at 00:10. Every "N days" in the brief comes from here, so lines can't disagree.
export function daysSince(iso: string, now: Date): number {
  const day = (d: Date) => DateTime.fromJSDate(d).setZone(ZONE).startOf("day");
  return Math.max(0, Math.round(day(now).diff(day(new Date(iso)), "days").days));
}

export const inWindow =(iso: string | null | undefined, w: Window) =>
  !!iso && new Date(iso) >= w.start && new Date(iso) < w.end;
