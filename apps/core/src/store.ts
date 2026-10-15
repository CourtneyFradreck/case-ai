import { pool } from "./db.js";
import type { Window } from "./time.js";
import type { RepoSnapshot, Finding } from "./types.js";
import type { BriefMeta } from "./llm/brief.js";

export async function startRun(source: string, w: Window) {
  const { rows } = await pool.query(
    "INSERT INTO runs(source, window_start, window_end) VALUES ($1,$2,$3) RETURNING id",
    [source, w.start, w.end],
  );
  return rows[0].id as number;
}

export async function finishRun(id: number, status: string, error?: string) {
  await pool.query("UPDATE runs SET status=$2, error=$3, finished_at=now() WHERE id=$1", [id, status, error ?? null]);
}

export async function storeSnapshots(runId: number, snaps: RepoSnapshot[]) {
  for (const s of snaps) {
    if (s.error) continue;
    const { rows } = await pool.query(
      `INSERT INTO repos(full_name, default_branch, private) VALUES ($1,$2,$3)
       ON CONFLICT (full_name) DO UPDATE SET default_branch=EXCLUDED.default_branch, private=EXCLUDED.private
       RETURNING id`,
      [s.repo, s.defaultBranch, s.private],
    );
    const repoId = rows[0].id;

    const events = [
      ...s.commits.map((c) => ["commit", c.sha, c.message, c.url, c.date, c] as const),
      ...[...s.openPrs, ...s.mergedPrs].map((p) => ["pr", String(p.number), p.title, p.url, p.mergedAt ?? p.updatedAt, p] as const),
      ...s.newIssues.map((i) => ["issue", String(i.number), i.title, i.url, i.createdAt, i] as const),
      ...s.closedIssues.map((i) => ["issue_closed", String(i.number), i.title, i.url, i.closedAt, i] as const),
      ...s.comments.map((c) => ["issue_comment", String(c.id), c.issueTitle, c.url, c.createdAt, c] as const),
      ...s.branches.map((b) => ["branch", b.name, b.name, b.url, b.lastCommitAt, b] as const),
      ...s.ciRuns.map((r) => ["ci_run", String(r.workflowId), r.workflowName, r.url, r.finishedAt, r] as const),
    ];

    for (const [type, ref, title, url, at, raw] of events) {
      await pool.query(
        `INSERT INTO events(repo_id, type, ref, title, url, occurred_at, raw, last_seen_run)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (repo_id, type, ref) DO UPDATE
           SET title=EXCLUDED.title, url=EXCLUDED.url, occurred_at=EXCLUDED.occurred_at,
               raw=EXCLUDED.raw, last_seen_run=EXCLUDED.last_seen_run`,
        [repoId, type, ref, title, url, at, JSON.stringify(raw), runId],
      );
    }
  }
}

export async function storeFindings(runId: number, findings: Finding[]) {
  for (const f of findings) {
    await pool.query(
      "INSERT INTO findings(run_id, id, rule, severity, repo, summary, sources) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [runId, f.id, f.rule, f.severity, f.repo, f.summary, JSON.stringify(f.sources)],
    );
  }
}

export async function storeBrief(runId: number, text: string, meta?: BriefMeta) {
  if (meta) {
    await pool.query(
      "INSERT INTO briefs(run_id, text, model, input_tokens, output_tokens, json) VALUES ($1,$2,$3,$4,$5,$6)",
      [runId, text, meta.model, meta.inputTokens ?? null, meta.outputTokens ?? null, JSON.stringify(meta.json)],
    );
    return;
  }
  await pool.query("INSERT INTO briefs(run_id, text) VALUES ($1,$2)", [runId, text]);
}
