import { randomUUID } from "node:crypto";

export const appNow = (): string => new Date().toISOString();

export function opaqueId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
