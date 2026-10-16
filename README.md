# CASE — Cognitive Assistant for Scheduling and Execution

> C.A.S.E inspired by one of the AI systems from Interstellar

**A daily Telegram brief that tells me where I left off.**

Every morning at 7am, CASE looks at my GitHub activity, the `NEXT.md` file in each repo and the notes I've logged, then sends me a short brief: what needs my attention, followed by what I worked on most recently. The recap uses the last active day within the past week, or both weekend days on Monday. Dates follow Africa/Harare time. Every line links back to the commit, issue, PR or note it came from.

CASE is the first module of **ALFRED**, a personal AI assistant I'm building one piece at a time.

> **Status:** Milestone 1 (rule-only brief) in trial; M2 (model brief) built, not yet deployed.

---

## Why

I work across several projects at once. Commits record what changed, but not where I was heading. Coming back to a project after a day, a week or a few months means rebuilding that context from memory. CASE keeps the direction alive.

## What it does (v1 goals)

- Summarises the most recent active day's commits, issues and PRs across my personal repos
- Lists unfinished work: open PRs, unmerged branches, failing CI, open `NEXT.md` items
- **M3:** Suggests two or three things to focus on today, each with a reason
- Lets me reply to pick a focus, or log non-code work with `/log`
- Links every statement to its source, and drops anything it can't source

## What it doesn't do

- Write to repos. CASE is read-only.
- Support teams, Jira, Linear or GitLab.
- Score productivity.

## How it works

```
GitHub API ─┐
NEXT.md ────┼─> case-core: collect -> rule checks -> write brief -> validate -> Telegram
Telegram ───┘                              │
                                     Gemini API
```

- **n8n** handles schedules and the Telegram webhook.
- **case-core** holds all the logic, so it can be tested.
- **Rules decide the facts.** The model only phrases and prioritises what the rules found.
- **The model never writes links.** It cites finding IDs, and code turns those into real links. Claims without a valid source are dropped.
- If the model fails, a plain rule-based brief is sent instead.

## Stack

| Part          | Choice                            |
| ------------- | --------------------------------- |
| Service       | Node 22, TypeScript, Hono         |
| Orchestration | n8n                               |
| Database      | PostgreSQL 16                     |
| Model         | Gemini Flash-Lite (configurable via `GEMINI_MODEL`) |
| Interface     | Telegram bot                      |
| Deployment    | Docker Compose on Dokploy         |

## Repo structure

```
case-ai/
├── apps/core/          # case-core service
├── infra/              # database init scripts
├── n8n/workflows/      # exported n8n workflows (no secrets)
├── docker-compose.yml
├── .env.example
└── NEXT.md             # what's next for CASE itself
```

## Running it yourself

You'll need Docker, a server with a public HTTPS domain (Telegram webhooks require one) and a Telegram bot token from [@BotFather](https://t.me/BotFather).

```bash
git clone https://github.com/courtneyfradreck/case-ai.git
cd case-ai
cp .env.example .env    # fill in the values
docker compose up --build
```

Then open n8n at your domain, add your Telegram credential, import the workflow from `n8n/workflows/` and activate it.

### Environment variables

| Variable             | Purpose                                 |
| -------------------- | --------------------------------------- |
| `POSTGRES_PASSWORD`  | Database password                       |
| `CASE_API_KEY`       | Shared secret between n8n and case-core |
| `N8N_ENCRYPTION_KEY` | Encrypts n8n credentials. Back it up.   |
| `N8N_HOST`           | Public domain for n8n                   |
| `GITHUB_TOKEN`       | Read-only GitHub token for the tracked repos |
| `CASE_REPOS`         | Comma-separated `owner/repo` names |
| `CASE_BRIEF_MODE`    | `rules` (default): template briefs; `command`: model for manual `/brief` requests only; `all`: model for scheduled and manual briefs. Missing or invalid values use `rules`. |
| `GEMINI_API_KEY`     | Required for model briefs. A missing key uses `rules`; an invalid key or failed model request sends a rule-only fallback. |
| `GEMINI_MODEL`       | Model ID; defaults to `gemini-3.5-flash-lite`. An invalid model setting sends a rule-only fallback. |

Generate secrets with `openssl rand -hex 32`. Never commit `.env`.

`CASE_BRIEF_MODE` stays `rules` on merge. After the M1 trial ends on Mon 19 Oct, run `command` for three days and inspect the `brief` log events (`source`, `dropped`, `fallbackReason`, and `fallbackDetail`) before switching to `all`. No mode change is automatic.

### Previewing a model brief

From `apps/core`, run `npm install` and `npm run preview`. This calls the live model with synthetic fixtures and needs only `GEMINI_API_KEY` in your environment or `.env`; `GEMINI_MODEL` is optional. It prints raw JSON, the validation report, and the rendered Telegram text without reading GitHub, accessing the database, or sending Telegram messages.

Use `npm run preview:oct15` to render the 15 Oct attribution regression fixture through both template and model paths. It also saves template, model, and rule-only fallback previews under `out/`.

## Roadmap

- [x] **M0 Skeleton:** stack deployed, `/brief` replies hello
- [x] **M1 Rule-only brief:** GitHub collector and rule checks, plain brief at 7am
- [ ] **M2 Model brief:** model writes the brief, validator checks every citation
- [ ] **M3 Intent:** `NEXT.md` parsing, focus suggestions with reasons, focus buttons
- [ ] **M4 Non-code:** `/log` and an evening check-in
- [ ] **M5 Evaluation:** golden test set, `/wrong` and `/missed` feedback

## Security notes

- GitHub access uses a fine-grained, read-only token limited to chosen repos.
- The bot only responds to one Telegram chat ID.
- case-core and Postgres are never exposed publicly.
- Issue and PR text is treated as untrusted data; the model has no tools and no write access.

## License

[MIT License](LICENSE)
