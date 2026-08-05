export function linesFromInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/\r?\n/u)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function tagsFromInput(value: string): string[] {
  return [
    ...new Set(
      value
        .split(/[,，\s]+/u)
        .map((item) =>
          item
            .trim()
            .toLowerCase()
            .replace(/\s+/gu, "-")
            .replace(/[^a-z0-9_.-]/gu, ""),
        )
        .filter((item) => /^[a-z][a-z0-9_.-]*$/u.test(item)),
    ),
  ];
}

export function hoursToMinutes(value: string): number {
  return Math.round(Number(value) * 60);
}

export function minutesToHours(value: number): string {
  return String(Math.round((value / 60) * 100) / 100);
}

export function minuteToTime(value: number): string {
  const hours = Math.floor(value / 60);
  const minutes = value % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}
