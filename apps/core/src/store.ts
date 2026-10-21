import { pool } from "./db.js";
import type { Window } from "./time.js";
import type { RepoSnapshot, Finding } from "./types.js";
import type { BriefMeta } from "./llm/brief.js";
import { followRelinks, relink } from "./intent/relink.js";
import type { IntentHistory } from "./intent/rules.js";
import type { StoredFocus } from "./focus.js";
import type { PastRun } from "./streaks.js";
import type { StoredSnoozable } from "./snooze.js";

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
      ...[...s.openedPrs, ...s.openPrs, ...s.mergedPrs].map((p) => ["pr", String(p.number), p.title, p.url, p.mergedAt ?? p.updatedAt, p] as const),
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

interface NextItemRow {
  item_id: string; text: string; section: string | null; state: "open" | "done"; last_run_id: string | null;
  first_seen: Date; section_changed_at: Date; previous_ids: string[];
}

interface NextFileRow { sha: string | null; run_id: string | null; missing_reported_at: Date | null }

// Upserts the items of every readable NEXT.md. Missing or errored files leave existing rows alone.
// An item whose wording was edited since the last run inherits the old item's history.
// Returns the previous run's state for the intent rules, read before this run overwrites it.
export async function storeNextItems(runId: number, snaps: RepoSnapshot[]) {
  const history: IntentHistory = new Map();
  const missingReported = new Set<string>();
  for (const s of snaps) {
    if (s.error || s.next.status === "error") continue;
    const prev = (await pool.query<NextFileRow>(
      "SELECT sha, run_id, missing_reported_at FROM next_files WHERE repo=$1", [s.repo],
    )).rows[0];
    if (prev?.missing_reported_at) missingReported.add(s.repo);
    await pool.query(
      `INSERT INTO next_files(repo, sha, run_id) VALUES ($1,$2,$3)
       ON CONFLICT (repo) DO UPDATE SET sha=EXCLUDED.sha, run_id=EXCLUDED.run_id`,
      [s.repo, s.next.status === "ok" ? s.next.sha : null, runId],
    );
    if (s.next.status !== "ok") continue;

    const { rows } = await pool.query<NextItemRow>(
      `SELECT item_id, text, section, state, last_run_id, first_seen, section_changed_at, previous_ids
       FROM next_items WHERE repo=$1`,
      [s.repo],
    );
    const known = new Map(rows.map((r) => [r.item_id, r]));
    const current = new Set(s.next.items.map((i) => i.id));
    // bigint comes back as a string; compare numerically.
    const lastRun = prev ? Number(prev.run_id) : Math.max(...rows.map((r) => Number(r.last_run_id ?? 0)));
    const lastSeen = rows.filter((r) => Number(r.last_run_id ?? 0) === lastRun);
    const gone = lastSeen.filter((r) => !current.has(r.item_id)).map((r) => ({ id: r.item_id, text: r.text }));
    const added = s.next.items.filter((i) => !known.has(i.id));
    const from = new Map(relink(gone, added).map((p) => [p.to, known.get(p.from)!]));
    const previousIds = (id: string) => {
      const old = from.get(id);
      return old ? [...old.previous_ids, old.item_id] : known.get(id)?.previous_ids ?? [];
    };

    // A file that was missing last run has nothing to compare against.
    if (prev?.sha) {
      const open = lastSeen.filter((r) => r.state === "open").map((r) => r.item_id);
      history.set(s.repo, { sha: prev.sha, openIds: followRelinks(open, s.next.items.map((i) => ({ id: i.id, previousIds: previousIds(i.id) }))) });
    }

    for (const i of s.next.items) {
      const old = from.get(i.id);
      await pool.query(
        `INSERT INTO next_items(repo, item_id, text, section, state, first_seen, last_seen, section_changed_at, last_run_id, previous_ids)
         VALUES ($1,$2,$3,$4,$5,COALESCE($7,now()),now(),COALESCE($8,now()),$6,$9)
         ON CONFLICT (repo, item_id) DO UPDATE
           SET text=EXCLUDED.text, state=EXCLUDED.state, last_seen=now(), last_run_id=EXCLUDED.last_run_id,
               section_changed_at=CASE WHEN next_items.section IS DISTINCT FROM EXCLUDED.section
                                       THEN now() ELSE next_items.section_changed_at END,
               section=EXCLUDED.section`,
        [s.repo, i.id, i.text, i.section, i.state, runId,
         old?.first_seen ?? null,
         // An edit that also moved the item to another section counts as a section change.
         old && old.section === i.section ? old.section_changed_at : null,
         JSON.stringify(old ? previousIds(i.id) : [])],
      );
    }
  }
  return { history, missingReported };
}

