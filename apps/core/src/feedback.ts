import { DateTime } from "luxon";
import { pool } from "./db.js";
import { esc } from "./render.js";
import { sendMessage } from "./telegram.js";
import { ZONE } from "./time.js";

// /wrong and /missed: notes on what a brief got wrong or left out, kept in core.feedback.
// Always on. Never sent to the model and never shown in a brief.

export type FeedbackKind = "wrong" | "missed";
export const MAX_FEEDBACK = 500;
const LIST_LIMIT = 10;

const USAGE: Record<FeedbackKind, string> = {
  wrong: "Use /wrong <what the brief got wrong>. Reply to a brief to link it.",
  missed: "Use /missed <what the brief should have mentioned>. Reply to a brief to link it.",
};

const day = (d: Date, format: string) => DateTime.fromJSDate(d).setZone(ZONE).setLocale("en").toFormat(format);

// The brief replied to, when it is one; otherwise the latest brief case-core delivered (scheduled or /brief).
// Only delivered briefs have a telegram_message_id.
export async function feedbackBrief(replyTo?: number): Promise<{ id: string; created_at: Date } | undefined> {
  if (replyTo !== undefined) {
    const { rows } = await pool.query<{ id: string; created_at: Date }>(
      "SELECT id, created_at FROM briefs WHERE telegram_message_id=$1 ORDER BY id DESC LIMIT 1", [replyTo]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await pool.query<{ id: string; created_at: Date }>(
    "SELECT id, created_at FROM briefs WHERE telegram_message_id IS NOT NULL ORDER BY id DESC LIMIT 1");
  return rows[0];
}

export async function reportFeedback(kind: FeedbackKind, input: string, replyTo?: number) {
  const text = input.trim();
  if (!text) { await sendMessage(USAGE[kind]); return; }
  if (text.length > MAX_FEEDBACK) { await sendMessage(`Keep feedback to ${MAX_FEEDBACK} characters.`); return; }
  const brief = await feedbackBrief(replyTo);
  await pool.query("INSERT INTO core.feedback(kind, text, brief_id) VALUES ($1,$2,$3)", [kind, text, brief?.id ?? null]);
  await sendMessage(`Noted: ${esc(text.replace(/\s+/g, " "))}${brief ? ` (brief of ${day(brief.created_at, "ccc d LLL")})` : ""}`);
}

interface FeedbackRow { id: string; kind: FeedbackKind; text: string; created_at: Date }

export function feedbackList(rows: FeedbackRow[]): string {
  if (!rows.length) return "No open feedback.";
  return [...rows.map((r) => `#${r.id} ${r.kind} · ${day(r.created_at, "d LLL")}: ${esc(r.text.replace(/\s+/g, " "))}`),
    "", "Send /feedback done <id> to resolve one."].join("\n");
}

// /feedback lists the latest unresolved entries; /feedback done <id> resolves one.
export async function onFeedbackCommand(arg: string, now: DateTime) {
  if (!arg) {
    const { rows } = await pool.query<FeedbackRow>(
      "SELECT id, kind, text, created_at FROM core.feedback WHERE resolved_at IS NULL ORDER BY created_at DESC, id DESC LIMIT $1", [LIST_LIMIT]);
    await sendMessage(feedbackList(rows));
    return;
  }
  const m = /^done\s+#?(\d{1,18})$/i.exec(arg);
  if (!m) { await sendMessage("Use /feedback to list open feedback, or /feedback done <id>."); return; }
  // Resolving twice keeps the first time.
  const { rows } = await pool.query<{ id: string }>(
    "UPDATE core.feedback SET resolved_at=COALESCE(resolved_at, $2) WHERE id=$1 RETURNING id", [m[1], now.toJSDate()]);
  await sendMessage(rows[0] ? `Resolved #${rows[0].id}.` : `No feedback #${m[1]}.`);
}
