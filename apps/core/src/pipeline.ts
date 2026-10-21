import { readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { env } from "./env.js";
import { features } from "./features.js";
import { pool } from "./db.js";
import { pastWeekWindow } from "./time.js";
import { selectRecap } from "./recap.js";
import { collectAll } from "./github/collect.js";
import { runRules } from "./rules/index.js";
import { runIntentRules } from "./intent/rules.js";
import { render } from "./render.js";
import { startRun, finishRun, storeSnapshots, storeNextItems, markMissingReported, storeFindings, storeBrief, storeBriefMessageId } from "./store.js";
import { sendMessage } from "./telegram.js";
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
  let delivered = false;
  let deliveryError: string | undefined;
  try {
    const snaps = await collectAll(env.repos, history, config.ignoreAuthors);
    await storeSnapshots(runId, snaps);
    const { history: intentHistory, missingReported } = await storeNextItems(runId, snaps);
    const { window: w, snapshots } = selectRecap(snaps, now);
    const findings = runRules(snapshots, now.toJSDate(), config, w);
    const intent = runIntentRules(snapshots, now.toJSDate(), config, intentHistory, missingReported);
    // Open NEXT.md items reach the model only as citations for focus suggestions; other intent findings are stored only.
    const next = features.focusButtons ? intent.filter((f) => f.rule === "next_item") : [];
    await storeFindings(runId, [...findings, ...intent]);
    await markMissingReported(intent.filter((f) => f.rule === "next_missing").map((f) => f.repo));
    const renderRules = (footer?: string) => render(findings, snaps, w, config.maxBriefChars, footer, { userName: config.userName, now });
    const ruleText = renderRules();
    let text = ruleText;
    const useModel = env.briefMode === "all" || (env.briefMode === "command" && source === "command");
    if (useModel && findings.length) {
      try {
        const { GeminiBriefModel } = await import("./llm/gemini.js");
        const provider = new GeminiBriefModel(env.geminiApiKey!, env.geminiModel, config.modelTimeoutMs);
        const result = await generateModelBrief([...findings, ...next], snaps, w, { ...config, focus: features.focusButtons }, provider, now);
        meta = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, json: result.json };
        text = "text" in result ? result.text : renderRules("Rule-only brief: model unavailable");
      } catch (error) {
        meta = fallbackMeta(env.geminiModel, "model_error", error instanceof Error ? error.message : String(error));
        text = renderRules("Rule-only brief: model unavailable");
      }
    }
    const briefId = await storeBrief(runId, text, meta, ruleText);
    await finishRun(runId, snaps.some((s) => s.error) ? "partial" : "ok");
    if (env.delivery === "core") {
      // A failed send returns delivered: false, so n8n sends the text instead and the brief still arrives.
      let messageId: number | undefined;
      try {
        messageId = (await sendMessage(text)).message_id;
        delivered = true;
      } catch (e) {
        deliveryError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      // The brief is already in Telegram, so a storage failure must not turn into delivered: false.
      if (messageId !== undefined) {
        try { await storeBriefMessageId(briefId, messageId); } catch (e) { console.error("storing telegram_message_id failed", e); }
      }
    }
    return { runId, text, delivered, ...(deliveryError ? { deliveryError } : {}) };
  } catch (e) {
    await finishRun(runId, "failed", String(e));
    throw e;
  } finally {
    console.info(JSON.stringify({ event: "brief", runId, source, mode: env.briefMode, model: meta?.model ?? null,
      attempts: meta?.json.attempts ?? 0, inputTokens: meta?.inputTokens ?? null, outputTokens: meta?.outputTokens ?? null,
      dropped: meta?.json.dropped.length ?? 0, fallbackReason: meta?.json.fallbackReason ?? null,
      fallbackDetail: meta?.json.fallbackReason ? (meta.json.fallbackDetail ?? meta.json.fallbackReason).slice(0, 200) : null,
      delivery: env.delivery, delivered, deliveryError: deliveryError ?? null }));
    await lock.query("SELECT pg_advisory_unlock(777)");
    lock.release();
  }
}
