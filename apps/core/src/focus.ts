import type { Finding, RepoSnapshot } from "./types.js";
import type { ValidFocus } from "./llm/schema.js";
import { byPriority, daysSince } from "./rules/order.js";
import { datePassed } from "./intent/dates.js";
import { relatesTo } from "./intent/done.js";
import { plural } from "./plural.js";
import { lastCommitDays, type IntentConfig } from "./intent/rules.js";
import { bulletText } from "./recap-text.js";
import type { InlineKeyboardMarkup } from "./telegram.js";
import { esc } from "./render.js";
import { fid } from "./id.js";
import type { Window } from "./time.js";
import { clip, focusLabel } from "./labels.js";

export const MAX_FOCUS = 3;

// One fixed reason per rule, built only from the finding's own fields. Reasons are stored with the
// brief (briefs.focus) and logged, never shown.
function reason(f: Finding): string {
  const days = f.ageDays === undefined ? "" : plural(f.ageDays, "day");
  switch (f.rule) {
    case "failing_ci": return "CI is failing on the default branch";
    case "idle_pr": return days ? `No activity for ${days}` : "No recent activity";
    case "stale_branch": return days ? `Unmerged and untouched for ${days}` : "Unmerged and untouched";
    case "issue_comments": return "New comments are waiting for a reply";
    case "next_item": return `Open in NEXT.md, and ${f.repo.split("/").pop()} has recent commits`;
    default: return f.severity === "high" ? "Marked high priority" : "Needs attention";
  }
}

const text = (f: Finding) => f.rule === "next_item" ? f.summary.replace(`Next in ${f.repo}: `, "") : f.summary;

// A suggestion is an action, starting with a verb, with at most one short fact in brackets.
// It replaces the finding's attention line, so the fact appears once.
export function action(f: Finding): string {
  const repo = f.repo.split("/").pop()!;
  const days = f.ageDays === undefined ? "" : plural(f.ageDays, "day");
  if (f.target) switch (f.rule) {
    case "failing_ci": return `Fix the failing ${f.target} CI in ${repo}`;
    case "idle_pr": return `Review or merge ${f.target} in ${repo}${days ? ` (quiet ${days})` : ""}`;
    case "stale_branch": return `Merge or close ${f.target} in ${repo}${days ? ` (idle ${days})` : ""}`;
    case "issue_comments": return `Reply to the comments on ${f.target} in ${repo}`;
  }
  if (f.rule === "open_issues") return `Triage the open issues in ${repo}`;
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

// Focus suggestions without the model: high findings, then medium, then open NEXT.md
// items from repos with commits in the last activeRepoDays (most recently active first),
// with overdue items after the rest.
export function ruleFocus(findings: Finding[], next: Finding[], snaps: RepoSnapshot[], now: Date,
                          cfg: Pick<IntentConfig, "activeRepoDays" | "ignoreBranchPrefixes">, focusFindingId?: string | null): ValidFocus[] {
  const attention = findings.filter((f) => f.severity === "high" || f.severity === "medium").sort(byPriority);
  const active = new Map(snaps.filter((s) => !s.error).map((s) => [s.repo, lastCommitDays(s, now, cfg)] as const)
    .filter(([, days]) => days <= cfg.activeRepoDays));
  const late = new Set(next.filter((f) => overdue(f, snaps, now, cfg, focusFindingId)).map((f) => f.id));
  const planned = next.filter((f) => f.rule === "next_item" && active.has(f.repo))
    // Stable sort keeps NEXT.md order within a repo.
    .sort((a, b) => Number(late.has(a.id)) - Number(late.has(b.id)) || active.get(a.repo)! - active.get(b.repo)!);
  return [...attention, ...planned].slice(0, MAX_FOCUS).map((f) => ({ text: action(f), reason: reason(f), sources: [f] }));
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
// "x" is "Something else"; "ok" is the button left after a choice, which does nothing.
export type FocusCallback = { briefId: number; choice: number | "other" | "chosen" };
const CALLBACK = /^f:(\d{1,15}):([1-9]|x|ok)$/;

export const focusCallbackData = (briefId: number, choice: FocusCallback["choice"]) =>
  `f:${briefId}:${choice === "other" ? "x" : choice === "chosen" ? "ok" : choice}`;

export function parseFocusCallback(data: string | undefined): FocusCallback | undefined {
  const m = CALLBACK.exec(data ?? "");
  if (!m) return;
  const choice = m[2] === "x" ? "other" : m[2] === "ok" ? "chosen" : Number(m[2]);
  return { briefId: Number(m[1]), choice };
}

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

// An info finding for yesterday's focus: what it was and how many commits its repo had over the period,
// on every branch. It leads the recap and is never sent to the model.
export function yesterdayFocus(focus: { item_text: string; short_label?: string | null; repo: string | null; created_at: Date } | undefined, snaps: RepoSnapshot[], period: FocusPeriod): Finding[] {
  if (!focus) return [];
  const snapshot = focus.repo ? snaps.find((s) => s.repo === focus.repo && !s.error) : undefined;
  const base = { id: fid("yesterday_focus", focus.item_text, focus.created_at.toISOString()), rule: "yesterday_focus", severity: "info" as const };
  // Without a readable repo there is nothing to check commits against.
  const name = focus.short_label || focus.item_text;
  if (!snapshot) return [{ ...base, repo: focus.repo ?? "", summary: `Yesterday's focus: ${name}`, sources: [] }];
  const commits = snapshot.commits.filter((c) => new Date(c.date) >= period.since).sort((a, b) => b.date.localeCompare(a.date));
  const repo = snapshot.repo.split("/").pop()!;
  return [{
    ...base,
    repo: snapshot.repo,
    summary: commits.length
      ? `Yesterday's focus: ${name}. ${plural(commits.length, "commit")} in ${repo} ${period.label}`
      : `Yesterday's focus: ${name}. No commits in ${repo} ${period.label}`,
    sources: commits.length ? [{ label: "commit", url: commits[0].url }] : [{ label: "repo", url: `https://github.com/${snapshot.repo}` }],
  }];
}
