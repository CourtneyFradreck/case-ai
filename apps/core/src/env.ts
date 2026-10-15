function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const briefMode = process.env.CASE_BRIEF_MODE ?? "rules";
if (briefMode !== "rules" && briefMode !== "command" && briefMode !== "all") {
  throw new Error("Invalid CASE_BRIEF_MODE: expected rules, command or all");
}

export const env = {
  briefMode,
  geminiApiKey: briefMode === "rules" ? process.env.GEMINI_API_KEY : need("GEMINI_API_KEY"),
  geminiModel: process.env.GEMINI_MODEL ?? "gemini-3.5-flash-lite",
  databaseUrl: need("DATABASE_URL"),
  apiKey: need("CASE_API_KEY"),
  githubToken: need("GITHUB_TOKEN"),
  repos: need("CASE_REPOS").split(",").map((r) => r.trim()).filter(Boolean),
};
