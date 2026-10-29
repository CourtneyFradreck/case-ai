function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

let briefMode = (process.env.CASE_BRIEF_MODE ?? "rules").trim();
if (briefMode !== "rules" && briefMode !== "command" && briefMode !== "all") {
  console.warn("Invalid CASE_BRIEF_MODE: expected rules, command or all; using rules.");
  briefMode = "rules";
} else if (briefMode !== "rules" && !process.env.GEMINI_API_KEY?.trim()) {
  console.warn("Missing GEMINI_API_KEY for model brief mode; using rules.");
  briefMode = "rules";
}

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN?.trim() || undefined;
const telegramChatId = process.env.TELEGRAM_CHAT_ID?.trim() || undefined;

// Comma-separated list: trims spaces and surrounding quotes on each entry and drops empties.
const list = (v: string) => v.split(",").map((s) => s.trim().replace(/^["']+|["']+$/g, "").trim()).filter(Boolean);

// An entry that isn't owner/repo can only fail to collect, so it is left out with a warning.
const repos = list(need("CASE_REPOS")).filter((r) => {
  if (/^[\w.-]+\/[\w.-]+$/.test(r)) return true;
  console.warn(`Ignoring CASE_REPOS entry "${r}": expected owner/repo.`);
  return false;
});

let delivery = (process.env.CASE_DELIVERY ?? "n8n").trim();
if (delivery !== "n8n" && delivery !== "core") {
  console.warn("Invalid CASE_DELIVERY: expected n8n or core; using n8n.");
  delivery = "n8n";
} else if (delivery === "core" && (!telegramBotToken || !telegramChatId)) {
  console.warn("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID for CASE_DELIVERY=core; using n8n.");
  delivery = "n8n";
}

export const env = {
  briefMode,
  delivery: delivery as "n8n" | "core",
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  databaseUrl: need("DATABASE_URL"),
  apiKey: need("CASE_API_KEY"),
  githubToken: need("GITHUB_TOKEN"),
  repos,
  // Globs for branches never compared or walked, e.g. asset branches with no common history.
  branchExclude: list(process.env.CASE_BRANCH_EXCLUDE ?? "pr-assets/*"),
  telegramBotToken,
  telegramChatId,
};
