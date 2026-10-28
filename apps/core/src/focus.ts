import type { Finding, RepoSnapshot } from "./types.js";
import type { ValidFocus } from "./llm/schema.js";
import { byPriority } from "./rules/order.js";
import { datePassed } from "./intent/dates.js";
import { relatesTo } from "./intent/done.js";
import { plural } from "./plural.js";
import { lastCommitDays, type IntentConfig } from "./intent/rules.js";
import { bulletText } from "./recap-text.js";
import type { InlineKeyboardMarkup } from "./telegram.js";
import { esc } from "./render.js";
import { fid } from "./id.js";
import { daysSince, type Window } from "./time.js";
import { clip, focusLabel } from "./labels.js";
import { DateTime } from "luxon";
import { today } from "./time.js";

export const MAX_FOCUS = 3;

// One fixed reason per rule, built only from the finding's own fields. Reasons are stored with the
// brief (briefs.focus) and logged, never shown.
function reason(f: Finding): string {
  switch (f.rule) {
    case "failing_ci": return "CI is failing on the default branch";
    case "issue_comments": return "New comments are waiting for a reply";
    case "next_item": return `Open in NEXT.md, and ${f.repo.split("/").pop()} has recent commits`;
    case "next_missing": return `${f.repo.split("/").pop()} has recent commits and no NEXT.md`;
    default: return f.severity === "high" ? "Marked high priority" : "Needs attention";
  }
}

const text = (f: Finding) => f.rule === "next_item" ? f.summary.replace(`Next in ${f.repo}: `, "") : f.summary;

// A suggestion is an action, starting with a verb, with at most one short fact in brackets.
// It replaces the finding's attention line, so the fact appears once.
export function action(f: Finding): string {
  const repo = f.repo.split("/").pop()!;
  if (f.target) switch (f.rule) {
    case "failing_ci": return `Fix the failing ${f.target} CI in ${repo}`;
    case "issue_comments": return `Reply to the comments on ${f.target} in ${repo}`;
  }
  if (f.rule === "open_issues") return `Triage the open issues in ${repo}`;
  if (f.rule === "next_missing") return `Add a NEXT.md to ${repo} so I can track next steps`;
  return bulletText(text(f));
}

// A NEXT.md item whose date has passed, with nothing recent about it: no commit or recently touched
// branch in its repo relates to it, and it wasn't yesterday's focus.
export function overdue(f: Finding, snaps: RepoSnapshot[], now: Date, cfg: Pick<IntentConfig, "activeRepoDays">, focusFindingId?: string | null): boolean {
  const item = text(f);
  if (!datePassed(item, now) || f.id === focusFindingId) return false;
  const s = snaps.find((x) => x.repo === f.repo && !x.error);
  const recent = !!s && (s.commits.some((c) => relatesTo(item, c.message)) ||
    s.branches.some((b) => b.lastCommitAt && daysSince(b.lastCommitAt, now) <= cfg.activeRepoDays && relatesTo(item, b.name.replace(/[/_-]+/g, " "))));
  return !recent;
}

// Open NEXT.md items in the order to suggest them: overdue ones last, NEXT.md order otherwise.
export const rankNext = (next: Finding[], snaps: RepoSnapshot[], now: Date, cfg: Pick<IntentConfig, "activeRepoDays">, focusFindingId?: string | null) => {
  const late = new Set(next.filter((f) => overdue(f, snaps, now, cfg, focusFindingId)).map((f) => f.id));
  return [...next].sort((a, b) => Number(late.has(a.id)) - Number(late.has(b.id)));
};

// Branches and PRs left open are often kept on purpose. They are never suggested, never sent to the model,
// and the brief names them on one low line at the end (leftOpenLine in render.ts).
const LEFT_OPEN = new Set(["stale_branch", "idle_pr", "old_branches"]);
export const leftOpen = (f: Finding) => LEFT_OPEN.has(f.rule);

// An open NEXT.md item that follows another open one in a sequence waits its turn: only the first is suggested.
export const ready = (f: Finding) => !f.intent?.waitsOn;

