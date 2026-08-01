import { createRequire } from "node:module";

import type { Options } from "@node-rs/argon2";

import { StrongPasswordSchema } from "./contracts.js";

const require = createRequire(import.meta.url);
interface Argon2Module {
  hash: (password: string | Uint8Array, options?: Options | null) => Promise<string>;
  verify: (
    passwordHash: string | Uint8Array,
    password: string | Uint8Array,
    options?: Options | null,
  ) => Promise<boolean>;
}
const { hash, verify } = require("@node-rs/argon2") as Argon2Module;

export const ARGON2ID_OPTIONS = Object.freeze({
  algorithm: 2,
  memoryCost: 65_536,
  outputLen: 32,
  parallelism: 1,
  timeCost: 3,
  version: 1,
} satisfies Options);

const DUMMY_PASSWORD = "TimingOnly!Credential2026";
const dummyHashPromise = hash(DUMMY_PASSWORD, ARGON2ID_OPTIONS);

export async function hashPassword(password: string): Promise<string> {
  return hash(StrongPasswordSchema.parse(password), ARGON2ID_OPTIONS);
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  if (password.length === 0 || password.length > 1024) {
    return false;
  }

  try {
    return await verify(passwordHash, password);
  } catch {
    return false;
  }
}

export async function getDummyPasswordHash(): Promise<string> {
  return dummyHashPromise;
}
