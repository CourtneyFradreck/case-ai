import { Hono, type MiddlewareHandler } from "hono";
import { env } from "./env.js";
import { runBrief, BusyError } from "./pipeline.js";
import { handleUpdate, isOwnerUpdate } from "./telegram-update.js";

export const app = new Hono();

const requireKey: MiddlewareHandler = async (c, next) => {
  if (c.req.header("x-case-key") !== env.apiKey) return c.json({ error: "unauthorized" }, 401);
  await next();
};
app.use("/brief", requireKey);
app.use("/telegram/*", requireKey);

app.get("/health", (c) => c.json({ ok: true }));

app.post("/brief", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const source = body?.source === "schedule" ? "schedule" : "command";
  try {
    return c.json(await runBrief(source));
  } catch (e) {
    if (e instanceof BusyError) return c.json({ error: "busy" }, 409);
    console.error(e);
    return c.json({ error: "brief_failed", detail: String(e) }, 500);
  }
});

// n8n forwards raw Telegram updates here. Reply at once and handle the update in the background.
// `owner` tells n8n whether the update came from TELEGRAM_CHAT_ID.
app.post("/telegram/update", async (c) => {
  const update = await c.req.json().catch(() => undefined);
  if (!update || typeof update !== "object" || Array.isArray(update)) return c.json({ error: "invalid_update" }, 400);
  const owner = isOwnerUpdate(update);
  handleUpdate(update).catch((e) => console.error("telegram update failed", e));
  return c.json({ ok: true, owner });
});
