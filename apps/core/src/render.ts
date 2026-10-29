import type { ActivityLog } from "./logs.js";
import type { Finding, RepoSnapshot, Source } from "./types.js";
import { ZONE, type Window } from "./time.js";
import { DateTime } from "luxon";
import type { ValidBrief, ValidFocus, ValidItem } from "./llm/schema.js";
import { deduplicateFindings, focusOnly, organizeBrief } from "./sections.js";
import { activityAmount, bulletText, recapKind, recapText, withoutRepeatedAside } from "./recap-text.js";
import { closingLine } from "./llm/closing.js";
import { shortLabel } from "./streaks.js";
import { plural } from "./plural.js";

export const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const link = (s: Source) =>
  s.kind === "self_reported" ? esc(s.label) : `<a href="${esc(s.url).replace(/"/g, "&quot;")}">${esc(s.label)}</a>`;

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
// done (features.focusButtons): NEXT.md items a merged PR likely finished, one line each at the end of attention.
// leftOpen: stale branches, idle PRs and old branches, kept open on purpose: one low line at the end of the brief.
export interface GreetingOptions {
  logs?: ActivityLog[];
  userName?: string; now?: DateTime; focus?: boolean; previousFocus?: Finding[];
  collapsed?: Finding[]; days?: Map<string, number>; done?: Finding[]; leftOpen?: Finding[];
  newRepos?: NewRepo[];
  collapsePrs?: boolean;  // a repo with more than MAX_PR_LINES merged PRs gets one summary line (rule-built recap only)
}

// A repo read for the first time, announced once at the end of the brief.
export interface NewRepo { repo: string; hasNext: boolean }
export const newRepoText = (repo: string) => `New repo picked up: ${esc(repo.split("/").pop()!)}`;

function newRepoLines(repos: NewRepo[] = []): string[] {
  if (!repos.length) return [];
  return ["", ...repos.flatMap((r) => [newRepoText(r.repo), ...(r.hasNext ? [] : [`${esc(r.repo.split("/").pop()!)} has no NEXT.md yet`])])];
}

const dayTag = (findings: Finding[], days?: Map<string, number>) => {
  const n = Math.max(0, ...findings.map((f) => days?.get(f.id) ?? 0));
  return n ? ` (day ${n})` : "";
};

const MAX_COLLAPSED_NAMES = 5;

function collapsedLine(findings: Finding[] = []): string[] {
  if (!findings.length) return [];
  const names = findings.slice(0, MAX_COLLAPSED_NAMES).map((f) => f.sources[0] ? link({ ...f.sources[0], label: shortLabel(f) }) : esc(shortLabel(f)));
  const more = findings.length - names.length;
  return [`⚪ Still open, unchanged: ${plural(findings.length, "item")} (${names.join(", ")}${more ? `, and ${more} more` : ""})`];
}

// Branches and PRs left open, on one line below everything else, so it's the first cut and never outranks
// active work. Each is named once, with its link. Written by code on both paths; never sent to the model.
function leftOpenLine(findings: Finding[] = []): string[] {
  if (!findings.length) return [];
  const names = findings.slice(0, MAX_COLLAPSED_NAMES).map((f) => {
    if (f.rule === "old_branches") return line(f)[0].replace(/^\S+ /, "");
    // shortLabel already names the repo: "idle PR #4 in demo".
    const label = f.target ? `${f.target} in ${f.repo.split("/").pop()}` : shortLabel(f);
    const what = f.sources[0] ? link({ ...f.sources[0], label }) : esc(label);
    return `${what}${f.ageDays === undefined ? "" : ` (${f.rule === "idle_pr" ? "quiet" : "idle"} ${plural(f.ageDays, "day")})`}`;
  });
  const more = findings.length - names.length;
  return ["", `${icon.low} Left open: ${names.join("; ")}${more ? `; and ${more} more` : ""}`];
}

export const MAX_PR_LINES = 3;
const isMerge = (f: Finding) => f.activity?.kind === "pr" && f.activity.action === "Merged";

