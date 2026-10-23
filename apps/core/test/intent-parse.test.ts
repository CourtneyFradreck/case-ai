import { describe, expect, it } from "vitest";
import { parseNext } from "../src/intent/parse.js";

const parse = (md: string) => parseNext("me/demo", md);
const idOf = (md: string, text: string) => parse(md).find((i) => i.text === text)?.id;

describe("parseNext", () => {
  it("returns no items for an empty file", () => {
    expect(parse("")).toEqual([]);
  });

  it("sets sections from headings, with null before any heading", () => {
    const items = parse(["- [ ] Loose", "# One", "- [ ] First", "###### Six ##", "- [ ] Deep", "## Two", "- [ ] Second"].join("\n"));
    expect(items.map((i) => [i.text, i.section])).toEqual([
      ["Loose", null], ["First", "One"], ["Deep", "Six"], ["Second", "Two"],
    ]);
  });

  it("reads open, done, star-bullet and indented items with 1-based lines", () => {
    const items = parse(["# Work", "- [ ] Open", "- [x] Done lower", "- [X] Done upper", "* [ ] Star", "    - [ ] Indented", "\t* [x] Tabbed"].join("\n"));
    expect(items.map((i) => [i.text, i.state, i.line])).toEqual([
      ["Open", "open", 2], ["Done lower", "done", 3], ["Done upper", "done", 4],
      ["Star", "open", 5], ["Indented", "open", 6], ["Tabbed", "done", 7],
    ]);
  });

  it("ignores other lines and items inside code fences", () => {
    const md = ["Some prose", "- plain bullet", "- [] not a box", "```md", "- [ ] Fenced", "# Not a heading", "```", "- [ ] After"].join("\n");
    expect(parse(md).map((i) => [i.text, i.section])).toEqual([["After", null]]);
  });

  it("gives the same result for CRLF and LF", () => {
    const lines = ["# One", "- [ ] First", "```", "- [ ] Fenced", "```", "- [x] Second"];
    expect(parse(lines.join("\r\n"))).toEqual(parse(lines.join("\n")));
    expect(parse(lines.join("\r\n")).map((i) => i.text)).toEqual(["First", "Second"]);
  });

  describe("IDs", () => {
    const base = ["# Now", "- [ ] Ship the parser", "- [ ] Write docs"].join("\n");
    const id = idOf(base, "Ship the parser")!;

    it("are 10 hex chars", () => {
      expect(id).toMatch(/^[0-9a-f]{10}$/);
    });
    it("are unchanged when lines are reordered", () => {
      expect(idOf(["# Now", "- [ ] Write docs", "- [ ] Ship the parser"].join("\n"), "Ship the parser")).toBe(id);
    });
    it("are unchanged when an item moves to another section or is ticked", () => {
      expect(idOf(["# Now", "- [ ] Write docs", "## Done", "- [x] Ship the parser"].join("\n"), "Ship the parser")).toBe(id);
    });
    it("change when the text is edited", () => {
      expect(idOf("- [ ] Ship the new parser", "Ship the new parser")).not.toBe(id);
    });
    it("are unchanged by case, extra spaces or a trailing period", () => {
      const items = parse(["- [ ]   SHIP  the   Parser.  ", "- [ ] Write docs"].join("\n"));
      expect(items[0].id).toBe(id);
      expect(items[0].text).toBe("SHIP  the   Parser.");
    });
    it("depend on the repo", () => {
      expect(parseNext("me/other", base)[0].id).not.toBe(id);
    });
  });

  it("keeps the first of duplicate items", () => {
    const items = parse(["# A", "- [ ] Same item", "# B", "- [x] same item.", "- [ ] Other"].join("\n"));
    expect(items.map((i) => [i.text, i.section, i.state])).toEqual([["Same item", "A", "open"], ["Other", "B", "open"]]);
  });

  it("cuts text over 200 chars", () => {
    const long = "x".repeat(250);
    const [item] = parse(`- [ ] ${long}`);
    expect(item.text).toBe("x".repeat(200));
  });
  it("reads an after: marker without making it part of the text or ID", () => {
    const [a, b] = parseNext("me/demo", "- [ ] Write the post\n- [ ] After: Publish it");
    expect(a.after).toBeUndefined();
    expect(b).toMatchObject({ text: "Publish it", after: true, id: parseNext("me/demo", "- [ ] Publish it")[0].id });
  });
});
