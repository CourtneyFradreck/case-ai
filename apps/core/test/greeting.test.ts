import { describe, expect, it } from "vitest";
import { DateTime } from "luxon";
import { opening, render, renderModelBrief, type GreetingOptions } from "../src/render.js";
import { finding } from "./fixtures.js";

const w = { start: new Date("2026-10-12T22:00:00Z"), end: new Date("2026-10-13T22:00:00Z"), label: "Tuesday 13 Oct" };
const morning = DateTime.fromISO("2026-10-14T05:00:00Z");
const renderers: [string, (options: GreetingOptions) => string][] = [
  ["rules", (options) => render([], [], w, 3800, undefined, options)],
  ["model", (options) => renderModelBrief({ yesterday: [], attention: [], focus: [] }, [], w, 3800, options)],
];

describe.each(renderers)("%s greeting", (_, renderBrief) => {
  it("includes the configured name", () => {
    expect(renderBrief({ userName: "Courtney", now: morning }).split("\n").slice(0, 2)).toEqual(["<b>Good morning, Courtney.</b>", "Wednesday, 14 Oct 2026"]);
  });
  it("HTML-escapes the name", () => {
    expect(renderBrief({ userName: "<Courtney> & friends", now: morning })).toContain("<b>Good morning, &lt;Courtney&gt; &amp; friends.</b>");
  });
  it.each([undefined, "", "   "])("uses the unnamed greeting for %s", (userName) => {
    expect(renderBrief({ userName, now: morning }).split("\n")[0]).toBe("<b>Good morning.</b>");
  });
  it.each([
    ["2026-10-14T09:59:59Z", "Good morning"],
    ["2026-10-14T10:00:00Z", "Good afternoon"],
    ["2026-10-14T15:59:59Z", "Good afternoon"],
    ["2026-10-14T16:00:00Z", "Good evening"],
    ["2026-10-14T21:59:59Z", "Good evening"],
    ["2026-10-14T22:00:00Z", "Good morning"],
  ])("uses Harare time at %s", (iso, greeting) => {
    expect(renderBrief({ userName: "Courtney", now: DateTime.fromISO(iso, { setZone: true }) }).split("\n")[0]).toBe(`<b>${greeting}, Courtney.</b>`);
  });
  it("greets by the Harare time of day, with or without a name", () => {
    expect(renderBrief({ now: DateTime.fromISO("2026-10-14T09:59:59Z") }).split("\n")[0]).toBe("<b>Good morning.</b>");
    expect(renderBrief({ now: DateTime.fromISO("2026-10-14T10:00:00Z") }).split("\n")[0]).toBe("<b>Good afternoon.</b>");
  });
  it.each([
    ["2026-10-15T21:59:59Z", "Thursday, 15 Oct 2026"],
    ["2026-10-15T22:00:00Z", "Friday, 16 Oct 2026"],
    ["2026-10-15T23:59:59Z", "Friday, 16 Oct 2026"],
  ])("dates the header using today's Harare date at %s", (iso, date) => {
    const lines = renderBrief({ userName: "Courtney", now: DateTime.fromISO(iso, { setZone: true }) }).split("\n");
    expect(lines[1]).toBe(date);
    expect(lines.slice(0, 2).join("\n")).not.toContain(w.label);
  });
});

describe("opening sentence", () => {
  const y = { start: new Date("2026-10-21T22:00:00Z"), end: new Date("2026-10-22T22:00:00Z"), label: "yesterday" };
  const commits = (repo: string, branch: string, count: number) => finding({ id: `${repo}-${branch}`, repo, rule: "commits", severity: "info",
    summary: `${count} commits on ${branch} in ${repo}`, activity: { kind: "commits", count, branch, messages: [] } });
  const merged = finding({ id: "pr", rule: "merged_pr", severity: "info", activity: { kind: "pr", action: "Merged", number: 3, title: "M2" } });

  it("sums up a big day by its busiest repo and branch", () => {
    expect(opening([commits("me/case-ai", "feat/m3-intent", 12)], y)).toBe("Big case-ai day yesterday: 12 commits on feat/m3-intent.");
    expect(opening([commits("me/case-ai", "feat/m2", 15), commits("me/case-ai", "main", 1), commits("me/taga", "main", 2), merged], y))
      .toBe("Big case-ai day yesterday: 16 commits, most on feat/m2, and 2 elsewhere, and a PR merged.");
    expect(opening([commits("me/case-ai", "feat/m3-intent", 12)], { ...y, label: "over the weekend" })).toBe("Big case-ai weekend: 12 commits on feat/m3-intent.");
    expect(opening([commits("me/case-ai", "feat/m3-intent", 12)], { ...y, label: "on Friday" })).toBe("Big case-ai Friday: 12 commits on feat/m3-intent.");
  });
  it("says smaller days plainly, without '1 commit'", () => {
    expect(opening([commits("me/demo", "main", 1)], y)).toBe("Quiet day yesterday: one commit in demo.");
    expect(opening([commits("me/demo", "main", 4), commits("me/taga", "main", 1)], y)).toBe("Steady day yesterday: 4 commits in demo and 1 elsewhere.");
    expect(opening([merged], y)).toBe("No commits yesterday, but a PR merged.");
  });
  it("is left out when there was no activity, and sits under the date in both renderers", () => {
    expect(opening([], y)).toBeUndefined();
    expect(opening([commits("me/demo", "main", 4)], { ...y, label: "" })).toBeUndefined();
    const f = commits("me/case-ai", "feat/m3-intent", 12);
    for (const text of [render([f], [], y, 3800, undefined, { now: morning }), renderModelBrief({ yesterday: [{ text: f.summary, sources: [f] }], attention: [], focus: [] }, [], y, 3800, { now: morning })]) {
      expect(text.split("\n").slice(0, 6)).toEqual(["<b>Good morning.</b>", "Wednesday, 14 Oct 2026", "", "Big case-ai day yesterday: 12 commits on feat/m3-intent.", "", "<b>Yesterday</b>"]);
      expect(text).not.toContain("Here's");
    }
  });
});
