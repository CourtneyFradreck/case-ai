import { fid } from "../id.js";
import { byPriority } from "../rules/order.js";
import { daysSince } from "../time.js";
import type { Finding, RepoSnapshot } from "../types.js";
import { itemLabel } from "../labels.js";
import { mergedMatch } from "./done.js";

export interface IntentConfig {
  newRepoDays: number;
  nextStaleDays: number;
  activeRepoDays: number;
  ignoreBranchPrefixes?: string[];
}

// The previous run's NEXT.md state, keyed by repo.
export type IntentHistory = Map<string, { sha: string; openIds: Set<string> }>;

type OkNext = Extract<RepoSnapshot["next"], { status: "ok" }>;

// Settings and milestones an item names: CASE_BRIEF_MODE, features.focusButtons, M2. File names such as
// NEXT.md are places, not steps, so they don't count.
export function subjects(text: string): Set<string> {
  const words = text.match(/[A-Za-z][\w.]*[A-Za-z0-9]/g) ?? [];
  return new Set(words.filter((w) => /^M\d{1,2}$/i.test(w) ||
    (/[._]/.test(w) && w.split(/[._]/).every((part) => part.length >= 2) && !/\.(?:md|json|ts|js|sql|ya?ml|txt)$/i.test(w)))
    .map((w) => w.toLowerCase()));
}

// Items in a section are often steps. An open item waits on the pending item just above it when it is
// marked "after:", or, conservatively, when both name the same setting or milestone ("Run CASE_BRIEF_MODE=command
// for 3 days", then "Switch to CASE_BRIEF_MODE=all"). A done item, or one a merged PR likely finished, blocks nothing.
export function waitsOn(items: { id: string; text: string; section: string | null; after?: boolean }[], pending: (id: string) => boolean): Map<string, string> {
  const waits = new Map<string, string>();
  items.forEach((item, n) => {
    const prev = items[n - 1];
    if (!prev || prev.section !== item.section || !pending(prev.id)) return;
    const shared = [...subjects(item.text)].some((w) => subjects(prev.text).has(w));
    if (item.after || shared) waits.set(item.id, prev.id);
  });
  return waits;
}

// An open item a merged PR likely finished is never suggested. One line asks to tick it off instead;
// CASE stays read-only on NEXT.md.
export function nextItems(s: RepoSnapshot, next: OkNext): Finding[] {
  const finished = new Map(next.items.filter((i) => i.state === "open").map((i) => [i.id, mergedMatch(i.text, s)] as const));
  const waits = waitsOn(next.items, (id) => finished.has(id) && !finished.get(id));
  return next.items.filter((i) => i.state === "open").map((i): Finding => {
    const pr = finished.get(i.id);
    if (pr) return {
      id: fid("next_likely_done", s.repo, i.id),
      rule: "next_likely_done",
      severity: "low",
      repo: s.repo,
      summary: `Looks like "${itemLabel(i.text)}" is done (PR #${pr.number} merged). Tick it off in NEXT.md?`,
      sources: [{ label: "PR", url: pr.url }, { label: "NEXT.md", url: `${next.url}#L${i.line}` }],
      intent: { itemId: i.id, section: i.section, state: "open" },
    };
    return {
      id: `next_${i.id}`,
      rule: "next_item",
      severity: "info",
      repo: s.repo,
      summary: `Next in ${s.repo}: ${i.text}`,
      ...(i.section ? { details: [i.section] } : {}),
      sources: [{ label: "NEXT.md", url: `${next.url}#L${i.line}` }],
      intent: { itemId: i.id, section: i.section, state: "open", ...(waits.has(i.id) ? { waitsOn: waits.get(i.id) } : {}) },
    };
  });
}

export function nextDone(s: RepoSnapshot, next: OkNext, history: IntentHistory): Finding[] {
  const prev = history.get(s.repo);
  // An unchanged file can't have finished anything.
  if (!prev || prev.sha === next.sha) return [];
  const current = new Map(next.items.map((i) => [i.id, i]));
  return [...prev.openIds].flatMap((itemId) => {
    const item = current.get(itemId);
    if (item?.state === "open") return [];
    return [{
      id: fid("next_done", s.repo, itemId),
      rule: "next_done",
      severity: "info" as const,
      repo: s.repo,
      summary: `Finished in ${s.repo}: ${item?.text ?? "an item from NEXT.md"}`,
      sources: [{ label: "NEXT.md", url: item ? `${next.url}#L${item.line}` : next.url }],
      intent: { itemId, section: item?.section ?? null, state: "done" as const },
    }];
  });
}

// Fires once per repo: missingReported holds the repos it already fired for.
export function nextMissing(s: RepoSnapshot, now: Date, cfg: IntentConfig, missingReported: Set<string> = new Set()): Finding[] {
  if (s.next.status !== "missing" || missingReported.has(s.repo) || !(daysSince(s.createdAt, now) <= cfg.newRepoDays)) return [];
  return [{
    id: fid("next_missing", s.repo),
    rule: "next_missing",
    severity: "low",
    repo: s.repo,
    summary: `${s.repo} is new and has no NEXT.md yet`,
    sources: [{ label: "repo", url: `https://github.com/${s.repo}` }],
  }];
}

// Days since the newest commit on any tracked branch; Infinity when there is none.
export function lastCommitDays(s: RepoSnapshot, now: Date, cfg: Pick<IntentConfig, "ignoreBranchPrefixes">): number {
  return Math.min(...s.branches
    // The collector leaves lastCommitAt empty when GitHub gives no date; NaN would poison Math.min.
    .filter((b) => b.lastCommitAt && !cfg.ignoreBranchPrefixes?.some((p) => b.name.startsWith(p)))
    .map((b) => daysSince(b.lastCommitAt, now)));
}

export function nextStale(s: RepoSnapshot, next: OkNext, now: Date, cfg: IntentConfig): Finding[] {
  if (next.lastChangedAt === null) return [];
  const days = daysSince(next.lastChangedAt, now);
  if (!(lastCommitDays(s, now, cfg) <= cfg.activeRepoDays) || !(days >= cfg.nextStaleDays)) return [];
  return [{
    id: fid("next_stale", s.repo),
    rule: "next_stale",
    severity: "low",
    repo: s.repo,
    summary: `NEXT.md in ${s.repo} hasn't changed in ${days} days, though you've been committing`,
    sources: [{ label: "NEXT.md", url: next.url }],
    ageDays: days,
  }];
}

export function runIntentRules(snaps: RepoSnapshot[], now: Date, cfg: IntentConfig,
                               history: IntentHistory = new Map(), missingReported: Set<string> = new Set()): Finding[] {
  return snaps.filter((s) => !s.error).flatMap((s) => s.next.status === "ok"
    ? [...nextItems(s, s.next), ...nextDone(s, s.next, history), ...nextStale(s, s.next, now, cfg)]
    : nextMissing(s, now, cfg, missingReported))
    .sort(byPriority);
}
