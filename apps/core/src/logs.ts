import { DateTime } from "luxon";
import { pool } from "./db.js";
import { env } from "./env.js";
import { esc } from "./render.js";
import { sendMessage } from "./telegram.js";
import { today, type Window } from "./time.js";

export interface ActivityLog { id: string; text: string; tag: string | null; created_at: Date }

// Prefer the leading tag; all other hashtags are ordinary text.
export function parseLog(input: string, repos: string[] = env.repos) {
  let text = input.trim();
  const match = /^#([\w-]+)(?=\s|$)/.exec(text) ?? /(?:^|\s)#([\w-]+)$/.exec(text);
  let tag = match?.[1].toLowerCase() ?? null;
  if (match) text = (text.slice(0, match.index) + text.slice(match.index + match[0].length)).trim();
  if (tag) tag = repos.map((r) => r.split("/").pop()!).find((r) => r.toLowerCase() === tag) ?? tag;
  return { text, tag };
}

export async function logText(input: string, via: "command" | "checkin", now: DateTime) {
  if (input.trim().length >= 500) { await sendMessage("Keep logs under 500 characters."); return; }
  const entry = parseLog(input);
  if (!entry.text) { await sendMessage("Use /log <text> [#tag]."); return; }
  await pool.query("INSERT INTO core.activity_logs(date, text, tag, via) VALUES ($1,$2,$3,$4)", [today(now), entry.text, entry.tag, via]);
  await sendMessage(via === "checkin" ? "Logged." : `Logged: ${esc(entry.text.replace(/\s+/g, " "))}${entry.tag ? ` (#${esc(entry.tag)})` : ""}`);
}

export async function undoLog(now: DateTime) {
  const { rows } = await pool.query<ActivityLog>(
    `DELETE FROM core.activity_logs WHERE id = (SELECT id FROM core.activity_logs
     WHERE date=$1 ORDER BY created_at DESC, id DESC LIMIT 1) RETURNING text, tag`, [today(now)]);
  const row = rows[0];
  await sendMessage(row ? `Removed: ${esc(row.text.replace(/\s+/g, " "))}${row.tag ? ` (#${esc(row.tag)})` : ""}` : "Nothing to undo today.");
}

export async function logsInWindow(w: Window): Promise<ActivityLog[]> {
  const { rows } = await pool.query<ActivityLog>(
    "SELECT id, text, tag, created_at FROM core.activity_logs WHERE date >= $1::date AND date < $2::date ORDER BY created_at, id",
    [today(DateTime.fromJSDate(w.start)), today(DateTime.fromJSDate(w.end))]);
  return rows;
}
