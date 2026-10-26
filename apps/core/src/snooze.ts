import { DateTime } from "luxon";
import type { Finding } from "./types.js";
import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram.js";
import { esc } from "./render.js";
import { ZONE } from "./time.js";

export const SNOOZE_DAYS = [3, 7] as const;
const MAX_SNOOZABLE = 10;

// What briefs.snoozable stores per item, in list order.
export interface StoredSnoozable { findingId: string; repo: string; text: string }

// Medium and low attention items only: high findings can't be snoozed.
export function snoozable(findings: Finding[]): StoredSnoozable[] {
  return findings.filter((f) => f.severity === "medium" || f.severity === "low").slice(0, MAX_SNOOZABLE)
    .map((f) => ({ findingId: f.id, repo: f.repo, text: f.summary }));
}

// Snoozes hide findings from the brief; a snooze on a finding that is now high is ignored.
export const withoutSnoozed = (findings: Finding[], snoozed: Set<string>) =>
  findings.filter((f) => f.severity === "high" || !snoozed.has(f.id));

// "s:<briefId>" opens the list; "s:<briefId>:<n>:<days>" snoozes item n. Far below Telegram's 64 bytes.
export type SnoozeCallback = { briefId: number } | { briefId: number; item: number; days: number };
const CALLBACK = /^s:(\d{1,15})(?::(\d{1,2}):(\d{1,2}))?$/;

export function parseSnoozeCallback(data: string | undefined): SnoozeCallback | undefined {
  const m = CALLBACK.exec(data ?? "");
  if (!m) return;
  if (m[2] === undefined) return { briefId: Number(m[1]) };
  const item = Number(m[2]);
  const days = Number(m[3]);
  return item >= 1 && (SNOOZE_DAYS as readonly number[]).includes(days) ? { briefId: Number(m[1]), item, days } : undefined;
}

export const snoozeButtonRow = (briefId: number): InlineKeyboardButton[] => [{ text: "Snooze…", callback_data: `s:${briefId}` }];

export function snoozeList(briefId: number, items: StoredSnoozable[]): { text: string; markup: InlineKeyboardMarkup } {
  return {
    text: ["<b>Snooze which item?</b>", ...items.map((i, n) => `${n + 1}. ${esc(i.text)}`)].join("\n"),
    markup: { inline_keyboard: items.map((_, n) => SNOOZE_DAYS.map((d) => ({ text: `${n + 1}: ${d} days`, callback_data: `s:${briefId}:${n + 1}:${d}` }))) },
  };
}

// Snoozing for N days skips the next N briefs: the item is back on the brief N+1 days from today, Harare time.
export const snoozeUntil = (now: DateTime, days: number) => now.setZone(ZONE).startOf("day").plus({ days: days + 1 }).toJSDate();

export const untilText = (until: Date) => DateTime.fromJSDate(until).setZone(ZONE).setLocale("en").toFormat("ccc d LLL");

export function snoozedText(rows: { summary: string | null; finding_id: string; until: Date }[]): string {
  if (!rows.length) return "Nothing is snoozed.";
  return ["<b>Snoozed</b>", ...rows.map((r, n) => `${n + 1}. ${esc(r.summary ?? r.finding_id)} (back ${untilText(r.until)})`),
    "", "Send /unsnooze followed by a number to bring one back."].join("\n");
}
