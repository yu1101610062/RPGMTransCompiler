import { createHash } from "node:crypto";
import fs from "node:fs";

export function sha256Text(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes === 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

export function shortHash(input: string): string {
  return sha256Text(input).slice(0, 12);
}
