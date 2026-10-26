import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { parseSnoozeCallback, snoozable, snoozedText, snoozeList, snoozeUntil, withoutSnoozed } from "../src/snooze.js";
import { finding } from "./fixtures.js";

const high = finding({ id: "ci", severity: "high", summary: "CI failing" });
const medium = finding({ id: "pr", severity: "medium", summary: 'PR #4 "<Retry>" idle' });
const low = finding({ id: "oi", severity: "low", summary: "3 open issues" });
const info = finding({ id: "commits" });

describe("snooze", () => {
  it("offers only medium and low findings", () => {
    expect(snoozable([high, medium, info, low])).toEqual([
      { findingId: "pr", repo: "me/demo", text: 'PR #4 "<Retry>" idle' },
      { findingId: "oi", repo: "me/demo", text: "3 open issues" },
    ]);
  });
  it("hides snoozed findings but never a high one", () => {
    expect(withoutSnoozed([high, medium, low, info], new Set(["ci", "pr"]))).toEqual([high, low, info]);
  });
  it.each([
    ["s:70", { briefId: 70 }],
    ["s:70:2:3", { briefId: 70, item: 2, days: 3 }],
    ["s:70:10:7", { briefId: 70, item: 10, days: 7 }],
  ])("parses %s", (data, expected) => expect(parseSnoozeCallback(data)).toEqual(expected));
  it.each([undefined, "s:", "s:70:1", "s:70:0:3", "s:70:1:5", "s:70:1:3:x", "f:70:1"])("rejects %s", (data) => {
    expect(parseSnoozeCallback(data)).toBeUndefined();
  });
  it("lists items with 3- and 7-day buttons whose data fits Telegram's limit", () => {
    const { text, markup } = snoozeList(999_999_999_999_999, snoozable([medium, low]));
    expect(text).toBe('<b>Snooze which item?</b>\n1. PR #4 "&lt;Retry&gt;" idle\n2. 3 open issues');
    expect(markup.inline_keyboard).toEqual([
      [{ text: "1: 3 days", callback_data: "s:999999999999999:1:3" }, { text: "1: 7 days", callback_data: "s:999999999999999:1:7" }],
      [{ text: "2: 3 days", callback_data: "s:999999999999999:2:3" }, { text: "2: 7 days", callback_data: "s:999999999999999:2:7" }],
    ]);
    for (const b of markup.inline_keyboard.flat()) expect(Buffer.byteLength(b.callback_data)).toBeLessThanOrEqual(64);
  });
  it("snoozes through the next N briefs, back at midnight Harare after them", () => {
    const wed = DateTime.fromISO("2026-10-14T05:00:00Z");
    expect(snoozeUntil(wed, 3)).toEqual(new Date("2026-10-17T22:00:00Z"));
    expect(snoozeUntil(DateTime.fromISO("2026-10-14T21:59:00Z"), 7)).toEqual(new Date("2026-10-21T22:00:00Z"));
  });
  it("lists active snoozes, numbered for /unsnooze", () => {
    expect(snoozedText([])).toBe("Nothing is snoozed.");
    expect(snoozedText([
      { finding_id: "pr", summary: 'PR #4 "<Retry>" idle', until: new Date("2026-10-17T22:00:00Z") },
      { finding_id: "gone", summary: null, until: new Date("2026-10-21T22:00:00Z") },
    ])).toBe('<b>Snoozed</b>\n1. PR #4 "&lt;Retry&gt;" idle (back Sun 18 Oct)\n2. gone (back Thu 22 Oct)\n\nSend /unsnooze followed by a number to bring one back.');
  });
});