// Focus suggestions without the model: active work first, as open NEXT.md items from repos with
// commits in the last activeRepoDays (most recently active first, overdue items after the rest), then
// high and medium findings. Branches and PRs left open are never suggested.
export function ruleFocus(findings: Finding[], next: Finding[], snaps: RepoSnapshot[], now: Date,
                          cfg: Pick<IntentConfig, "activeRepoDays" | "ignoreBranchPrefixes">, focusFindingId?: string | null): ValidFocus[] {
  const attention = findings.filter((f) => (f.severity === "high" || f.severity === "medium") && !leftOpen(f)).sort(byPriority);
  const active = new Map(snaps.filter((s) => !s.error).map((s) => [s.repo, lastCommitDays(s, now, cfg)] as const)
    .filter(([, days]) => days <= cfg.activeRepoDays));
  const late = new Set(next.filter((f) => overdue(f, snaps, now, cfg, focusFindingId)).map((f) => f.id));
  const planned = next.filter((f) => f.rule === "next_item" && ready(f) && active.has(f.repo))
    // Stable sort keeps NEXT.md order within a repo.
    .sort((a, b) => Number(late.has(a.id)) - Number(late.has(b.id)) || active.get(a.repo)! - active.get(b.repo)!);
  return [...planned, ...attention].slice(0, MAX_FOCUS).map((f) => ({ text: action(f), reason: reason(f), sources: [f] }));
}

// An active repo with no NEXT.md takes the last suggestion, on the rule and model paths alike, so it is
// shown rather than left to the model: the most recently active one, one per brief. Written by code.
export function withMissingNext(focus: ValidFocus[], missing: Finding[]): ValidFocus[] {
  const [f] = [...missing].sort((a, b) => (a.ageDays ?? Infinity) - (b.ageDays ?? Infinity) || a.repo.localeCompare(b.repo));
  if (!f) return focus;
  return [...focus.filter((i) => !i.sources.some((x) => x.id === f.id)).slice(0, MAX_FOCUS - 1), { text: action(f), reason: reason(f), sources: [f] }];
}

// What briefs.focus stores per suggestion, in button order. label is missing on briefs stored before it existed.
export interface StoredFocus { text: string; label?: string; reason: string; findingId: string | null; repo: string | null }

export function storedFocus(items: ValidFocus[]): StoredFocus[] {
  return items.map((i) => {
    const f = i.sources[0];
    // old_branches can name several repos; a focus row holds one.
    return { text: bulletText(i.text), label: focusLabel(i.sources, bulletText(i.text), i.label), reason: i.reason, findingId: f?.id ?? null, repo: f && !f.repo.includes(", ") ? f.repo : null };
  });
}

// Callback data stays far below Telegram's 64-byte limit: "f:<briefId>:<n>", never the suggestion text.
// "x" is "Something else"; "ok" is the button left after a choice, which opens Done / Snooze / Change
// ("d", "z", "c").
export type FocusCallback = { briefId: number; choice: number | FocusAction };
type FocusAction = "other" | "chosen" | "done" | "snooze" | "change";
const CODES: Record<FocusAction, string> = { other: "x", chosen: "ok", done: "d", snooze: "z", change: "c" };
const ACTIONS = Object.fromEntries(Object.entries(CODES).map(([action, code]) => [code, action])) as Record<string, FocusAction>;
const CALLBACK = /^f:(\d{1,15}):([1-9]|x|ok|d|z|c)$/;

export const focusCallbackData = (briefId: number, choice: FocusCallback["choice"]) =>
  `f:${briefId}:${typeof choice === "number" ? choice : CODES[choice]}`;

export function parseFocusCallback(data: string | undefined): FocusCallback | undefined {
  const m = CALLBACK.exec(data ?? "");
  if (!m) return;
  return { briefId: Number(m[1]), choice: ACTIONS[m[2]] ?? Number(m[2]) };
}

