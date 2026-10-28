import { DateTime } from "luxon";
import { pool } from "./db.js";
import { features } from "./features.js";
import { cutoff } from "./checkin-config.js";
import { today, ZONE } from "./time.js";
import { esc } from "./render.js";
import { sendMessage, editMessageText } from "./telegram.js";
import type { TelegramCallbackQuery } from "./telegram-update.js";
import type { FocusRow } from "./store.js";
import { logText } from "./logs.js";

export type CheckinAnswer = "done" | "partly" | "none";
export const checkinAnswer = { done: "done", partly: "partly done", none: "didn't get to it" };
interface CheckinRow {
  id: string; date: string; focus_id: string | null; kind: "focus" | "open";
  status: "pending" | "sent" | "skipped" | "paused";
  answer: CheckinAnswer | null; reason: string | null;
}

export async function completedFocusIds(): Promise<Set<string>> {
  const { rows } = await pool.query<{ finding_id: string }>(
    "SELECT DISTINCT finding_id FROM core.focus WHERE COALESCE(checkin, status) = 'done' AND finding_id IS NOT NULL");
  return new Set(rows.map((row) => row.finding_id));
}
export function parseCheckinCallback(data?: string) {
  const m = /^c:(\d{1,19}):(done|partly|none)$/.exec(data ?? "");
  return m ? { checkinId: m[1], answer: m[2] as CheckinAnswer } : undefined;
}

export async function runCheckin(now = DateTime.now()) {
  if (!features.eveningCheckIn) return { sent: false, reason: "off" };
  const client = await pool.connect();
  try {
    // Hold a session lock through delivery; attempts survive a failed Telegram request.
    await client.query("SELECT pg_advisory_lock(778)");
    const date = today(now);
    const { rows: focuses } = await client.query<FocusRow & { id: string }>(
      "SELECT id, item_text, short_label FROM core.focus WHERE date=$1 AND status IN ('active','done') ORDER BY created_at DESC, id DESC LIMIT 1", [date]);
    const focus = focuses[0];
    const { rows: pauses } = await client.query("SELECT 1 FROM core.pauses WHERE start_date <= $1 AND end_date >= $1", [date]);
    const expires = now.setZone(ZONE).startOf("day").plus({ days: 1, hours: 12 }).toJSDate();
    await client.query(`INSERT INTO core.checkins(date, focus_id, kind, status, expires_at) VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (date) DO NOTHING`, [date, focus?.id ?? null, focus ? "focus" : "open", pauses.length ? "paused" : "pending", expires]);
    const { rows } = await client.query<CheckinRow>("SELECT * FROM core.checkins WHERE date=$1", [date]);
    const row = rows[0];
    if (row.status !== "pending") return { sent: false, reason: row.status };
    const [hour, minute] = cutoff.split(":").map(Number);
    const cutoffAt = now.setZone(ZONE).startOf("day").set({ hour, minute });
    const stop = pauses.length ? "paused" : now > cutoffAt ? "skipped" : undefined;
    if (stop) {
      await client.query("UPDATE core.checkins SET status=$2 WHERE id=$1", [row.id, stop]);
      return { sent: false, reason: stop };
    }
    await client.query("UPDATE core.checkins SET attempts=attempts+1 WHERE id=$1", [row.id]);
    // A retry uses the originally selected focus, even if today's choice has changed.
    const { rows: selected } = await client.query<FocusRow>("SELECT item_text, short_label FROM core.focus WHERE id=$1", [row.focus_id]);
    const item = selected[0];
    const sent = row.kind === "focus" && item
      ? await sendMessage(`How did ${esc(item.short_label || item.item_text)} go?`, { inline_keyboard: [[
        ...([['Done', 'done'], ['Partly', 'partly'], ["Didn't touch it", 'none']] as const)
          .map(([text, answer]) => ({ text, callback_data: `c:${row.id}:${answer}` })),
      ]] })
      : await sendMessage("Anything worth logging from today? Just reply.");
    await client.query("UPDATE core.checkins SET status='sent', sent_at=$2, telegram_message_id=$3 WHERE id=$1",
      [row.id, now.toJSDate(), sent.message_id]);
    return { sent: true };
  } finally {
    await client.query("SELECT pg_advisory_unlock(778)");
    client.release();
  }
}

