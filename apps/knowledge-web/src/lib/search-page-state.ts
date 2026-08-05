import { SEARCH_HIGHLIGHT_END, SEARCH_HIGHLIGHT_START } from "@culiu/search";

export const SEARCH_PAGE_SIZE = 10;

export type SearchTarget = "lectures" | "cases" | "transcripts";
export type SearchMatchMode = "relaxed" | "all";
export type RawSearchParams = Record<string, string | string[] | undefined>;

export interface SearchPageState {
  aiDepth: string[];
  caseTypes: string[];
  confidence: Array<"high" | "medium" | "low" | "unknown">;
  curriculumSystems: string[];
  dateFrom?: string;
  dateTo?: string;
  lectureIds: string[];
  majors: string[];
  matchMode: SearchMatchMode;
  organizations: string[];
  page: number;
  query: string;
  schools: string[];
  sections: string[];
  sort?: "date:asc" | "date:desc" | "title:asc" | "title:desc";
  target: SearchTarget;
}

export interface HighlightPart {
  highlighted: boolean;
  text: string;
}

const confidenceValues = new Set(["high", "medium", "low", "unknown"]);
const lectureSortValues = new Set(["date:asc", "date:desc", "title:asc", "title:desc"]);

function firstValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function listValues(value: string | string[] | undefined): string[] {
  const values = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => item.trim()).filter(Boolean))].slice(0, 50);
}

function safeDate(value: string | undefined): string | undefined {
  if (value === undefined || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return undefined;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value
    ? undefined
    : value;
}

export function parseSearchPageState(params: RawSearchParams): SearchPageState {
  const requestedTarget = firstValue(params.type);
  const target: SearchTarget =
    requestedTarget === "cases" || requestedTarget === "transcripts" ? requestedTarget : "lectures";
  const requestedPage = Number.parseInt(firstValue(params.page) ?? "1", 10);
  const page = Number.isSafeInteger(requestedPage)
    ? Math.min(Math.max(requestedPage, 1), 1_001)
    : 1;
  const requestedSort = firstValue(params.sort);
  const sort =
    target === "lectures" && requestedSort !== undefined && lectureSortValues.has(requestedSort)
      ? (requestedSort as SearchPageState["sort"])
      : undefined;
  let dateFrom = safeDate(firstValue(params.from));
  let dateTo = safeDate(firstValue(params.to));
  if (dateFrom !== undefined && dateTo !== undefined && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }

  return {
    aiDepth: listValues(params.aiDepth),
    caseTypes: listValues(params.caseType),
    confidence: listValues(params.confidence).filter((value) =>
      confidenceValues.has(value),
    ) as SearchPageState["confidence"],
    curriculumSystems: listValues(params.curriculum),
    ...(dateFrom === undefined ? {} : { dateFrom }),
    ...(dateTo === undefined ? {} : { dateTo }),
    lectureIds: listValues(params.lecture),
    majors: listValues(params.major),
    matchMode: firstValue(params.match) === "all" ? "all" : "relaxed",
    organizations: listValues(params.organization),
    page,
    query: (firstValue(params.q) ?? "").trim().slice(0, 500),
    schools: listValues(params.school),
    sections: listValues(params.section),
    ...(sort === undefined ? {} : { sort }),
    target,
  };
}

export function searchStateToParams(state: SearchPageState): URLSearchParams {
  const params = new URLSearchParams();
  if (state.target !== "lectures") params.set("type", state.target);
  if (state.query !== "") params.set("q", state.query);
  if (state.matchMode === "all") params.set("match", "all");
  if (state.page > 1) params.set("page", String(state.page));
  if (state.sort !== undefined) params.set("sort", state.sort);
  if (state.dateFrom !== undefined) params.set("from", state.dateFrom);
  if (state.dateTo !== undefined) params.set("to", state.dateTo);

  const append = (name: string, values: readonly string[]): void => {
    for (const value of values) params.append(name, value);
  };
  append("school", state.schools);
  append("major", state.majors);
  append("organization", state.organizations);
  append("caseType", state.caseTypes);
  append("curriculum", state.curriculumSystems);
  append("aiDepth", state.aiDepth);
  append("confidence", state.confidence);
  append("lecture", state.lectureIds);
  append("section", state.sections);
  return params;
}

export function buildSearchHref(
  state: SearchPageState,
  changes: Partial<Pick<SearchPageState, "page" | "target">>,
): string {
  const target = changes.target ?? state.target;
  const changedTarget = target !== state.target;
  const base = changedTarget
    ? parseSearchPageState({
        match: state.matchMode === "all" ? "all" : undefined,
        q: state.query,
        type: target,
      })
    : state;
  const next: SearchPageState = {
    ...base,
    page: changes.page ?? (changedTarget ? 1 : state.page),
    target,
  };
  const query = searchStateToParams(next).toString();
  return query === "" ? "/search" : `/search?${query}`;
}

export function splitHighlightedText(value: string, maxCharacters = 260): HighlightPart[] {
  const parts: HighlightPart[] = [];
  let highlighted = false;
  let buffer = "";
  let visibleCharacters = 0;
  let truncated = false;

  const flush = (): void => {
    if (buffer === "") return;
    parts.push({ highlighted, text: buffer });
    buffer = "";
  };

  for (const character of value) {
    if (character === SEARCH_HIGHLIGHT_START || character === SEARCH_HIGHLIGHT_END) {
      flush();
      highlighted = character === SEARCH_HIGHLIGHT_START;
      continue;
    }
    if (visibleCharacters >= maxCharacters) {
      truncated = true;
      break;
    }
    buffer += character;
    visibleCharacters += 1;
  }
  flush();
  if (truncated) parts.push({ highlighted: false, text: "…" });
  return parts;
}

export function formatTimestamp(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainingSeconds = rounded % 60;
  const base = `${String(minutes).padStart(2, "0")}:${String(remainingSeconds).padStart(2, "0")}`;
  return hours === 0 ? base : `${String(hours).padStart(2, "0")}:${base}`;
}
