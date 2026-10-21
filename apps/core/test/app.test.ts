import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ runBrief: vi.fn(), handleUpdate: vi.fn(), env: { apiKey: "k" } }));
vi.mock("../src/env.js", () => ({ env: mocks.env }));
vi.mock("../src/pipeline.js", () => ({ runBrief: mocks.runBrief, BusyError: class extends Error {} }));
vi.mock("../src/telegram-update.js", () => ({ handleUpdate: mocks.handleUpdate }));
import { app } from "../src/app.js";

const post = (path: string, body: string, key = "k") =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", "x-case-key": key }, body });

describe("HTTP routes", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the brief result, including delivered", async () => {
    mocks.runBrief.mockResolvedValue({ runId: 7, text: "Hi", delivered: true });
    const res = await post("/brief", JSON.stringify({ source: "schedule" }));
    expect(await res.json()).toEqual({ runId: 7, text: "Hi", delivered: true });
    expect(mocks.runBrief).toHaveBeenCalledWith("schedule");
  });
  it.each(["/brief", "/telegram/update"])("rejects %s without the API key", async (path) => {
    const res = await post(path, "{}", "wrong");
    expect(res.status).toBe(401);
    expect(mocks.runBrief).not.toHaveBeenCalled();
    expect(mocks.handleUpdate).not.toHaveBeenCalled();
  });
  it("replies 200 to an update without waiting for its handler", async () => {
    mocks.handleUpdate.mockReturnValue(new Promise(() => {}));
    const update = { update_id: 1, message: { message_id: 5, chat: { id: 42 }, text: "hi" } };
    const res = await post("/telegram/update", JSON.stringify(update));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.handleUpdate).toHaveBeenCalledWith(update);
  });
  it("logs a failed update handler instead of failing the request", async () => {
    mocks.handleUpdate.mockRejectedValue(new Error("boom"));
    expect((await post("/telegram/update", "{}")).status).toBe(200);
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledWith("telegram update failed", expect.any(Error)));
  });
  it.each(["not json", "[]", "null"])("rejects a body that isn't an update object (%s)", async (body) => {
    expect((await post("/telegram/update", body)).status).toBe(400);
    expect(mocks.handleUpdate).not.toHaveBeenCalled();
  });
});
