// A previous run as the streak and quiet-morning checks see it.
export interface PastRun {
  id: number; source: string; status: string;
  windowEnd: Date;          // midnight Harare of the run's day
  findingIds: string[];
  attentionIds: string[];   // findings other than info
}

// Only completed scheduled runs count. Command, failed and unfinished runs are skipped: they neither extend nor break a streak.
export const countsForStreak = (r: Pick<PastRun, "source" | "status">) =>
  r.source === "schedule" && (r.status === "ok" || r.status === "partial");

// For each id, how many consecutive previous scheduled runs, newest first, contained it.
export function countStreaks(ids: string[], runs: PastRun[]): Map<string, number> {
  const counted = runs.filter(countsForStreak).sort((a, b) => b.id - a.id).map((r) => new Set(r.findingIds));
  return new Map(ids.map((id) => {
    let n = 0;
    while (n < counted.length && counted[n].has(id)) n++;
    return [id, n];
  }));
}

export const lastScheduledRun = (runs: PastRun[]) => runs.filter(countsForStreak).sort((a, b) => b.id - a.id)[0];

const repoName = (repo: string) => repo.split("/").pop()!;

// A few words naming a collapsed finding, read from the fixed start of its rule's summary.
export function shortLabel(f: { rule: string; repo: string; summary: string }): string {
  const name = repoName(f.repo);
  const pr = /^PR #(\d+) "/.exec(f.summary);
  const branch = /^Branch (\S+) in /.exec(f.summary);
  const thread = /^\d+ new comments? on (PR|issue) #(\d+) "/.exec(f.summary);
  if (f.rule === "idle_pr" && pr) return `idle PR #${pr[1]} in ${name}`;
  if (f.rule === "stale_branch" && branch) return `stale branch ${branch[1]} in ${name}`;
  if (f.rule === "issue_comments" && thread) return `comments on ${thread[1]} #${thread[2]} in ${name}`;
  if (f.rule === "open_issues") return `open issues in ${name}`;
  if (f.rule === "old_branches") return "old branches";
  if (f.rule === "failing_ci") return `old CI failure in ${name}`;
  return f.summary.length > 60 ? `${f.summary.slice(0, 59)}…` : f.summary;
}

export interface Collapsed<F> { kept: F[]; collapsed: F[]; days: Map<string, number> }

// Medium and low findings seen in at least `after` consecutive previous scheduled runs move to one collapsed line.
// High findings stay, and instead show which day in a row this is (the streak plus today).
export function collapseRepeats<F extends { id: string; severity: string }>(findings: F[], streaks: Map<string, number>, after: number): Collapsed<F> {
  const repeated = (f: F) => (streaks.get(f.id) ?? 0) >= after;
  return {
    kept: findings.filter((f) => !(repeated(f) && (f.severity === "medium" || f.severity === "low"))),
    collapsed: findings.filter((f) => repeated(f) && (f.severity === "medium" || f.severity === "low")),
    days: new Map(findings.filter((f) => repeated(f) && f.severity === "high").map((f) => [f.id, streaks.get(f.id)! + 1])),
  };
}
