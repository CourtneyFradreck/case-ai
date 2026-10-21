import type { Finding, RepoSnapshot } from "./types.js";
import type { ValidFocus } from "./llm/schema.js";
import { byPriority } from "./rules/order.js";
import { plural } from "./plural.js";
import { lastCommitDays, type IntentConfig } from "./intent/rules.js";
import { bulletText } from "./recap-text.js";
import type { InlineKeyboardMarkup } from "./telegram.js";
import { esc } from "./render.js";

export const MAX_FOCUS = 3;

// One fixed reason per rule, built only from the finding's own fields.
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

// Focus suggestions without the model: high findings, then medium, then open NEXT.md
// items from repos with commits in the last activeRepoDays (most recently active first).
export function ruleFocus(findings: Finding[], next: Finding[], snaps: RepoSnapshot[], now: Date,
                          cfg: Pick<IntentConfig, "activeRepoDays" | "ignoreBranchPrefixes">): ValidFocus[] {
  const attention = findings.filter((f) => f.severity === "high" || f.severity === "medium").sort(byPriority);
  const active = new Map(snaps.filter((s) => !s.error).map((s) => [s.repo, lastCommitDays(s, now, cfg)] as const)
    .filter(([, days]) => days <= cfg.activeRepoDays));
  const planned = next.filter((f) => f.rule === "next_item" && active.has(f.repo))
    // Stable sort keeps NEXT.md order within a repo.
    .sort((a, b) => active.get(a.repo)! - active.get(b.repo)!);
  return [...attention, ...planned].slice(0, MAX_FOCUS).map((f) => ({ text: text(f), reason: reason(f), sources: [f] }));
}

// What briefs.focus stores per suggestion, in button order.
export interface StoredFocus { text: string; reason: string; findingId: string | null; repo: string | null }

export function storedFocus(items: ValidFocus[]): StoredFocus[] {
  return items.map((i) => {
    const f = i.sources[0];
    // old_branches can name several repos; a focus row holds one.
    return { text: bulletText(i.text), reason: i.reason, findingId: f?.id ?? null, repo: f && !f.repo.includes(", ") ? f.repo : null };
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

// After a choice the keyboard shrinks to one button naming it. Telegram cuts long button text anyway.
export function chosenKeyboard(briefId: number, text: string): InlineKeyboardMarkup {
  const label = `Focus: ${text}`;
  return { inline_keyboard: [[{ text: label.length > 60 ? `${label.slice(0, 59)}…` : label, callback_data: focusCallbackData(briefId, "chosen") }]] };
}

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
