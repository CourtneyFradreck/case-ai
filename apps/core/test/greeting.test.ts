import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { render, renderModelBrief, type GreetingOptions } from "../src/render.js";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "Tuesday 13 Oct" };
const morning = DateTime.fromISO("2026-10-14T05:00:00Z");
const renderers: [string, (options: GreetingOptions) => string][] = [
  ["rules", (options) => render([], [], w, 3800, undefined, options)],
  ["model", (options) => renderModelBrief({ yesterday: [], attention: [], focus: [] }, [], w, 3800, options)],
];

describe.each(renderers)("%s greeting", (_, renderBrief) => {
  it("includes the configured name", () => {
    expect(renderBrief({ userName: "Courtney", now: morning }).split("\n")[0]).toBe("<b>Good morning, Courtney. Here's Tuesday 13 Oct.</b>");
  });
  it("HTML-escapes the name", () => {
    expect(renderBrief({ userName: "<Courtney> & friends", now: morning })).toContain("<b>Good morning, &lt;Courtney&gt; &amp; friends. Here's Tuesday 13 Oct.</b>");
  });
  it.each([undefined, "", "   "])("uses the unnamed greeting for %s", (userName) => {
    expect(renderBrief({ userName, now: morning }).split("\n")[0]).toBe("<b>Good morning. Here's Tuesday 13 Oct.</b>");
  });
  it.each([
    ["2026-10-14T09:59:59Z", "morning"],
    ["2026-10-14T10:00:00Z", "afternoon"],
    ["2026-10-14T15:59:59Z", "afternoon"],
    ["2026-10-14T16:00:00Z", "evening"],
    ["2026-10-14T22:00:00Z", "morning"],
  ])("uses Harare time at %s", (iso, greeting) => {
    expect(renderBrief({ userName: "Courtney", now: DateTime.fromISO(iso, { setZone: true }) }).split("\n")[0]).toBe(`<b>Good ${greeting}, Courtney. Here's Tuesday 13 Oct.</b>`);
  });
});
