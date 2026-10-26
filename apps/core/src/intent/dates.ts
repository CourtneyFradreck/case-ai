import { DateTime } from "luxon";
import { ZONE } from "../time.js";

const MONTHS = "jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec";
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})\\s+(${MONTHS})[a-z]*\\b`, "i");
const MONTH_DAY = new RegExp(`\\b(${MONTHS})[a-z]*\\s+(\\d{1,2})\\b`, "i");
const ISO = /\b(\d{4})-(\d{2})-(\d{2})\b/;

// A date written in an item ("Mon 19 Oct", "Oct 19", "2026-10-19"), in Harare time. Without a year,
// the nearest one is used, so a December item read in January means last December.
export function itemDate(text: string, now: Date): DateTime | undefined {
  const today = DateTime.fromJSDate(now).setZone(ZONE).startOf("day");
  const iso = ISO.exec(text);
  if (iso) {
    const d = DateTime.fromObject({ year: +iso[1], month: +iso[2], day: +iso[3] }, { zone: ZONE });
    return d.isValid ? d : undefined;
  }
  const dm = DAY_MONTH.exec(text);
  const md = dm ? undefined : MONTH_DAY.exec(text);
  const [day, month] = dm ? [Number(dm[1]), dm[2]] : md ? [Number(md[2]), md[1]] : [];
  if (!day || !month) return;
  const m = MONTHS.split("|").indexOf(month.slice(0, 3).toLowerCase()) + 1;
  const dates = [-1, 0, 1].map((y) => DateTime.fromObject({ year: today.year + y, month: m, day }, { zone: ZONE })).filter((d) => d.isValid);
  return dates.sort((a, b) => Math.abs(a.diff(today).toMillis()) - Math.abs(b.diff(today).toMillis()))[0];
}

// Whether the item names a day before today.
export function datePassed(text: string, now: Date): boolean {
  const d = itemDate(text, now);
  return !!d && d < DateTime.fromJSDate(now).setZone(ZONE).startOf("day");
}
