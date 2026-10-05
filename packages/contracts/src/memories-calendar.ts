export const MEMORIES_ZONE = "Asia/Shanghai" as const;
export const MEMORIES_POLICY = "memories-v1" as const;
export type MemoriesKind = "ON_THIS_DAY" | "LAST_YEAR_WEEK";

const shanghai = new Intl.DateTimeFormat("en-CA", {
  timeZone: MEMORIES_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
function parts(instant: Date) {
  const fields = Object.fromEntries(
    shanghai.formatToParts(instant).map((p) => [p.type, p.value]),
  );
  return {
    year: Number(fields.year),
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour),
    minute: Number(fields.minute),
    second: Number(fields.second),
  };
}
export function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
function dateText(date: Date) {
  return date.toISOString().slice(0, 10);
}
export function parseMemoryDate(value: string) {
  if (!/^[1-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/.test(value))
    throw new Error("INVALID_MEMORY_DATE");
  const date = new Date(value + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || dateText(date) !== value)
    throw new Error("INVALID_MEMORY_DATE");
  return date;
}
export function memoryWeek(anchorDate: string) {
  const anchor = parseMemoryDate(anchorDate);
  const year = anchor.getUTCFullYear() - 1,
    month = anchor.getUTCMonth();
  const day =
    month === 1 && anchor.getUTCDate() === 29 && !isLeapYear(year)
      ? 28
      : anchor.getUTCDate();
  const prior = new Date(Date.UTC(year, month, day));
  const start = new Date(
    prior.getTime() - ((prior.getUTCDay() + 6) % 7) * 86_400_000,
  );
  return {
    weekStart: dateText(start),
    weekEnd: dateText(new Date(start.getTime() + 7 * 86_400_000)),
  };
}
export function memoriesCalendar(serverInstant: Date) {
  if (!Number.isFinite(serverInstant.getTime()))
    throw new Error("INVALID_SERVER_TIME");
  const p = parts(serverInstant);
  const anchorDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  parseMemoryDate(anchorDate);
  const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
  // Resolve the zone offset at the target, then verify the actual local midnight.
  let midnight = new Date(next.getTime());
  for (let i = 0; i < 3; i++) {
    const q = parts(midnight);
    const offset =
      Date.UTC(q.year, q.month - 1, q.day, q.hour, q.minute, q.second) -
      midnight.getTime();
    midnight = new Date(next.getTime() - offset);
  }
  const q = parts(midnight);
  if (
    q.hour !== 0 ||
    q.minute !== 0 ||
    q.second !== 0 ||
    Date.UTC(q.year, q.month - 1, q.day) !== next.getTime() ||
    midnight <= serverInstant
  )
    throw new Error("INVALID_MEMORY_MIDNIGHT");
  return {
    anchorDate,
    zone: MEMORIES_ZONE,
    policy: MEMORIES_POLICY,
    serverNow: serverInstant.toISOString(),
    nextMidnight: midnight.toISOString(),
    ...memoryWeek(anchorDate),
  };
}
export function matchesMemoryDate(
  kind: MemoriesKind,
  photoDate: string,
  anchorDate: string,
) {
  const photo = parseMemoryDate(photoDate),
    anchor = parseMemoryDate(anchorDate);
  if (kind === "ON_THIS_DAY")
    return (
      photo.getUTCFullYear() < anchor.getUTCFullYear() &&
      photoDate.slice(5) === anchorDate.slice(5)
    );
  const week = memoryWeek(anchorDate);
  return photoDate >= week.weekStart && photoDate < week.weekEnd;
}
