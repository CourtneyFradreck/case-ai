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