// Records that next_missing fired, so it fires only on the first run that sees the repo without NEXT.md.
export async function markMissingReported(repos: string[]) {
  if (!repos.length) return;
  await pool.query(
    "UPDATE next_files SET missing_reported_at=now() WHERE repo = ANY($1) AND missing_reported_at IS NULL", [repos],
  );
}

export async function storeFindings(runId: number, findings: Finding[]) {
  for (const f of findings) {
    await pool.query(
      "INSERT INTO findings(run_id, id, rule, severity, repo, summary, sources) VALUES ($1,$2,$3,$4,$5,$6,$7)",
      [runId, f.id, f.rule, f.severity, f.repo, f.summary, JSON.stringify(f.sources)],
    );
  }
}

// ruleText is the rule-only render, stored as a baseline whichever brief was sent.
export async function storeBrief(runId: number, text: string, meta: BriefMeta | undefined, ruleText: string) {
  const { rows } = meta
    ? await pool.query(
      "INSERT INTO briefs(run_id, text, model, input_tokens, output_tokens, json, rule_text) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
      [runId, text, meta.model, meta.inputTokens ?? null, meta.outputTokens ?? null, JSON.stringify(meta.json), ruleText],
    )
    : await pool.query("INSERT INTO briefs(run_id, text, rule_text) VALUES ($1,$2,$3) RETURNING id", [runId, text, ruleText]);
  return Number(rows[0].id);
}

export async function storeBriefMessageId(briefId: number, messageId: number) {
  await pool.query("UPDATE briefs SET telegram_message_id=$2 WHERE id=$1", [briefId, messageId]);
}

export async function storeBriefFocus(briefId: number, focus: StoredFocus[]) {
  await pool.query("UPDATE briefs SET focus=$2 WHERE id=$1", [briefId, JSON.stringify(focus)]);
}

export interface BriefFocusRow { focus: StoredFocus[] | null; created_at: Date; telegram_message_id: string | null }

export async function getBriefFocus(briefId: number) {
  const { rows } = await pool.query<BriefFocusRow>(
    "SELECT focus, created_at, telegram_message_id FROM briefs WHERE id=$1", [briefId],
  );
  return rows[0];
}

export interface FocusChoice {
  date: string; text: string; findingId: string | null; repo: string | null;
  via: "button" | "text" | "command"; briefId: number | null;
}

// A later choice on the same date replaces the earlier one; rows are kept as history.
export async function insertFocus(c: FocusChoice) {
  await pool.query(
    "INSERT INTO core.focus(date, item_text, finding_id, repo, chosen_via, brief_id) VALUES ($1,$2,$3,$4,$5,$6)",
    [c.date, c.text, c.findingId, c.repo, c.via, c.briefId],
  );
}

export interface FocusRow { item_text: string; repo: string | null; finding_id: string | null; created_at: Date }

export async function getFocus(date: string) {
  const { rows } = await pool.query<FocusRow>(
    "SELECT item_text, repo, finding_id, created_at FROM core.focus WHERE date=$1 ORDER BY created_at DESC, id DESC LIMIT 1",
    [date],
  );
  return rows[0];
}

export async function setPendingFocus(chatId: string, briefId: number, expiresAt: Date) {
  await pool.query(
    `INSERT INTO focus_pending(chat_id, brief_id, expires_at) VALUES ($1,$2,$3)
     ON CONFLICT (chat_id) DO UPDATE SET brief_id=EXCLUDED.brief_id, expires_at=EXCLUDED.expires_at, created_at=now()`,
    [chatId, briefId, expiresAt],
  );
}

