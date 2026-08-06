export const MAX_TRANSCRIPT_BATCH_FILES = 20;
export const TRANSCRIPT_BATCH_CONCURRENCY = 3;

export type TranscriptBatchItemResult<TItem, TValue> =
  | { index: number; item: TItem; status: "fulfilled"; value: TValue }
  | { error: unknown; index: number; item: TItem; status: "rejected" };

export async function runTranscriptImportBatch<TItem, TValue>(
  items: readonly TItem[],
  submit: (item: TItem, index: number) => Promise<TValue>,
  callbacks: Readonly<{
    onSettled?: (result: TranscriptBatchItemResult<TItem, TValue>) => void;
    onStart?: (item: TItem, index: number) => void;
  }> = {},
): Promise<readonly TranscriptBatchItemResult<TItem, TValue>[]> {
  if (items.length === 0) throw new RangeError("At least one transcript file is required.");
  if (items.length > MAX_TRANSCRIPT_BATCH_FILES) {
    throw new RangeError(`At most ${String(MAX_TRANSCRIPT_BATCH_FILES)} files may be submitted.`);
  }

  const results = new Array<TranscriptBatchItemResult<TItem, TValue>>(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) continue;
      callbacks.onStart?.(item, index);
      let result: TranscriptBatchItemResult<TItem, TValue>;
      try {
        result = { index, item, status: "fulfilled", value: await submit(item, index) };
      } catch (error) {
        result = { error, index, item, status: "rejected" };
      }
      results[index] = result;
      callbacks.onSettled?.(result);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(TRANSCRIPT_BATCH_CONCURRENCY, items.length) }, async () =>
      worker(),
    ),
  );
  return results;
}
