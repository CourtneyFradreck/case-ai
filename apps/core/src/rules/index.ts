import { createHash } from "node:crypto";
import type { RepoSnapshot, Finding, Severity } from "../types.js";

export interface RuleConfig {
  idlePrDays: number;
  staleBranchDays: number;
  ignoreBranchPrefixes: string[];
}

const fid = (...parts: string[]) =>
  createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 10);

const daysSince = (iso: string, now: Date) =>
  Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);

export function failingCi(s: RepoSnapshot): Finding[] {
  return s.ciRuns
    .filter((r) => ["failure", "timed_out", "startup_failure"].includes(r.conclusion ?? ""))
    .map((r) => ({
      id: fid("failing_ci", s.repo, String(r.workflowId)),
      rule: "failing_ci",
      severity: "high",
      repo: s.repo,
      summary: `CI failing on ${s.repo} ${s.defaultBranch} (${r.workflowName})`,
      sources: [{ label: "run", url: r.url }],
    }));
}

export function idlePrs(s: RepoSnapshot, now: Date, cfg: RuleConfig): Finding[] {
  return s.openPrs.filter((p) => !p.draft).flatMap((p) => {
    const days = daysSince(p.updatedAt, now);
    if (days < cfg.idlePrDays) return [];
    return [{
      id: fid("idle_pr", s.repo, String(p.number)),
      rule: "idle_pr",
      severity: "medium" as Severity,
      repo: s.repo,
      summary: `PR #${p.number} "${p.title}" in ${s.repo}: no activity for ${days} days`,
      sources: [{ label: "PR", url: p.url }],
      ageDays: days,
    }];
  });
}

export function staleBranches(s: RepoSnapshot, now: Date, cfg: RuleConfig): Finding[] {
  const prHeads = new Set(s.openPrs.map((p) => p.headRef));
  return s.branches.flatMap((b) => {
    if (b.name === s.defaultBranch || b.aheadBy === 0) return [];
    if (prHeads.has(b.name)) return [];                        // the idle-PR rule covers it
    if (cfg.ignoreBranchPrefixes.some((p) => b.name.startsWith(p))) return [];
    const days = daysSince(b.lastCommitAt, now);
    if (days < cfg.staleBranchDays) return [];
    return [{
      id: fid("stale_branch", s.repo, b.name),
      rule: "stale_branch",
      severity: "medium" as Severity,
      repo: s.repo,
      summary: `Branch ${b.name} in ${s.repo}: ${b.aheadBy} unmerged commit(s), untouched for ${days} days`,
      sources: [{ label: "branch", url: b.url }],
      ageDays: days,
    }];
  });
}

export function yesterdaysCommits(s: RepoSnapshot): Finding[] {
  const byBranch = new Map<string, typeof s.commits>();
  for (const c of s.commits) byBranch.set(c.branch, [...(byBranch.get(c.branch) ?? []), c]);

  return [...byBranch].map(([branch, commits]) => {
    const sorted = [...commits].sort((a, b) => a.date.localeCompare(b.date));
    const oldest = sorted[0];
    const newest = sorted[sorted.length - 1];
    const url = oldest.parentSha
      ? `https://github.com/${s.repo}/compare/${oldest.parentSha}...${newest.sha}`
      : newest.url;
    return {
      id: fid("commits", s.repo, branch, newest.sha),
      rule: "commits",
      severity: "info" as Severity,
      repo: s.repo,
      summary: `${s.repo}: ${commits.length} commit(s) on ${branch}`,
      details: sorted.slice(-3).map((c) => c.message),
      sources: [{ label: commits.length > 1 ? "diff" : "commit", url }],
    };
  });
}

export function mergedPrs(s: RepoSnapshot): Finding[] {
  return s.mergedPrs.map((p) => ({
    id: fid("merged_pr", s.repo, String(p.number)),
    rule: "merged_pr",
    severity: "info",
    repo: s.repo,
    summary: `Merged PR #${p.number} "${p.title}" in ${s.repo}`,
    sources: [{ label: "PR", url: p.url }],
  }));
}

export function newIssues(s: RepoSnapshot): Finding[] {
  return s.newIssues.map((i) => ({
    id: fid("new_issue", s.repo, String(i.number)),
    rule: "new_issue",
    severity: "info",
    repo: s.repo,
    summary: `New issue #${i.number} "${i.title}" in ${s.repo}`,
    sources: [{ label: "issue", url: i.url }],
  }));
}

const order: Record<Severity, number> = { high: 0, medium: 1, low: 2, info: 3 };

export function runRules(snaps: RepoSnapshot[], now: Date, cfg: RuleConfig): Finding[] {
  return snaps
    .filter((s) => !s.error)
    .flatMap((s) => [
      ...failingCi(s),
      ...idlePrs(s, now, cfg),
      ...staleBranches(s, now, cfg),
      ...yesterdaysCommits(s),
      ...mergedPrs(s),
      ...newIssues(s),
    ])
    .sort((a, b) => order[a.severity] - order[b.severity] || (b.ageDays ?? 0) - (a.ageDays ?? 0));
}