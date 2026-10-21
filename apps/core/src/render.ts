import type { Finding, RepoSnapshot, Source } from "./types.js";
import { ZONE, type Window } from "./time.js";
import { DateTime } from "luxon";
import type { ValidBrief, ValidFocus, ValidItem } from "./llm/schema.js";
import { deduplicateFindings, focusOnly, organizeBrief } from "./sections.js";
import { activityAmount, bulletText, recapKind, recapText } from "./recap-text.js";
import { closingLine } from "./llm/closing.js";
import { shortLabel } from "./streaks.js";
import { plural } from "./plural.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const link = (s: Source) =>
  `<a href="${esc(s.url).replace(/"/g, "&quot;")}">${esc(s.label)}</a>`;

const icon = { high: "🔴", medium: "🟡", low: "⚪", info: "•" } as const;
const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;

function line(f: Finding, days?: Map<string, number>): string[] {
  if (f.rule === "old_branches") {
    const names = f.sources.map((s) => s.label).join(", ");
    const summary = esc(f.summary).replace(esc(names), () => f.sources.map(link).join(", "));
    return [`${icon[f.severity]} ${summary}`];
  }
  const out = [`${icon[f.severity]} ${esc(f.summary)}${dayTag([f], days)} [${f.sources.map(link).join(", ")}]`];
  for (const d of f.details ?? []) out.push(`   – ${esc(d)}`);
  return out;
}

// focus: features.focusButtons, which keeps focus suggestions apart from attention.
// previousFocus: the yesterday_focus finding, shown at the top of the recap in code on both paths.
// collapsed and days (features.streaks): repeated findings for the "Still open, unchanged" line, and
// how many scheduled runs in a row each repeated high finding has appeared.
export interface GreetingOptions {
  userName?: string; now?: DateTime; focus?: boolean; previousFocus?: Finding[];
  collapsed?: Finding[]; days?: Map<string, number>;
}

const dayTag = (findings: Finding[], days?: Map<string, number>) => {
  const n = Math.max(0, ...findings.map((f) => days?.get(f.id) ?? 0));
  return n ? ` (day ${n})` : "";
};

const MAX_COLLAPSED_NAMES = 5;

function collapsedLine(findings: Finding[] = []): string[] {
  if (!findings.length) return [];
  const names = findings.slice(0, MAX_COLLAPSED_NAMES).map((f) => f.sources[0] ? link({ label: shortLabel(f), url: f.sources[0].url }) : esc(shortLabel(f)));
  const more = findings.length - names.length;
  return [`⚪ Still open, unchanged: ${plural(findings.length, "item")} (${names.join(", ")}${more ? `, and ${more} more` : ""})`];
}

function recapLines(items: ValidItem[], model = false): string[] {
  const groups = new Map<string, { amount: number; items: ValidItem[] }>();
  for (const item of items) {
    const f = item.sources[0];
    const group = groups.get(f.repo) ?? { amount: 0, items: [] };
    group.amount += activityAmount(f);
    group.items.push(item);
    groups.set(f.repo, group);
  }
  return [...groups].sort(([repoA, a], [repoB, b]) => b.amount - a.amount || repoA.localeCompare(repoB))
    .flatMap(([repo, group]) => ["", `<b>${esc(repo.split("/").pop()!)}</b>`,
      ...group.items.sort((a, b) => recapKind(a.sources[0]) - recapKind(b.sources[0]) || activityAmount(b.sources[0]) - activityAmount(a.sources[0]))
        .map((item) => `• ${esc(recapText(item.sources[0], model ? item.text : undefined))} ${modelLinks(item)}`)]);
}

function header(options: GreetingOptions): string[] {
  const today = (options.now ?? DateTime.now()).setZone(ZONE).setLocale("en");
  const hour = today.hour;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = options.userName?.trim();
  return [`<b>${greeting}${name ? `, ${esc(name)}` : ""}. Here's your morning brief.</b>`, today.toFormat("cccc, d LLL yyyy")];
}