// What the chosen button opens.
export function focusMenu(briefId: number): InlineKeyboardMarkup {
  return { inline_keyboard: [[
    { text: "✅ Done", callback_data: focusCallbackData(briefId, "done") },
    { text: "💤 Snooze", callback_data: focusCallbackData(briefId, "snooze") },
    { text: "🔄 Change", callback_data: focusCallbackData(briefId, "change") },
  ]] };
}

// After Done the button says so, and still opens the menu.
export const doneKeyboard = (briefId: number, label: string): InlineKeyboardMarkup =>
  ({ inline_keyboard: [[{ text: `☑️ Done: ${clip(label)}`, callback_data: focusCallbackData(briefId, "chosen") }]] });

// A snoozed focus stays out of suggestions for this many days.
export const FOCUS_SNOOZE_DAYS = 3;

// The short reply to a focus being set.
export const focusAck = (label: string) => `Got it, ${esc(label)} today. I'll check in tomorrow.`;

export function focusKeyboard(briefId: number, count: number): InlineKeyboardMarkup {
  return { inline_keyboard: [
    Array.from({ length: count }, (_, n) => ({ text: String(n + 1), callback_data: focusCallbackData(briefId, n + 1) })),
    [{ text: "Something else", callback_data: focusCallbackData(briefId, "other") }],
  ] };
}

// Focus text typed by the user is untrusted: one line, bounded, escaped when shown.
export const MAX_FOCUS_TEXT = 200;
export const cleanFocusText = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, MAX_FOCUS_TEXT);

