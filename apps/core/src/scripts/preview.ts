import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GeminiBriefModel } from "../llm/gemini.js";
import { generateModelBrief } from "../llm/brief.js";
import { render } from "../render.js";
import { runRules } from "../rules/index.js";
import { runIntentRules } from "../intent/rules.js";
import { readFeatures } from "../features.js";
import { rankNext, ruleFocus } from "../focus.js";
import { selectRecap } from "../recap.js";
import { DateTime } from "luxon";
import type { RepoSnapshot } from "../types.js";

// The preview needs only a Gemini key, not the service's required environment.
for (const relative of ["../../../../.env", "../../.env"]) {
  const file = fileURLToPath(new URL(relative, import.meta.url));
  if (existsSync(file)) process.loadEnvFile(file);
}

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === "your_gemini_api_key") throw new Error("Set GEMINI_API_KEY in your environment or .env to run the preview.");
  const config = JSON.parse(readFileSync(new URL("../../config.json", import.meta.url), "utf8"));
  const oct15 = process.argv.includes("--oct15");
  // Load test fixtures through tsx, keeping them outside the production tsc root.
  const fixturesUrl = new URL("../../test/fixtures.js", import.meta.url);
  let { previewSnapshots, NOW } = await import(fixturesUrl.href) as { previewSnapshots: RepoSnapshot[]; NOW: Date };
  if (oct15) {
    const fixtureUrl = new URL("../../test/fixtures/oct15.js", import.meta.url);
    const fixture = await import(fixtureUrl.href) as { OCT15_NOW: Date; oct15Fixture(): { expected: RepoSnapshot } };
    previewSnapshots = [fixture.oct15Fixture().expected];
    NOW = fixture.OCT15_NOW;
  }
  const { window: w, snapshots } = selectRecap(previewSnapshots, DateTime.fromJSDate(NOW));
  const findings = runRules(snapshots, NOW, config, w);
  const provider = new GeminiBriefModel(apiKey, process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite", config.modelTimeoutMs);
  const now = oct15 ? DateTime.fromJSDate(NOW) : DateTime.now();
  const intent = runIntentRules(snapshots, NOW, config);
  const { focusButtons } = readFeatures(config);
  // As in the pipeline: open NEXT.md items and focus suggestions appear only with focusButtons on.
  const next = focusButtons ? rankNext(intent.filter((f) => f.rule === "next_item"), previewSnapshots, NOW, config) : [];
  const done = focusButtons ? intent.filter((f) => f.rule === "next_likely_done") : [];
  const focus = focusButtons ? ruleFocus(findings, next, previewSnapshots, NOW, config) : [];
  const renderRules = (footer?: string) => render(findings, previewSnapshots, w, config.maxBriefChars, footer, { userName: config.userName, now, done }, focus);
  const save = (path: string, text: string) => {
    if (!oct15) return;
    const out = new URL("../../../../out/", import.meta.url);
    mkdirSync(out, { recursive: true });
    writeFileSync(new URL(`${path}.html`, out), `<!doctype html><meta charset="utf-8"><title>CASE 15 Oct fixture</title><body style="font:16px/1.6 system-ui;max-width:900px;margin:3rem auto;padding:0 1rem;white-space:pre-wrap">${text}</body>`, "utf8");
    writeFileSync(new URL(`${path}.txt`, out), text.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"), "utf8");
  };
  if (oct15) {
    const template = renderRules();
    save("oct15-template", template);
    console.log("Template brief (15 Oct fixture):");
    console.log(template);
    save("oct15-fallback", renderRules("Rule-only brief: model unavailable"));
  }
  const result = await generateModelBrief([...findings, ...next], previewSnapshots, w, { ...config, focus: focusButtons, done }, provider, now);
  console.log("Raw JSON:");
  for (const raw of result.json.responses ?? []) console.log(raw);
  console.log("Validation report:");
  console.log(JSON.stringify({ model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ...result.json, raw: undefined, responses: undefined }, null, 2));
  console.log("Telegram text:");
  const text = "text" in result ? result.text : renderRules("Rule-only brief: model unavailable");
  console.log(text);
  save("oct15-model", text);
  console.log(focusButtons ? "Intent findings (open items can back focus suggestions):" : "Intent findings (not in the brief):");
  if (!intent.length) console.log("(none)");
  for (const f of intent) console.log(`[${f.severity}] ${f.rule}: ${f.summary}${f.details ? ` (${f.details.join("; ")})` : ""} <${f.sources[0]?.url}>`);
  if ("fallbackReason" in result) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Preview failed");
  process.exitCode = 1;
});
