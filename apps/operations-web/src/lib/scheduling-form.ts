export interface GeneratedOccurrence {
  endTime: string;
  sessionDate: string;
  startTime: string;
}

export function timeToMinutes(value: string): number {
  const match = /^(\d{2}):(\d{2})$/u.exec(value);
  if (match === null) return Number.NaN;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return Number.NaN;
  return hours * 60 + minutes;
}

export function normalizeStableCode(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "");
}

export function normalizeTag(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

export function uniqueNonEmptyLines(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function weekdayForDate(value: Date): number {
  const weekday = value.getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function isoDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function generateWeeklyOccurrences(input: {
  endDate: string;
  endTime: string;
  startDate: string;
  startTime: string;
  weekday: number;
}): GeneratedOccurrence[] {
  if (
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.startDate) ||
    !/^\d{4}-\d{2}-\d{2}$/u.test(input.endDate)
  ) {
    return [];
  }
  if (
    input.weekday < 1 ||
    input.weekday > 7 ||
    input.endDate < input.startDate ||
    timeToMinutes(input.endTime) <= timeToMinutes(input.startTime)
  ) {
    return [];
  }
  const cursor = new Date(`${input.startDate}T12:00:00.000Z`);
  const end = new Date(`${input.endDate}T12:00:00.000Z`);
  const occurrences: GeneratedOccurrence[] = [];
  while (cursor <= end) {
    if (weekdayForDate(cursor) === input.weekday) {
      occurrences.push({
        endTime: input.endTime,
        sessionDate: isoDate(cursor),
        startTime: input.startTime,
      });
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return occurrences;
}
