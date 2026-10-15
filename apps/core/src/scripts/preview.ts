import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { GeminiBriefModel } from "../llm/gemini.js";
import { generateModelBrief } from "../llm/brief.js";
import { render } from "../render.js";
import { runRules } from "../rules/index.js";
import { yesterdayWindow } from "../time.js";
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
  // Load test fixtures through tsx, keeping them outside the production tsc root.
  const fixturesUrl = new URL("../../test/fixtures.js", import.meta.url);
  const { previewSnapshots, NOW } = await import(fixturesUrl.href) as { previewSnapshots: RepoSnapshot[]; NOW: Date };
  const w = yesterdayWindow(DateTime.fromJSDate(NOW));
  const findings = runRules(previewSnapshots, NOW, config);
  const provider = new GeminiBriefModel(apiKey, process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite", config.modelTimeoutMs);
  const result = await generateModelBrief(findings, previewSnapshots, w, config, provider);
  console.log("Raw JSON:");
  for (const raw of result.json.responses ?? []) console.log(raw);
  console.log("Validation report:");
  console.log(JSON.stringify({ model: result.model, inputTokens: result.inputTokens, outputTokens: result.outputTokens, ...result.json, raw: undefined, responses: undefined }, null, 2));
  console.log("Telegram text:");
  console.log("text" in result ? result.text : render(findings, previewSnapshots, w, config.maxBriefChars, "Rule-only brief: model unavailable"));
  if ("fallbackReason" in result) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Preview failed");
  process.exitCode = 1;
});
