const TIMESTAMP_LINE_PATTERN =
  /^`?\[(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\s*-\s*(\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?)\]`?\s+/u;
const STRONG_CASE_PATTERN =
  /(?:这|那|有|一)(?:个|位|名)?(?:学生|同学|孩子)|我们(?:有|的).{0,12}(?:学生|同学)|案例|录取(?:到|了|结果|学生)|拿到.{0,16}(?:录取|offer)|被.{0,16}录取|转学/u;
const DETAIL_PATTERN = /研究|项目|活动|竞赛|专业|方向|课程|社团|论文|数据|实验|创业|志愿|公益/u;

interface EvidenceWindow {
  readonly end: number;
  readonly score: number;
  readonly start: number;
}

function mergeWindows(windows: readonly EvidenceWindow[]): EvidenceWindow[] {
  const merged: EvidenceWindow[] = [];
  for (const window of [...windows].sort((left, right) => left.start - right.start)) {
    const previous = merged.at(-1);
    if (previous !== undefined && window.start <= previous.end + 1) {
      merged[merged.length - 1] = {
        end: Math.max(previous.end, window.end),
        score: previous.score + window.score,
        start: previous.start,
      };
    } else {
      merged.push(window);
    }
  }
  return merged;
}

export function selectCaseEvidenceWindows(
  transcript: string,
  options: { readonly contextLines?: number; readonly maxCharacters?: number } = {},
): string {
  const lines = transcript
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .split("\n");
  const contextLines = options.contextLines ?? 24;
  const maxCharacters = options.maxCharacters ?? 90_000;
  const candidates: EvidenceWindow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!TIMESTAMP_LINE_PATTERN.test(line) || !STRONG_CASE_PATTERN.test(line)) continue;
    candidates.push({
      end: Math.min(lines.length - 1, index + contextLines),
      score: 1 + (DETAIL_PATTERN.test(line) ? 2 : 0),
      start: Math.max(0, index - contextLines),
    });
  }
  const windows = mergeWindows(candidates).sort(
    (left, right) => right.score - left.score || left.start - right.start,
  );
  const selected: EvidenceWindow[] = [];
  let used = 0;
  for (const window of windows) {
    const text = lines.slice(window.start, window.end + 1).join("\n");
    if (used + text.length > maxCharacters && selected.length > 0) continue;
    selected.push(window);
    used += text.length;
    if (used >= maxCharacters) break;
  }
  return selected
    .sort((left, right) => left.start - right.start)
    .map(
      (window, index) =>
        `<!-- 候选窗口 ${String(index + 1)}；原始行 ${String(window.start + 1)}-${String(window.end + 1)} -->\n${lines.slice(window.start, window.end + 1).join("\n")}`,
    )
    .join("\n\n[...不连续窗口之间已省略...]\n\n");
}
