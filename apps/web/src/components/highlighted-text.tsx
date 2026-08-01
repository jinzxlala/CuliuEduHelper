import type { JSX } from "react";

import { splitHighlightedText } from "../lib/search-page-state";

export function HighlightedText({
  maxCharacters,
  value,
}: Readonly<{ maxCharacters?: number; value: string }>): JSX.Element {
  return (
    <>
      {splitHighlightedText(value, maxCharacters).map((part, index) =>
        part.highlighted ? (
          <mark key={`${String(index)}-${part.text}`}>{part.text}</mark>
        ) : (
          <span key={`${String(index)}-${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}
