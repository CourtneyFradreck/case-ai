import { readFileSync } from "node:fs";
import path from "node:path";
import { DateTime } from "luxon";
import { env } from "./env.js";
import { features } from "./features.js";
import { pool } from "./db.js";
import { pastWeekWindow } from "./time.js";
import { activityTimes, selectRecap } from "./recap.js";
import { isQuietMorning, quietText } from "./quiet.js";
import { collectAll } from "./github/collect.js";
import { runRules } from "./rules/index.js";
import { runIntentRules } from "./intent/rules.js";
import { render } from "./render.js";
import { startRun, finishRun, storeSnapshots, storeNextItems, markMissingReported, storeFindings, storeBrief, previousBriefAt, snoozedFocusIds, storeBriefMessageId, storeBriefFocus, getFocus, previousRuns, activeSnoozes, storeBriefSnoozable, storeBriefSentText } from "./store.js";
import { snoozable, snoozeButtonRow, withoutSnoozed } from "./snooze.js";
import type { InlineKeyboardButton } from "./telegram.js";
import { collapseRepeats, countStreaks, lastScheduledRun } from "./streaks.js";
import { gateOldBranches, oldBranchesDay } from "./old-branches.js";
import { ZONE } from "./time.js";
import { sendMessage } from "./telegram.js";
import { generateModelBrief, fallbackMeta, type BriefMeta } from "./llm/brief.js";
import { focusKeyboard, focusPeriod, leftOpen, rankNext, ready, ruleFocus, storedFocus, yesterdayFocus } from "./focus.js";
import type { ValidFocus } from "./llm/schema.js";

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
  let quiet = false;
  // Why each suggestion was made: logged and stored with the brief, never shown.
  let focusReasons: { findingId: string | null; reason: string }[] = [];
  // Quiet mornings compare with the previous scheduled brief, so only scheduled briefs can be quiet.
  const quietCheck = features.quietMornings && source === "schedule";
  try {
    const snaps = await collectAll(env.repos, history, config.ignoreAuthors);
    await storeSnapshots(runId, snaps);
    const { history: intentHistory, missingReported } = await storeNextItems(runId, snaps);
    const { window: w, snapshots } = selectRecap(snaps, now);
    const findings = runRules(snapshots, now.toJSDate(), config, w);
    const intent = runIntentRules(snapshots, now.toJSDate(), config, intentHistory, missingReported);
    const focusRow = features.focusButtons || quietCheck ? await getFocus(now.setZone(ZONE).minus({ days: 1 }).toISODate()!) : undefined;
    // Open NEXT.md items reach the model only as citations for focus suggestions; other intent findings are stored only.
    // Overdue items go last, for the model as for the rule-picked suggestions.
    // A snoozed focus keeps its finding out of suggestions for a few days. An item that waits on an open one above it is left out.
    const parked = features.focusButtons ? await snoozedFocusIds(now.toJSDate()) : new Set<string>();
    const next = features.focusButtons ? rankNext(intent.filter((f) => f.rule === "next_item" && ready(f) && !parked.has(f.id)), snaps, now.toJSDate(), config, focusRow?.finding_id) : [];
    // Items a merged PR likely finished get a tick-off line, written by code, instead of a suggestion.
    const done = features.focusButtons ? intent.filter((f) => f.rule === "next_likely_done") : [];
    const period = features.focusButtons && focusRow ? focusPeriod(await previousBriefAt(runId), w, now.toJSDate()) : undefined;
    const previousFocus = period ? yesterdayFocus(focusRow, snaps, period) : [];
    await storeFindings(runId, [...findings, ...intent, ...previousFocus]);
    await markMissingReported(intent.filter((f) => f.rule === "next_missing").map((f) => f.repo));
    // Snoozed findings are stored as usual but left out of the brief, the model input and the suggestions.
    const unsnoozed = features.snooze ? withoutSnoozed(findings, await activeSnoozes(now.toJSDate())) : findings;
    // Streaks count previous scheduled runs, so only scheduled briefs collapse repeats.
    const collapsing = features.streaks && source === "schedule";
    // Off the weekly day, the old-branches line needs the last scheduled run to see whether its branches changed.
    const oldDay = oldBranchesDay(now, config);
    const gating = !oldDay && unsnoozed.some((f) => f.rule === "old_branches");
    const past = collapsing || quietCheck || gating ? await previousRuns(runId) : [];
    const visible = gateOldBranches(unsnoozed, oldDay, lastScheduledRun(past));
    const { kept, collapsed, days } = collapsing
      ? collapseRepeats(visible, countStreaks(visible.map((f) => f.id), past), config.streakCollapseAfter ?? 3)
      : { kept: visible, collapsed: [], days: new Map<string, number>() };
    const snoozeItems = features.snooze ? snoozable(visible) : [];
    // Branches and PRs left open are often kept on purpose: one low line written by code, never suggested or sent to the model.
    const lingering = kept.filter(leftOpen);
    const active = kept.filter((f) => !leftOpen(f));
    // The rule-only brief, and the model's fallback, pick focus suggestions in code.
    const rulesFocus = features.focusButtons ? ruleFocus(active.filter((f) => !parked.has(f.id)), next, snaps, now.toJSDate(), config, focusRow?.finding_id) : [];
    const options = { userName: config.userName, now, previousFocus, collapsed, days, done, leftOpen: lingering };
    const renderRules = (footer?: string) => render(active, snaps, w, config.maxBriefChars, footer, options, rulesFocus);
    const ruleText = renderRules();
    let text = ruleText;
    let focus: ValidFocus[] = rulesFocus;
    const useModel = env.briefMode === "all" || (env.briefMode === "command" && source === "command");
    if (useModel && active.length) {
      try {
        const { GeminiBriefModel } = await import("./llm/gemini.js");
        const provider = new GeminiBriefModel(env.geminiApiKey!, env.geminiModel, config.modelTimeoutMs);
        const result = await generateModelBrief([...active, ...next], snaps, w, { ...config, focus: features.focusButtons, previousFocus, collapsed, days, done, leftOpen: lingering, parked }, provider, now);
        meta = { model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, json: result.json };
        text = "text" in result ? result.text : renderRules("Rule-only brief: model unavailable");
        if ("text" in result) focus = result.focus;
      } catch (error) {
        meta = fallbackMeta(env.geminiModel, "model_error", error instanceof Error ? error.message : String(error));
        text = renderRules("Rule-only brief: model unavailable");
      }
    }
    // Compared as stored, so today's IDs match what the previous run stored.
    const attentionIds = [...findings, ...intent, ...previousFocus].filter((f) => f.severity !== "info").map((f) => f.id);
    const activity = activityTimes(snaps, now);
    quiet = quietCheck && isQuietMorning(attentionIds, lastScheduledRun(past), activity, now.setZone(ZONE).startOf("day").toJSDate());
    // The full brief is stored either way; a quiet morning only changes what is sent.
    const sent = quiet ? quietText(activity, now, focusRow?.item_text ?? kept.find((f) => f.severity !== "info")?.summary) : text;
    const briefId = await storeBrief(runId, text, meta, ruleText);
    if (quiet) await storeBriefSentText(briefId, sent);
    focusReasons = storedFocus(focus).map(({ findingId, reason }) => ({ findingId, reason }));
    if (focus.length) await storeBriefFocus(briefId, storedFocus(focus));
    if (snoozeItems.length) await storeBriefSnoozable(briefId, snoozeItems);
    await finishRun(runId, snaps.some((s) => s.error) ? "partial" : "ok");
    if (env.delivery === "core") {
      // A failed send returns delivered: false, so n8n sends the text instead and the brief still arrives.
      let messageId: number | undefined;
      try {
        const buttons: InlineKeyboardButton[][] = [
          ...(focus.length ? focusKeyboard(briefId, focus.length).inline_keyboard : []),
          ...(snoozeItems.length ? [snoozeButtonRow(briefId)] : []),
        ];
        messageId = (await (buttons.length ? sendMessage(sent, { inline_keyboard: buttons }) : sendMessage(sent))).message_id;
        delivered = true;
      } catch (e) {
        deliveryError = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      }
      // The brief is already in Telegram, so a storage failure must not turn into delivered: false.
      if (messageId !== undefined) {
        try { await storeBriefMessageId(briefId, messageId); } catch (e) { console.error("storing telegram_message_id failed", e); }
      }
    }
    return { runId, text: sent, delivered, ...(deliveryError ? { deliveryError } : {}) };
  } catch (e) {
    await finishRun(runId, "failed", String(e));
    throw e;
  } finally {
    console.info(JSON.stringify({ event: "brief", runId, source, mode: env.briefMode, model: meta?.model ?? null,
      attempts: meta?.json.attempts ?? 0, inputTokens: meta?.inputTokens ?? null, outputTokens: meta?.outputTokens ?? null,
      dropped: meta?.json.dropped.length ?? 0, fallbackReason: meta?.json.fallbackReason ?? null,
      fallbackDetail: meta?.json.fallbackReason ? (meta.json.fallbackDetail ?? meta.json.fallbackReason).slice(0, 200) : null,
      delivery: env.delivery, delivered, deliveryError: deliveryError ?? null, ...(quietCheck ? { quiet } : {}),
      ...(focusReasons.length ? { focusReasons } : {}) }));
    await lock.query("SELECT pg_advisory_unlock(777)");
    lock.release();
  }
}