// Suggestions sit before the recap, so truncation cuts the recap first.
// lead lines open the recap; with no recap they stand alone.
function sections(attention: string[], recap: string[], w: Window, focus: string[] = [], lead: string[] = []): string[] {
  const parts: string[] = [];
  if (attention.length) parts.push("", "<b>Here's what needs your attention</b>", ...attention);
  if (focus.length) parts.push("", "<b>Today, I'd suggest</b>", ...focus);
  if (recap.length) parts.push("", `<b>Here's what you worked on ${esc(w.label.replace(/^on /, ""))}</b>`, ...lead, ...recap);
  else {
    if (lead.length) parts.push("", ...lead);
    if (!w.label || !attention.length) parts.push("", "Nothing new in the past week.");
  }
  return parts;
}

const leadLines = (findings: Finding[] = []) =>
  findings.map((f) => `• ${esc(f.summary)}.${f.sources.length ? ` [${f.sources.map(link).join(", ")}]` : ""}`);

function finish(parts: string[], snaps: RepoSnapshot[], maxChars: number, footer?: string): string {
  const failed = snaps.filter((s) => s.error);
  if (failed.length) {
    parts.push("", `<i>Couldn't read: ${failed.map((s) => `${esc(s.repo)} (${esc(s.error!)})`).join(", ")}</i>`);
  }
  if (footer) parts.push("", `<i>${esc(footer)}</i>`);
  return truncate(parts.map(codeFilenames), maxChars);
}

// Telegram auto-links "NEXT.md" because .md is a domain. Wrap .md filenames in <code> in escaped
// text, leaving links (whose labels may be "NEXT.md") and existing code untouched.
const MD_FILE = /(?<![\w./-])[\w-]+(?:[./][\w-]+)*\.md(?![\w-]|\.[\w-])/gi;
export const codeFilenames = (html: string) =>
  html.split(/(<a\b[^>]*>[\s\S]*?<\/a>|<code>[\s\S]*?<\/code>|<[^>]+>)/)
    .map((part, i) => i % 2 ? part : part.replace(MD_FILE, (name) => `<code>${name}</code>`))
    .join("");

// Numbered to match the focus buttons.
const focusLines = (items: ValidFocus[]) =>
  items.map((i, n) => `${n + 1}. ${esc(bulletText(i.text))} (${esc(i.reason)}) ${modelLinks(i)}`);

export function render(findings: Finding[], snaps: RepoSnapshot[], w: Window, maxChars = 3800, footer?: string, greeting: GreetingOptions = {}, focus: ValidFocus[] = []): string {
  findings = deduplicateFindings(findings.filter((f) => !focusOnly(f)));
  // Stable sort: keeps the caller's order within a severity (e.g. oldest first from rules)
  const attention = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const yesterday = findings.filter((f) => f.severity === "info");
  const parts = [...header(greeting), ...sections([...attention.flatMap((f) => line(f, greeting.days)), ...collapsedLine(greeting.collapsed)], recapLines(yesterday.map((f) => ({ text: f.summary, sources: [f] }))), w, focusLines(focus), leadLines(greeting.previousFocus))];

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
    // Repo and section headings should not survive without their first item.
    while (kept.length && (!kept.at(-1) || /^<b>.*<\/b>$/.test(kept.at(-1)!))) kept.pop();
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
  brief = organizeBrief(brief, [...brief.attention, ...brief.yesterday, ...brief.focus].flatMap((i) => i.sources), greeting.focus);
  const modelLine = (i: ValidItem) => {
    if (i.sources.length === 1 && i.sources[0].rule === "old_branches") return line(i.sources[0])[0];
    const severity = [...i.sources].sort((a, b) => rank[a.severity] - rank[b.severity])[0].severity;
    return `${icon[severity]} ${esc(bulletText(i.text))}${dayTag(i.sources, greeting.days)} ${modelLinks(i)}`;
  };
  const parts = [...header(greeting), ...sections([...brief.attention.map(modelLine), ...collapsedLine(greeting.collapsed)], recapLines(brief.yesterday, true), w, focusLines(brief.focus), leadLines(greeting.previousFocus))];
  const note = closingLine(brief.note, brief.noteSources);
  if (note) parts.push("", `<i>${esc(note)}</i>`);
  return finish(parts, snaps, maxChars);
}
