import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { env } from "./env.js";
import { migrate } from "./db.js";
import { runBrief, BusyError } from "./pipeline.js";

await migrate();

const app = new Hono();

app.use("/brief", async (c, next) => {
  if (c.req.header("x-case-key") !== env.apiKey) return c.json({ error: "unauthorized" }, 401);
  await next();
});

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

serve({ fetch: app.fetch, port: 8080 });
console.log("case-core listening on 8080");