function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export const env = {
  databaseUrl: need("DATABASE_URL"),
  apiKey: need("CASE_API_KEY"),
  githubToken: need("GITHUB_TOKEN"),
  repos: need("CASE_REPOS").split(",").map((r) => r.trim()).filter(Boolean),
};