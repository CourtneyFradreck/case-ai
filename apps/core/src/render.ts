import type { Finding, RepoSnapshot, Source } from "./types.js";
import { ZONE, type Window } from "./time.js";
import { DateTime } from "luxon";
import type { ValidBrief, ValidItem } from "./llm/schema.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const link = (s: Source) =>
  `<a href="${esc(s.url).replace(/"/g, "&quot;")}">${esc(s.label)}</a>`;

const icon = { high: "🔴", medium: "🟡", low: "⚪", info: "•" } as const;
const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;

function line(f: Finding): string[] {
  const out = [`${icon[f.severity]} ${esc(f.summary)} [${f.sources.map(link).join(", ")}]`];
  for (const d of f.details ?? []) out.push(`   – ${esc(d)}`);
  return out;
}

export interface GreetingOptions { userName?: string; now?: DateTime }

function header(w: Window, options: GreetingOptions): string {
  const hour = (options.now ?? DateTime.now()).setZone(ZONE).hour;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = options.userName?.trim();
  return `<b>${greeting}${name ? `, ${esc(name)}` : ""}. Here's ${esc(w.label)}.</b>`;
}

function finish(parts: string[], snaps: RepoSnapshot[], maxChars: number, footer?: string): string {
  const failed = snaps.filter((s) => s.error);
  if (failed.length) {
    parts.push("", `<i>Couldn't read: ${failed.map((s) => `${esc(s.repo)} (${esc(s.error!)})`).join(", ")}</i>`);
  }
  if (footer) parts.push("", `<i>${esc(footer)}</i>`);
  return truncate(parts, maxChars);
}

export function render(findings: Finding[], snaps: RepoSnapshot[], w: Window, maxChars = 3800, footer?: string, greeting: GreetingOptions = {}): string {
  // Stable sort: keeps the caller's order within a severity (e.g. oldest first from rules)
  const attention = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const yesterday = findings.filter((f) => f.severity === "info");
  const parts: string[] = [header(w, greeting)];

  if (!attention.length && !yesterday.length) {
    parts.push("", "Quiet day: no commits, PRs or issues in your tracked repos, and nothing needs attention.");
  } else {
    if (attention.length) parts.push("", "<b>Needs attention</b>", ...attention.flatMap(line));
    if (yesterday.length) parts.push("", "<b>Yesterday</b>", ...yesterday.flatMap(line));
  }

  return finish(parts, snaps, maxChars, footer);
}

function truncate(parts: string[], maxChars: number): string {
  // Telegram's limit is 4096 characters; keep a margin and say what was cut
  let text = parts.join("\n");
  if (text.length > maxChars) {
    const kept: string[] = [];
    let len = 0;
    for (const p of parts) {
      if (len + p.length + 1 > maxChars - 40) break;
      kept.push(p);
      len += p.length + 1;
    }
    const cut = parts.length - kept.length;
    text = kept.join("\n") + `\n\n<i>+${cut} more line(s) not shown</i>`;
  }
  return text;
}

function modelLinks(item: ValidItem): string {
  const sources = new Map<string, Source>();
  for (const f of item.sources) for (const s of f.sources) {
    if (!sources.has(s.url)) sources.set(s.url, s);
  }
  return `[${[...sources.values()].slice(0, 3).map(link).join(", ")}]`;
}

export function renderModelBrief(brief: ValidBrief, snaps: RepoSnapshot[], w: Window, maxChars = 3800, greeting: GreetingOptions = {}): string {
  const parts = [header(w, greeting)];
  if (brief.yesterday.length) parts.push("", "<b>Yesterday</b>", ...brief.yesterday.map((i) => `- ${esc(i.text)} ${modelLinks(i)}`));
  if (brief.attention.length) parts.push("", "<b>Needs attention</b>", ...brief.attention.map((i) => `- ${esc(i.text)} ${modelLinks(i)}`));
  if (brief.focus.length) parts.push("", "<b>Today, I'd suggest</b>", ...brief.focus.map((i, n) => `${n + 1}. ${esc(i.text)} (${esc(i.reason)}) ${modelLinks(i)}`));
  if (brief.note) parts.push("", `<i>${esc(brief.note)}</i>`);
  return finish(parts, snaps, maxChars);
}
