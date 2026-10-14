import { readFileSync } from "node:fs";
import path from "node:path";
import { env } from "./env.js";
import { pool } from "./db.js";
import { yesterdayWindow } from "./time.js";
import { collectAll } from "./github/collect.js";
import { runRules } from "./rules/index.js";
import { render } from "./render.js";
import { startRun, finishRun, storeSnapshots, storeFindings, storeBrief } from "./store.js";

const config = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "config.json"), "utf8"));

export class BusyError extends Error {}

export async function runBrief(source: "schedule" | "command") {
  const lock = await pool.connect();
  const { rows } = await lock.query("SELECT pg_try_advisory_lock(777) AS ok");
  if (!rows[0].ok) { lock.release(); throw new BusyError("A brief is already being built"); }

  const w = yesterdayWindow();
  const runId = await startRun(source, w);
  try {
    const snaps = await collectAll(env.repos, w, config.ignoreAuthors);
    await storeSnapshots(runId, snaps);
    const findings = runRules(snaps, new Date(), config);
    await storeFindings(runId, findings);
    const text = render(findings, snaps, w, config.maxBriefChars);
    await storeBrief(runId, text);
    await finishRun(runId, snaps.some((s) => s.error) ? "partial" : "ok");
    return { runId, text };
  } catch (e) {
    await finishRun(runId, "failed", String(e));
    throw e;
  } finally {
    await lock.query("SELECT pg_advisory_unlock(777)");
    lock.release();
  }
}