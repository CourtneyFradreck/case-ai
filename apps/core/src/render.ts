import type { Finding, RepoSnapshot, Source } from "./types.js";
import { ZONE, type Window } from "./time.js";
import { DateTime } from "luxon";
import type { ValidBrief, ValidItem } from "./llm/schema.js";
import { deduplicateFindings, organizeBrief } from "./sections.js";
import { activityAmount, bulletText, recapKind, recapText } from "./recap-text.js";
import { closingLine } from "./llm/closing.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const link = (s: Source) =>
  `<a href="${esc(s.url).replace(/"/g, "&quot;")}">${esc(s.label)}</a>`;

const icon = { high: "🔴", medium: "🟡", low: "⚪", info: "•" } as const;
const rank = { high: 0, medium: 1, low: 2, info: 3 } as const;

function line(f: Finding): string[] {
  if (f.rule === "old_branches") {
    const names = f.sources.map((s) => s.label).join(", ");
    const summary = esc(f.summary).replace(esc(names), () => f.sources.map(link).join(", "));
    return [`${icon[f.severity]} ${summary}`];
  }
  const out = [`${icon[f.severity]} ${esc(f.summary)} [${f.sources.map(link).join(", ")}]`];
  for (const d of f.details ?? []) out.push(`   – ${esc(d)}`);
  return out;
}

export interface GreetingOptions { userName?: string; now?: DateTime }

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

function sections(attention: string[], recap: string[], w: Window): string[] {
  const parts: string[] = [];
  if (attention.length) parts.push("", "<b>Here's what needs your attention</b>", ...attention);
  if (recap.length) parts.push("", `<b>Here's what you worked on ${esc(w.label.replace(/^on /, ""))}</b>`, ...recap);
  else if (!w.label || !attention.length) parts.push("", "Nothing new in the past week.");
  return parts;
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
  findings = deduplicateFindings(findings);
  // Stable sort: keeps the caller's order within a severity (e.g. oldest first from rules)
  const attention = findings
    .filter((f) => f.severity !== "info")
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const yesterday = findings.filter((f) => f.severity === "info");
  const parts = [...header(greeting), ...sections(attention.flatMap(line), recapLines(yesterday.map((f) => ({ text: f.summary, sources: [f] }))), w)];

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
  brief = organizeBrief(brief, [...brief.attention, ...brief.yesterday, ...brief.focus].flatMap((i) => i.sources));
  const modelLine = (i: ValidItem) => {
    if (i.sources.length === 1 && i.sources[0].rule === "old_branches") return line(i.sources[0])[0];
    const severity = [...i.sources].sort((a, b) => rank[a.severity] - rank[b.severity])[0].severity;
    return `${icon[severity]} ${esc(bulletText(i.text))} ${modelLinks(i)}`;
  };
  const parts = [...header(greeting), ...sections(brief.attention.map(modelLine), recapLines(brief.yesterday, true), w)];
  const note = closingLine(brief.note, brief.noteSources);
  if (note) parts.push("", `<i>${esc(note)}</i>`);
  return finish(parts, snaps, maxChars);
}