// Removes the pending state either way, and returns it only while it hasn't expired.
export async function takePendingFocus(chatId: string, now: Date = new Date()) {
  const { rows } = await pool.query<{ brief_id: string | null; expires_at: Date }>(
    "DELETE FROM focus_pending WHERE chat_id=$1 RETURNING brief_id, expires_at", [chatId],
  );
  const row = rows[0];
  return row && row.expires_at > now ? { briefId: row.brief_id === null ? null : Number(row.brief_id) } : undefined;
}

export interface OpenNextRow { repo: string; text: string; section: string | null }

// Items in each repo's NEXT.md as of the last run that read it; items that left the file are skipped.
export async function openNextItems() {
  const { rows } = await pool.query<OpenNextRow>(
    `SELECT i.repo, i.text, i.section FROM next_items i
     JOIN next_files f ON f.repo = i.repo AND f.run_id = i.last_run_id
     WHERE i.state = 'open' AND f.sha IS NOT NULL
     ORDER BY i.repo, i.first_seen, i.item_id`,
  );
  return rows;
}

// The runs before runId, newest first, with their finding IDs: one query per brief.
export async function previousRuns(runId: number, limit = 100): Promise<PastRun[]> {
  const { rows } = await pool.query<{ id: string; source: string; status: string; window_end: Date; finding_ids: string[]; attention_ids: string[] }>(
    `SELECT r.id, r.source, r.status, r.window_end,
            COALESCE(array_agg(f.id) FILTER (WHERE f.id IS NOT NULL), '{}') AS finding_ids,
            COALESCE(array_agg(f.id) FILTER (WHERE f.id IS NOT NULL AND f.severity <> 'info'), '{}') AS attention_ids
     FROM (SELECT id, source, status, window_end FROM runs WHERE id < $1 ORDER BY id DESC LIMIT $2) r
     LEFT JOIN findings f ON f.run_id = r.id
     GROUP BY r.id, r.source, r.status, r.window_end
     ORDER BY r.id DESC`,
    [runId, limit],
  );
  return rows.map((r) => ({ id: Number(r.id), source: r.source, status: r.status, windowEnd: r.window_end, findingIds: r.finding_ids, attentionIds: r.attention_ids }));
}

export async function storeBriefSnoozable(briefId: number, items: StoredSnoozable[]) {
  await pool.query("UPDATE briefs SET snoozable=$2 WHERE id=$1", [briefId, JSON.stringify(items)]);
}

export async function getBriefSnoozable(briefId: number) {
  const { rows } = await pool.query<{ snoozable: StoredSnoozable[] | null }>("SELECT snoozable FROM briefs WHERE id=$1", [briefId]);
  return rows[0]?.snoozable ?? undefined;
}

export async function activeSnoozes(now: Date = new Date()) {
  const { rows } = await pool.query<{ finding_id: string }>("SELECT finding_id FROM snoozes WHERE until > $1", [now]);
  return new Set(rows.map((r) => r.finding_id));
}

export async function upsertSnooze(findingId: string, repo: string, until: Date) {
  await pool.query(
    `INSERT INTO snoozes(finding_id, repo, until) VALUES ($1,$2,$3)
     ON CONFLICT (finding_id) DO UPDATE SET repo=EXCLUDED.repo, until=EXCLUDED.until, created_at=now()`,
    [findingId, repo, until],
  );
}

export interface SnoozeRow { finding_id: string; repo: string | null; until: Date; summary: string | null }

// Active snoozes in a stable order, with each finding's latest stored summary; /unsnooze numbers follow it.
export async function listSnoozes(now: Date = new Date()) {
  const { rows } = await pool.query<SnoozeRow>(
    `SELECT s.finding_id, s.repo, s.until,
            (SELECT f.summary FROM findings f WHERE f.id = s.finding_id ORDER BY f.run_id DESC LIMIT 1) AS summary
     FROM snoozes s WHERE s.until > $1 ORDER BY s.until, s.created_at, s.finding_id`,
    [now],
  );
  return rows;
}

export async function deleteSnooze(findingId: string) {
  await pool.query("DELETE FROM snoozes WHERE finding_id=$1", [findingId]);
}

export async function storeBriefSentText(briefId: number, text: string) {
  await pool.query("UPDATE briefs SET sent_text=$2 WHERE id=$1", [briefId, text]);
}
