import { rm, rename } from "node:fs/promises";

const TRANSIENT_WINDOWS_FILE_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

export async function retryTransientFileOperation(
  operation: () => Promise<void>,
  attempts = 20,
  delayMs = 100
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (!TRANSIENT_WINDOWS_FILE_CODES.has(code) || attempt === attempts - 1) {
        throw error;
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, delayMs));
    }
  }
}

export async function moveFileWithRetry(source: string, destination: string): Promise<void> {
  await retryTransientFileOperation(() => rename(source, destination));
}

export async function removeFileWithRetry(path: string): Promise<void> {
  await retryTransientFileOperation(() => rm(path, { force: true }));
}

export async function removeDatabaseFilesWithRetry(path: string): Promise<void> {
  for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
    await removeFileWithRetry(candidate);
  }
}
