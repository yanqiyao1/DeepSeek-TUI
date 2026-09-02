import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

/** Read a bounded regular file through the same descriptor that was validated. */
export function readBoundedRegularFileSync(path: string, maxBytes: number, label = "file"): string {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error(`${label} size limit is invalid`);
  try {
    const before = lstatSync(path);
    if (before.isSymbolicLink() || !before.isFile()) throw new Error(`${label} is not a regular file`);
  } catch (error: any) {
    if (error instanceof Error && error.message === `${label} is not a regular file`) throw error;
    throw error;
  }

  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error: any) {
    if (error?.code === "ELOOP") throw new Error(`${label} is not a regular file`);
    throw error;
  }

  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const buffer = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    return Buffer.concat(chunks, total).toString("utf-8");
  } finally {
    closeSync(fd);
  }
}
