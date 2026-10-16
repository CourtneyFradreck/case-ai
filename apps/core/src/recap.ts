import { DateTime } from "luxon";
import { inWindow, pastWeekWindow, ZONE, type Window } from "./time.js";
import type { RepoSnapshot } from "./types.js";

export function selectRecap(snaps: RepoSnapshot[], now: DateTime = DateTime.now()) {
  const today = now.setZone(ZONE).startOf("day").setLocale("en");
  const history = pastWeekWindow(now);
  const activity = snaps.filter((s) => !s.error).flatMap((s) => [
    ...s.commits.map((c) => c.date),
    ...s.openedPrs.map((p) => p.createdAt),
    ...s.mergedPrs.map((p) => p.mergedAt),
    ...s.newIssues.map((i) => i.createdAt),
    ...s.closedIssues.map((i) => i.closedAt),
  ]).filter((at): at is string => inWindow(at, history));
  const day = (daysAgo: number, label: string, length = 1): Window => ({
    start: today.minus({ days: daysAgo }).toJSDate(),
    end: today.minus({ days: daysAgo - length }).toJSDate(), label,
  });
  const candidates = [
    ...(today.weekday === 1 ? [day(2, "over the weekend", 2)] : []),
    ...Array.from({ length: 7 }, (_, i) => day(i + 1, i === 0 ? "yesterday" : `on ${today.minus({ days: i + 1 }).toFormat("cccc")}`)),
  ];
  // An empty label explicitly means there was no activity in the lookback.
  const window = candidates.find((w) => activity.some((at) => inWindow(at, w))) ?? { ...history, label: "" };
  const hasActivity = !!window.label;
  const snapshots = snaps.map((s) => ({
    ...s,
    commits: s.commits.filter((c) => hasActivity && inWindow(c.date, window)),
    openedPrs: s.openedPrs.filter((p) => hasActivity && inWindow(p.createdAt, window)),
    mergedPrs: s.mergedPrs.filter((p) => hasActivity && inWindow(p.mergedAt, window)),
    newIssues: s.newIssues.filter((i) => hasActivity && inWindow(i.createdAt, window)),
    closedIssues: s.closedIssues.filter((i) => hasActivity && inWindow(i.closedAt, window)),
    // Unanswered comments remain attention findings throughout the lookback.
    // Informational comments are limited to the selected recap by runRules.
  }));
  return { window, snapshots };
}
