import type { RedactedStudentImport } from "./contracts.js";

const PHONE_PATTERN = /(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/gu;

export function redactParentPhones(text: string): RedactedStudentImport {
  const phoneTokens = new Map<string, string>();
  let ordinal = 0;
  const redacted = text.replace(PHONE_PATTERN, (phone) => {
    ordinal += 1;
    const token = `[PHONE_${String(ordinal)}]`;
    phoneTokens.set(token, phone.replace(/[-\s]/gu, "").replace(/^\+86/u, ""));
    return token;
  });
  return { phoneTokens, text: redacted };
}

export function restorePhoneToken(value: string, phoneTokens: ReadonlyMap<string, string>): string {
  if (!value.startsWith("[PHONE_")) return value;
  const phone = phoneTokens.get(value);
  if (phone === undefined) throw new Error("Model returned an unknown phone placeholder.");
  return phone;
}
