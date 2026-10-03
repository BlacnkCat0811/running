import { useSyncExternalStore } from "react";

import { readApiToken, subscribeApiToken } from "./api.js";

export function useApiToken(): string {
  return useSyncExternalStore(subscribeApiToken, readApiToken, () => "");
}
