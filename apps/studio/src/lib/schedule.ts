// Schedules in words, and the blank ones the form starts from. The agent
// reads `schedules.json` (docs/schedules.md); Studio only writes it.
import type { ScheduleWhen } from "./api";
import { t } from "./i18n";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Day = (typeof DAYS)[number];
export type WhenKind = ScheduleWhen["kind"];
export const KINDS: WhenKind[] = ["daily", "monthly", "every", "once", "fileAdded", "mailReceived"];

/** What a new schedule of `kind` starts as. */
export function blankWhen(kind: WhenKind, now = new Date()): ScheduleWhen {
  switch (kind) {
    case "daily":
      return { kind, at: "08:00", days: [] };
    case "monthly":
      return { kind, day: 1, at: "09:00" };
    case "every":
      return { kind, minutes: 30, from: "09:00", to: "18:00", days: ["mon", "tue", "wed", "thu", "fri"] };
    case "once": {
      const d = new Date(now.getTime() + 60 * 60 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      return { kind, at: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:00` };
    }
    case "fileAdded":
      return { kind, folder: "input", pattern: "*" };
    case "mailReceived":
      return { kind, minutes: 5 };
  }
}

/** "8:00" and "08:00" are times; "8" and "25:00" are not. */
export function isTime(text: string | undefined): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text?.trim() ?? "");
  return !!m && Number(m[1]) < 24 && Number(m[2]) < 60;
}

/** Why the agent would refuse it, in the person's words; null when it is fine. */
export function whenProblem(when: ScheduleWhen): string | null {
  switch (when.kind) {
    case "daily":
    case "monthly":
      return isTime(when.at) ? null : t.runs.at;
    case "every":
      if (!Number.isInteger(when.minutes) || when.minutes < 1) return t.runs.minutes;
      return [when.from, when.to].every((x) => !x || isTime(x)) ? null : t.runs.between;
    case "once":
      return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(when.at) ? null : t.runs.onceAt;
    case "fileAdded":
      return when.folder.trim() ? null : t.runs.folder;
    case "mailReceived":
      if (when.minutes !== undefined && (!Number.isInteger(when.minutes) || when.minutes < 1)) return t.runs.minutes;
      return when.via === "microsoft365" && !when.account?.secret.trim() ? t.runs.mailAccount : null;
  }
}

const JA_DAYS: Record<string, Day> = { 月: "mon", 火: "tue", 水: "wed", 木: "thu", 金: "fri", 土: "sat", 日: "sun" };

/** The days as the agent reads them ("月", "Mon", "mon" are all Monday), in
 * one spelling; ones it does not know are dropped, as it ignores them. */
export function normalizeDays(days: string[] | undefined): Day[] {
  const out = new Set<Day>();
  for (const raw of days ?? []) {
    const d = raw.trim().toLowerCase();
    const day = (DAYS as readonly string[]).includes(d) ? (d as Day) : JA_DAYS[d];
    if (day) out.add(day);
  }
  return DAYS.filter((d) => out.has(d));
}

function dayList(days: string[] | undefined): string {
  const names = t.runs.dayNames as Record<string, string>;
  const on = normalizeDays(days);
  return DAYS.filter((d) => on.includes(d))
    .map((d) => names[d])
    .join(t.runs.describe.daysJoin);
}

/** "毎週 月・水 の 08:00", "毎月 月末 の 18:00"… */
export function describeWhen(when: ScheduleWhen): string {
  const w = t.runs.describe;
  switch (when.kind) {
    case "daily":
      return w.daily(when.at, dayList(when.days)) + (when.skipHolidays ? w.skipHolidays : "");
    case "monthly": {
      const day = when.businessDay
        ? when.day === -1
          ? t.runs.lastBusinessDay
          : w.businessDay(when.day)
        : when.day === -1
          ? t.runs.lastDay
          : w.day(when.day);
      return w.monthly(day, when.at) + (when.onHoliday && !when.businessDay ? w.onHoliday[when.onHoliday] : "");
    }
    case "every": {
      const between = when.from || when.to ? w.between(when.from ?? "", when.to ?? "") : "";
      return w.every(when.minutes, between, dayList(when.days)) + (when.skipHolidays ? w.skipHolidays : "");
    }
    case "once":
      return w.once(when.at.replace("T", " "));
    case "fileAdded":
      return w.fileAdded(when.folder, when.pattern || "*");
    case "mailReceived": {
      const filters = [when.subjectContains && w.subject(when.subjectContains), when.fromContains && w.from(when.fromContains)]
        .filter(Boolean)
        .join(w.daysJoin);
      return w.mailReceived(when.folder || t.runs.inbox, filters, when.minutes ?? 5);
    }
  }
}

/** The agent's local times ("2026-11-07T08:00:00+09:00") as "11/7 08:00". */
export function shortTime(text: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(text);
  if (!m) return text;
  return `${Number(m[2])}/${Number(m[3])} ${m[4]}`;
}
