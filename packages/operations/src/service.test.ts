import { REDACTED_FIXTURE_IDS } from "@culiu/database";
import { describe, expect, it } from "vitest";

import { validateEvidenceReferencesForBackup } from "./service.js";

const fixtureHash = "c".repeat(64);
const fixtureReference = {
  contentHash: fixtureHash,
  id: REDACTED_FIXTURE_IDS.evidenceObject,
  storageKey: `student/${REDACTED_FIXTURE_IDS.student}/cc/${fixtureHash}`,
};

describe("backup evidence completeness", () => {
  it("allows only the exact redacted development fixture gap and reports it", () => {
    expect(validateEvidenceReferencesForBackup([fixtureReference], [], true)).toBe(1);
  });

  it("refuses the redacted fixture gap in production mode", () => {
    expect(() => validateEvidenceReferencesForBackup([fixtureReference], [], false)).toThrow(
      /absent or corrupt/iu,
    );
  });

  it("refuses every other missing or corrupt evidence object", () => {
    expect(() =>
      validateEvidenceReferencesForBackup(
        [
          {
            contentHash: "a".repeat(64),
            id: crypto.randomUUID(),
            storageKey: `knowledge/aa/${"a".repeat(64)}`,
          },
        ],
        [],
        true,
      ),
    ).toThrow(/absent or corrupt/iu);
  });
});