export async function onCheckinCallback(query: TelegramCallbackQuery, now: DateTime) {
  if (!features.eveningCheckIn) return;
  const cb = parseCheckinCallback(query.data);
  if (!cb || !query.message) return;
  const client = await pool.connect();
  let focus: FocusRow | undefined;
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<CheckinRow>(`SELECT * FROM core.checkins
      WHERE id=$1 AND status='sent' AND expires_at > $2 FOR UPDATE`, [cb.checkinId, now.toJSDate()]);
    const row = rows[0];
    if (row?.focus_id) {
      const result = await client.query<FocusRow>(`UPDATE core.focus SET checkin=$2, checkin_at=$3,
        status=CASE WHEN $2='done' THEN 'done' WHEN status='done' THEN 'active' ELSE status END
        WHERE id=$1 AND date=$4 AND status IN ('active','done') RETURNING item_text, short_label`,
        [row.focus_id, cb.answer, now.toJSDate(), row.date]);
      focus = result.rows[0];
    }
    if (focus) await client.query("UPDATE core.checkins SET answer=$2, answered_at=$3, reason=NULL WHERE id=$1",
      [row.id, cb.answer, now.toJSDate()]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
  if (!focus) return { answerText: "That check-in has expired." };
  const prompt = cb.answer === "done" ? "Anything else from today? Just reply." : "What got in the way? (optional, just reply)";
  await editMessageText(query.message.message_id, `${esc(focus.short_label || focus.item_text)}: ${checkinAnswer[cb.answer]}.\n\n${prompt}`)
    .catch((e) => console.error("editMessageText failed", e));
  return { answerText: "Recorded" };
}

export async function onCheckinText(_chatId: string, text: string, now: DateTime) {
  if (!features.eveningCheckIn) return;
  // The text window is the sent row's calendar day, not its noon button expiry.
  const { rows } = await pool.query<CheckinRow>("SELECT * FROM core.checkins WHERE date=$1 AND sent_at IS NOT NULL", [today(now)]);
  const row = rows[0];
  if (!row) return;
  if (row.answer === "partly" || row.answer === "none") {
    const saved = await pool.query(`UPDATE core.checkins SET reason=$2
      WHERE id=$1 AND reason IS NULL AND answer IN ('partly','none') RETURNING id`, [row.id, text.trim()]);
    if (saved.rows.length) { await sendMessage("Recorded."); return; }
  }
  await logText(text, "checkin", now, row.focus_id);
}

export async function onPauseCommand(name: string, arg: string, now: DateTime) {
  if (!features.eveningCheckIn) return;
  const date = today(now);
  if (name === "pause" && arg && !/^(?:[1-9]|[12]\d|30)$/.test(arg)) {
    await sendMessage("Use /pause or /pause <days> (1–30)."); return;
  }
  const end = now.setZone(ZONE).plus({ days: Number(arg || 1) - 1 }).toISODate()!;
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock(778)");
    await client.query("BEGIN");
    if (name === "unpause") {
      await client.query("DELETE FROM core.pauses WHERE start_date <= $1 AND end_date >= $1", [date]);
      await client.query("UPDATE core.checkins SET status='pending' WHERE date=$1 AND status='paused'", [date]);
    } else {
      await client.query("INSERT INTO core.pauses(start_date, end_date) VALUES ($1,$2)", [date, end]);
      await client.query("UPDATE core.checkins SET status='paused' WHERE date=$1 AND status='pending'", [date]);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK"); throw error;
  } finally { await client.query("SELECT pg_advisory_unlock(778)"); client.release(); }
  await sendMessage(name === "unpause" ? "Evening check-ins resumed." : `Evening check-ins paused through ${end} (inclusive).`);
}
