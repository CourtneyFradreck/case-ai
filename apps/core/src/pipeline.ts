import { readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { env } from "./env.js";
import { pool } from "./db.js";
import { pastWeekWindow } from "./time.js";
import { selectRecap } from "./recap.js";
import { collectAll } from "./github/collect.js";
import { runRules } from "./rules/index.js";
import { runIntentRules } from "./intent/rules.js";
import { render } from "./render.js";
import { startRun, finishRun, storeSnapshots, storeNextItems, storeFindings, storeBrief } from "./store.js";
import { generateModelBrief, fallbackMeta, type BriefMeta } from "./llm/brief.js";

const config = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "config.json"), "utf8"));

export class BusyError extends Error {}

export async function runBrief(source: "schedule" | "command", now: DateTime = DateTime.now()) {
  const lock = await pool.connect();
  const { rows } = await lock.query("SELECT pg_try_advisory_lock(777) AS ok");
  if (!rows[0].ok) { lock.release(); throw new BusyError("A brief is already being built"); }

  const history = pastWeekWindow(now);
  const runId = await startRun(source, history);
  let meta: BriefMeta | undefined;
  try {
    const snaps = await collectAll(env.repos, history, config.ignoreAuthors);
    await storeSnapshots(runId, snaps);
    await storeNextItems(runId, snaps);
    const { window: w, snapshots } = selectRecap(snaps, now);
    const findings = runRules(snapshots, now.toJSDate(), config, w);
    // Stored only: intent findings join the brief and model input in a later milestone.
    const intent = runIntentRules(snapshots, now.toJSDate(), config);
    await storeFindings(runId, [...findings, ...intent]);
    const renderRules = (footer?: string) => render(findings, snaps, w, config.maxBriefChars, footer, { userName: config.userName, now });
    let text = renderRules();
    const useModel = env.briefMode === "all" || (env.briefMode === "command" && source === "command");
    if (useModel && findings.length) {
      try {
        const { GeminiBriefModel } = await import("./llm/gemini.js");
        const provider = new GeminiBriefModel(env.geminiApiKey!, env.geminiModel, config.modelTimeoutMs);
        const result = await generateModelBrief(findings, snaps, w, config, provider, now);
        meta = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, json: result.json };
        text = "text" in result ? result.text : renderRules("Rule-only brief: model unavailable");
      } catch (error) {
        meta = fallbackMeta(env.geminiModel, "model_error", error instanceof Error ? error.message : String(error));
        text = renderRules("Rule-only brief: model unavailable");
      }
    }
    await storeBrief(runId, text, meta);
    await finishRun(runId, snaps.some((s) => s.error) ? "partial" : "ok");
    return { runId, text };
  } catch (e) {
    await finishRun(runId, "failed", String(e));
    throw e;
  } finally {
    console.info(JSON.stringify({ event: "brief", runId, source, mode: env.briefMode, model: meta?.model ?? null,
      attempts: meta?.json.attempts ?? 0, inputTokens: meta?.inputTokens ?? null, outputTokens: meta?.outputTokens ?? null,
      dropped: meta?.json.dropped.length ?? 0, fallbackReason: meta?.json.fallbackReason ?? null,
      fallbackDetail: meta?.json.fallbackReason ? (meta.json.fallbackDetail ?? meta.json.fallbackReason).slice(0, 200) : null }));
    await lock.query("SELECT pg_advisory_unlock(777)");
    lock.release();
  }
}
