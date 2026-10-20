import { fid } from "../id.js";
import { byPriority, daysSince } from "../rules/order.js";
import type { Finding, RepoSnapshot } from "../types.js";

export interface IntentConfig {
  newRepoDays: number;
  nextStaleDays: number;
  activeRepoDays: number;
  ignoreBranchPrefixes?: string[];
}

// The previous run's NEXT.md state, keyed by repo.
export type IntentHistory = Map<string, { sha: string; openIds: Set<string> }>;

type OkNext = Extract<RepoSnapshot["next"], { status: "ok" }>;

export function nextItems(s: RepoSnapshot, next: OkNext): Finding[] {
  return next.items.filter((i) => i.state === "open").map((i) => ({
    id: `next_${i.id}`,
    rule: "next_item",
    severity: "info",
    repo: s.repo,
    summary: `Next in ${s.repo}: ${i.text}`,
    ...(i.section ? { details: [i.section] } : {}),
    sources: [{ label: "NEXT.md", url: `${next.url}#L${i.line}` }],
    intent: { itemId: i.id, section: i.section, state: "open" },
  }));
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

export function nextMissing(s: RepoSnapshot, now: Date, cfg: IntentConfig): Finding[] {
  if (s.next.status !== "missing" || !(daysSince(s.createdAt, now) <= cfg.newRepoDays)) return [];
  return [{
    id: fid("next_missing", s.repo),
    rule: "next_missing",
    severity: "low",
    repo: s.repo,
    summary: `${s.repo} is new and has no NEXT.md yet`,
    sources: [{ label: "repo", url: `https://github.com/${s.repo}` }],
  }];
}

export function nextStale(s: RepoSnapshot, next: OkNext, now: Date, cfg: IntentConfig): Finding[] {
  if (next.lastChangedAt === null) return [];
  const lastCommitDays = Math.min(...s.branches
    .filter((b) => !cfg.ignoreBranchPrefixes?.some((p) => b.name.startsWith(p)))
    .map((b) => daysSince(b.lastCommitAt, now)));
  const days = daysSince(next.lastChangedAt, now);
  if (!(lastCommitDays <= cfg.activeRepoDays) || !(days >= cfg.nextStaleDays)) return [];
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
                               history: IntentHistory = new Map()): Finding[] {
  return snaps.filter((s) => !s.error).flatMap((s) => s.next.status === "ok"
    ? [...nextItems(s, s.next), ...nextDone(s, s.next, history), ...nextStale(s, s.next, now, cfg)]
    : nextMissing(s, now, cfg))
    .sort(byPriority);
}