// "Phases 0–4" or "Phases 1, 3 and 5" when PR titles number their steps; nothing otherwise.
// Only the step word most titles use counts: "Phase 2: build step 7" is phase 2.
export function prSteps(titles: string[]): string | undefined {
  const found = titles.flatMap((t) => [...t.matchAll(/\b(phase|stage|step|part|milestone)s?\s*#?(\d+)\b/gi)]
    .map((m) => ({ word: m[1].toLowerCase(), title: t, n: Number(m[2]) })));
  const titlesWith = (word: string) => new Set(found.filter((f) => f.word === word).map((f) => f.title)).size;
  const [top] = [...new Set(found.map((f) => f.word))].sort((a, b) => titlesWith(b) - titlesWith(a));
  const nums = [...new Set(found.filter((f) => f.word === top).map((f) => f.n))].sort((a, b) => a - b);
  if (nums.length < 2) return;
  const word = top.charAt(0).toUpperCase() + top.slice(1);
  const contiguous = nums.every((n, i) => !i || n === nums[i - 1] + 1);
  return `${word}s ${contiguous ? `${nums[0]}–${nums.at(-1)}` : `${nums.slice(0, -1).join(", ")} and ${nums.at(-1)}`}`;
}

// One line for a busy repo's merged PRs, linking to its merged PR list: "7 PRs merged (#2–#8), covering Phases 0–4."
function prSummary(repo: string, merges: Finding[]): string {
  const nums = merges.map((f) => f.activity?.kind === "pr" ? f.activity.number : 0).sort((a, b) => a - b);
  const steps = prSteps(merges.map((f) => f.activity?.kind === "pr" ? f.activity.title : ""));
  const text = `${nums.length} PRs merged (#${nums[0]}–#${nums.at(-1)})${steps ? `, covering ${steps}` : ""}.`;
  return `• ${esc(text)} [${link({ label: "PRs", url: `https://github.com/${repo}/pulls?q=is%3Apr+is%3Amerged` })}]`;
}

function recapLines(items: ValidItem[], model = false, logs: ActivityLog[] = [], collapsePrs = false): string[] {
  const groups = new Map<string, { amount: number; items: ValidItem[] }>();
  for (const item of items) {
    const f = item.sources[0];
    const group = groups.get(f.repo) ?? { amount: 0, items: [] };
    group.amount += activityAmount(f);
    group.items.push(item);
    groups.set(f.repo, group);
  }
  const logGroups = new Map<string, ActivityLog[]>();
  for (const log of logs) {
    const key = [...groups.keys()].find((r) => r.split("/").pop()!.toLowerCase() === log.tag?.toLowerCase()) ?? log.tag ?? "Other";
    logGroups.set(key, [...(logGroups.get(key) ?? []), log]);
    if (!groups.has(key)) groups.set(key, { amount: 0, items: [] });
  }
  return [...groups].sort(([repoA, a], [repoB, b]) => b.amount - a.amount || repoA.localeCompare(repoB))
    .flatMap(([repo, group]) => {
      const merges = group.items.filter((i) => i.sources.length === 1 && isMerge(i.sources[0]));
      const collapse = collapsePrs && merges.length > MAX_PR_LINES;
      const lines = group.items.sort((a, b) => recapKind(a.sources[0]) - recapKind(b.sources[0]) || activityAmount(b.sources[0]) - activityAmount(a.sources[0]))
        .flatMap((item) => !collapse || !merges.includes(item) ? [`• ${esc(recapText(item.sources[0], model ? item.text : undefined))} ${modelLinks(item)}`]
          : item === merges[0] ? [prSummary(repo, merges.map((i) => i.sources[0]))] : []);
      return ["", `<b>${esc(repo.split("/").pop()!)}</b>`, ...lines, ...(logGroups.get(repo) ?? []).map((log) => `• ${esc(log.text)}`)];
    });
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const count = (n: number, noun: string) => n === 1 ? `one ${noun}` : `${n} ${noun}s`;

const prs = (n: number) => n === 1 ? "a PR" : `${n} PRs`;

// Commits and merged PRs per repo in the recap. Commits that came in through a PR merged in the
// collected window are left out by the collector, so a merge is never also counted as its commits.
export function repoStats(recap: Finding[]) {
  const stats = new Map<string, { commits: Finding[]; merged: number }>();
  const of = (repo: string) => stats.get(repo) ?? stats.set(repo, { commits: [], merged: 0 }).get(repo)!;
  for (const f of recap) {
    if (recapKind(f) === 0) of(f.repo).commits.push(f);
    else if (f.activity?.kind === "pr" && f.activity.action === "Merged") of(f.repo).merged++;
  }
  return [...stats].map(([repo, s]) => ({ repo, commitFindings: s.commits, commits: s.commits.reduce((n, f) => n + activityAmount(f), 0), merged: s.merged }))
    .sort((a, b) => b.commits + b.merged - (a.commits + a.merged) || a.repo.localeCompare(b.repo));
}

// One sentence on the recap period, built from per-repo stats and the log count, naming the repo of each
// count: "Steady day yesterday: 7 PRs merged in 1710, 5 commits in case-ai, and 3 things logged."
// The two busiest repos are named; the rest are summed up. "Big" when the busiest repo had 10 commits or more.
// Nothing when the period had no activity.
export function opening(recap: Finding[], w: Window, logs = 0): string | undefined {
  if (!w.label || (!recap.length && !logs)) return;
  const repos = repoStats(recap);
  const logged = logs ? [`${logs} ${logs === 1 ? "thing" : "things"} logged`] : [];
  // "day yesterday", "weekend", "Friday".
  const when = w.label === "yesterday" ? "day yesterday" : w.label.replace(/^on |^over the /, "");
  if (!repos.length) return logs ? `No commits ${w.label}, but ${logged[0]}.` : `No commits ${w.label}, just PR and issue updates.`;
  const [top, second, ...rest] = repos;
  const part = (s: (typeof repos)[number], counts = count(s.commits, "commit")) =>
    [s.commits ? counts : "", s.merged ? `${prs(s.merged)} merged` : ""].filter(Boolean).join(" plus ");
  const others = [...(second ? [`${part(second)} in ${second.repo.split("/").pop()}`] : []),
    ...(rest.length ? [`activity in ${count(rest.length, "other repo")}`] : []), ...logged];
  if (top.commits >= 10) {
    // The busiest branch: "12 commits on feat/m3-intent", or "16 commits, most on feat/m2-model-brief" when others had some.
    const branch = [...top.commitFindings].sort((a, b) => activityAmount(b) - activityAmount(a))[0].activity;
    const on = branch?.kind !== "commits" ? "" : top.commitFindings.length === 1 ? ` on ${branch.branch}` : `, most on ${branch.branch}`;
    return `Big ${top.repo.split("/").pop()} ${when}: ${list([part(top, `${count(top.commits, "commit")}${on}`), ...others])}.`;
  }
  const size = repos.reduce((n, s) => n + s.commits + s.merged, 0) + logs;
  return `${size >= 3 ? "Steady" : "Quiet"} ${when}: ${list([`${part(top)} in ${top.repo.split("/").pop()}`, ...others])}.`;
}

// "a", "a and b", "a, b, and c".
const list = (items: string[]) => items.length < 3 ? items.join(" and ") : `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;

function header(options: GreetingOptions, recap: Finding[] = [], w?: Window): string[] {
  const today = (options.now ?? DateTime.now()).setZone(ZONE).setLocale("en");
  const hour = today.hour;
  const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const name = options.userName?.trim();
  const line = w && opening(recap, w, options.logs?.length);
  return [`<b>${greeting}${name ? `, ${esc(name)}` : ""}.</b>`, today.toFormat("cccc, d LLL yyyy"), ...(line ? ["", esc(line)] : [])];
}

// Suggestions sit before the recap, so truncation cuts the recap first.
// lead lines open the recap; with no recap they stand alone.
function sections(attention: string[], recap: string[], w: Window, focus: string[] = [], lead: string[] = []): string[] {
  const parts: string[] = [];
  if (attention.length) parts.push("", "<b>Needs attention</b>", ...attention);
  if (focus.length) parts.push("", "<b>Today, I'd suggest</b>", ...focus);
  if (recap.length) parts.push("", `<b>${esc(capital(w.label))}</b>`, ...lead, ...recap);
  else {
    if (lead.length) parts.push("", ...lead);
    if (!w.label || !attention.length) parts.push("", "Nothing new in the past week.");
  }
  return parts;
}

// Written by code on both paths; never sent to the model.
const doneLines = (findings: Finding[] = []) =>
  findings.map((f) => `☑️ ${esc(f.summary)} [${f.sources.map(link).join(", ")}]`);

const leadLines = (findings: Finding[] = []) =>
  findings.map((f) => {
    const links = f.sources.filter((s) => s.kind !== "self_reported");
    return `• ${esc(f.summary)}.${links.length ? ` [${links.map(link).join(", ")}]` : ""}`;
  });

function finish(parts: string[], snaps: RepoSnapshot[], maxChars: number, footer?: string): string {
  // Each error names what failed; branches skipped in readable repos share one short line.
  const failed = snaps.filter((s) => s.error);
  if (failed.length) parts.push("", ...failed.map((s) => `<i>${esc(s.error!)}</i>`));
  const skipped = snaps.filter((s) => !s.error).flatMap((s) => s.warnings ?? []);
  if (skipped.length) parts.push("", `<i>${skipped.map(esc).join("; ")}</i>`);
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

// Numbered to match the focus buttons. Reasons are kept with the brief, not shown.
const focusLines = (items: ValidFocus[], days?: Map<string, number>) =>
  items.map((i, n) => {
    const note = " (partly done yesterday)";
    const partly = i.text.endsWith(note);
    const text = withoutRepeatedAside(bulletText(partly ? i.text.slice(0, -note.length) : i.text));
    return `${n + 1}. ${esc(text + (partly ? note : ""))}${dayTag(i.sources, days)} ${modelLinks(i)}`;
  });

// A finding a suggestion is built on appears there instead of in attention.
export const suggested = (focus: ValidFocus[]) => new Set(focus.flatMap((i) => i.sources.map((f) => f.id)));

export function render(findings: Finding[], snaps: RepoSnapshot[], w: Window, maxChars = 3800, footer?: string, greeting: GreetingOptions = {}, focus: ValidFocus[] = []): string {
  findings = deduplicateFindings(findings.filter((f) => !focusOnly(f)));
  // Stable sort: keeps the caller's order within a severity (e.g. oldest first from rules)
  const cited = suggested(focus);
  const attention = findings
    .filter((f) => f.severity !== "info" && !cited.has(f.id))
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
  const yesterday = findings.filter((f) => f.severity === "info");
  const parts = [...header(greeting, yesterday, w), ...sections([...attention.flatMap((f) => line(f, greeting.days)), ...collapsedLine(greeting.collapsed), ...doneLines(greeting.done)], recapLines(yesterday.map((f) => ({ text: f.summary, sources: [f] })), false, greeting.logs, greeting.collapsePrs), w, focusLines(focus, greeting.days), leadLines(greeting.previousFocus)), ...leftOpenLine(greeting.leftOpen), ...newRepoLines(greeting.newRepos)];

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
    const key = s.url ?? s.kind;
    if (!sources.has(key)) sources.set(key, s);
  }
  return `[${[...sources.values()].slice(0, 3).map(link).join(", ")}]`;
}

export function renderModelBrief(brief: ValidBrief, snaps: RepoSnapshot[], w: Window, maxChars = 3800, greeting: GreetingOptions = {}): string {
  brief = organizeBrief(brief, [...brief.attention, ...brief.yesterday, ...brief.focus].flatMap((i) => i.sources), greeting.focus);
  const modelLine = (i: ValidItem) => {
    if (i.sources.length === 1 && i.sources[0].rule === "old_branches") return line(i.sources[0])[0];
    const severity = [...i.sources].sort((a, b) => rank[a.severity] - rank[b.severity])[0].severity;
    return `${icon[severity]} ${esc(withoutRepeatedAside(bulletText(i.text)))}${dayTag(i.sources, greeting.days)} ${modelLinks(i)}`;
  };
  const parts = [...header(greeting, brief.yesterday.flatMap((i) => i.sources), w), ...sections([...brief.attention.map(modelLine), ...collapsedLine(greeting.collapsed), ...doneLines(greeting.done)], recapLines(brief.yesterday, true, greeting.logs), w, focusLines(brief.focus, greeting.days), leadLines(greeting.previousFocus)), ...leftOpenLine(greeting.leftOpen), ...newRepoLines(greeting.newRepos)];
  const note = closingLine(brief.note, brief.noteSources);
  if (note) parts.push("", `<i>${esc(note)}</i>`);
  return finish(parts, snaps, maxChars);
}