// "/focus@case_bot ship it" → { name: "focus", arg: "ship it" }.
export function parseCommand(text: string): { name: string; arg: string } | undefined {
  const m = /^\/([a-z]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  return m ? { name: m[1].toLowerCase(), arg: (m[2] ?? "").trim() } : undefined;
}

// After a choice the keyboard shrinks to one button naming it by its short label, which Telegram shows in full.
export function chosenKeyboard(briefId: number, label: string): InlineKeyboardMarkup {
  return { inline_keyboard: [[{ text: `✅ Focus: ${clip(label)}`, callback_data: focusCallbackData(briefId, "chosen") }]] };
}

// A stored suggestion's label, or one made from its text on briefs stored before labels existed.
export const storedLabel = (item: StoredFocus) => item.label ?? clip(item.text);

const MAX_NEXT_CHARS = 3800;

// The /next reply: open NEXT.md items grouped by repo, for one repo (full name or short name) or all tracked repos.
export function nextItemsText(rows: { repo: string; text: string; section: string | null }[], tracked: string[], repo?: string): string {
  const wanted = repo?.trim().toLowerCase();
  const repos = tracked.filter((r) => !wanted || r.toLowerCase() === wanted || r.split("/").pop()!.toLowerCase() === wanted);
  if (wanted && !repos.length) return `${esc(repo!.trim())} isn't a tracked repo.`;
  const groups = repos.map((r) => [r, rows.filter((i) => i.repo === r)] as const).filter(([, items]) => items.length);
  if (!groups.length) return repos.length === 1 ? `No open NEXT.md items in ${esc(repos[0])}.` : "No open NEXT.md items.";
  const lines = ["<b>Open NEXT.md items</b>"];
  for (const [r, items] of groups) {
    lines.push("", `<b>${esc(r.split("/").pop()!)}</b>`, ...items.map((i) => `• ${esc(i.text)}${i.section ? ` <i>(${esc(i.section)})</i>` : ""}`));
  }
  let text = lines.join("\n");
  if (text.length > MAX_NEXT_CHARS) {
    let kept = 0;
    let len = 0;
    while (kept < lines.length && len + lines[kept].length + 1 <= MAX_NEXT_CHARS - 40) len += lines[kept++].length + 1;
    text = `${lines.slice(0, kept).join("\n")}\n\n<i>+${lines.length - kept} more line(s) not shown</i>`;
  }
  return text;
}

// The period yesterday's focus line counts commits over: since the previous brief (or the last 24 hours
// without one), widened to the recap's start so the line always counts every commit the recap shows.
export interface FocusPeriod { since: Date; label: string }
export function focusPeriod(previousBriefAt: Date | undefined, recap: Window, now: Date): FocusPeriod {
  const since = previousBriefAt ?? new Date(now.getTime() - 86_400_000);
  if (recap.label && recap.start < since) return { since: recap.start, label: recap.label };
  return { since, label: previousBriefAt ? "since the last brief" : "in the last day" };
}

// Stored focus text is a snapshot of the day it was picked: its "idle 8 days" is a day out of date by the
// next brief. "Merge or close feat/x (idle 8 days)" → "Merge or close feat/x".
export const withoutAge = (text: string) => text
  .replace(/\s*\((?:idle|quiet|untouched|no activity)(?: for)? \d+ days?\)/gi, "")
  .replace(/,?\s*(?:untouched|idle|quiet|no activity) for \d+ days?/gi, "")
  .trim();

// An info finding for yesterday's focus: the one the user picked (by button, typed or /focus; the line is never
// inferred), and how many commits its repo had over the period, on every branch. When none landed there, it says
// which repo the commits went to. It leads the recap and is never sent to the model.
export function yesterdayFocus(focus: { item_text: string; short_label?: string | null; repo: string | null; created_at: Date; status?: string; checkin?: "done" | "partly" | "none" | null } | undefined, snaps: RepoSnapshot[], period: FocusPeriod, date?: string): Finding[] {
  if (!focus) return [];
  if (focus.checkin) return [{
    id: fid("checkin", date ?? today(DateTime.fromJSDate(focus.created_at))), rule: "self_checkin", severity: "info", repo: focus.repo ?? "",
    summary: `You picked: ${withoutAge(focus.short_label || focus.item_text)}, ${{ done: "done", partly: "partly done", none: "didn't get to it" }[focus.checkin]}`, sources: [{ label: "you", kind: "self_reported" }],
  }];
  const snapshot = focus.repo ? snaps.find((s) => s.repo === focus.repo && !s.error) : undefined;
  const base = { id: fid("yesterday_focus", focus.item_text, focus.created_at.toISOString()), rule: "yesterday_focus", severity: "info" as const };
  // Without a readable repo there is nothing to check commits against.
  const name = `${withoutAge(focus.short_label || focus.item_text)}${focus.status === "done" ? ", marked done" : ""}`;
  if (!snapshot) return [{ ...base, repo: focus.repo ?? "", summary: `You picked: ${name}`, sources: [] }];
  const since = (s: RepoSnapshot) => s.commits.filter((c) => new Date(c.date) >= period.since).sort((a, b) => b.date.localeCompare(a.date));
  const commits = since(snapshot);
  const repo = snapshot.repo.split("/").pop()!;
  if (commits.length) return [{
    ...base, repo: snapshot.repo,
    summary: `You picked: ${name}. ${plural(commits.length, "commit")} in ${repo} ${period.label}`,
    sources: [{ label: "commit", url: commits[0].url }],
  }];
  // Where the work went instead: the repo with the most commits over the period.
  const [busiest] = snaps.filter((s) => !s.error && s.repo !== snapshot.repo).map((s) => ({ s, commits: since(s) }))
    .filter((r) => r.commits.length).sort((a, b) => b.commits.length - a.commits.length || a.s.repo.localeCompare(b.s.repo));
  if (busiest) return [{
    ...base, repo: snapshot.repo,
    summary: `You picked: ${name}, but the commits went to ${busiest.s.repo.split("/").pop()} (${plural(busiest.commits.length, "commit")} ${period.label})`,
    sources: [{ label: "commit", url: busiest.commits[0].url }],
  }];
  return [{
    ...base, repo: snapshot.repo,
    summary: `You picked: ${name}. No commits in ${repo} ${period.label}`,
    sources: [{ label: "repo", url: `https://github.com/${snapshot.repo}` }],
  }];
}
