import { createDecipheriv, createCipheriv, createHash, randomBytes, scryptSync } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, open, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";

const MAGIC = Buffer.from("CULIUBK1", "ascii");
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = MAGIC.byteLength + SALT_BYTES + IV_BYTES;

function deriveKey(secret: string, salt: Buffer): Buffer {
  if (secret.length < 32)
    throw new Error("Backup encryption key must contain at least 32 characters.");
  return scryptSync(secret, salt, 32);
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filePath), hash);
  return hash.digest("hex");
}

export async function encryptFile(
  inputPath: string,
  outputPath: string,
  secret: string,
): Promise<void> {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
  const temporaryPath = `${outputPath}.partial`;
  const output = createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 });
  output.write(Buffer.concat([MAGIC, salt, iv]));
  try {
    await pipeline(createReadStream(inputPath), cipher, output);
    await appendFile(temporaryPath, cipher.getAuthTag());
    await rename(temporaryPath, outputPath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function decryptFile(
  inputPath: string,
  outputPath: string,
  secret: string,
): Promise<void> {
  const metadata = await stat(inputPath);
  if (metadata.size <= HEADER_BYTES + TAG_BYTES)
    throw new Error("Encrypted backup file is truncated.");

  const handle = await open(inputPath, "r");
  try {
    const header = Buffer.alloc(HEADER_BYTES);
    const tag = Buffer.alloc(TAG_BYTES);
    await handle.read(header, 0, header.byteLength, 0);
    await handle.read(tag, 0, tag.byteLength, metadata.size - TAG_BYTES);
    if (!header.subarray(0, MAGIC.byteLength).equals(MAGIC)) {
      throw new Error("Encrypted backup file has an invalid header.");
    }

    const salt = header.subarray(MAGIC.byteLength, MAGIC.byteLength + SALT_BYTES);
    const iv = header.subarray(MAGIC.byteLength + SALT_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(secret, salt), iv);
    decipher.setAuthTag(tag);
    const temporaryPath = `${outputPath}.partial`;
    try {
      await pipeline(
        createReadStream(inputPath, { start: HEADER_BYTES, end: metadata.size - TAG_BYTES - 1 }),
        decipher,
        createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      );
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw new Error("Backup decryption or authentication failed.", { cause: error });
    }
  } finally {
    await handle.close();
  }
}
