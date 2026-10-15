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

export const env = {
  briefMode,
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  databaseUrl: need("DATABASE_URL"),
  apiKey: need("CASE_API_KEY"),
  githubToken: need("GITHUB_TOKEN"),
  repos: need("CASE_REPOS").split(",").map((r) => r.trim()).filter(Boolean),
};
