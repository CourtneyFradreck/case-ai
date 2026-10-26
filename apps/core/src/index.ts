import { serve } from "@hono/node-server";
import { migrate } from "./db.js";
import { app } from "./app.js";

await migrate();

serve({ fetch: app.fetch, port: 8080 });
console.log("case-core listening on 8080");
