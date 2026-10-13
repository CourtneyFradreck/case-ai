import { Hono } from "hono";
import { serve } from "@hono/node-server";

const app = new Hono();

app.use("/brief", async (c, next) => {
  if (c.req.header("x-case-key") !== process.env.CASE_API_KEY) {
    return c.json({ error: "unauthorized" }, 401);
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
app.post("/brief", (c) => c.json({ text: "Hello from CASE. Skeleton is alive." }));

serve({ fetch: app.fetch, port: 8080 });