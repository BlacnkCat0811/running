type EventTargetLike = Pick<EventTarget, "dispatchEvent">;

const MAX_NOTIFIED_JOBS = 200;

function rememberJob(notifiedJobs: Set<string>, jobId: string): boolean {
  if (notifiedJobs.has(jobId)) return false;
  if (notifiedJobs.size >= MAX_NOTIFIED_JOBS) {
    // Drop oldest insertion order entry (Set iterates in insertion order).
    const oldest = notifiedJobs.values().next().value;
    if (oldest !== undefined) notifiedJobs.delete(oldest);
  }
  notifiedJobs.add(jobId);
  return true;
}

export class JobEventNotifier {
  private readonly dataUpdateJobs = new Set<string>();
  private readonly databaseStateJobs = new Set<string>();

  constructor(private readonly target: EventTargetLike) {}

  notifyDataUpdated(jobId?: string): boolean {
    return this.dispatch("rai:data-updated", this.dataUpdateJobs, jobId);
  }

  notifyDatabaseStateChanged(jobId?: string): boolean {
    return this.dispatch(
      "rai:database-state-changed",
      this.databaseStateJobs,
      jobId,
    );
  }

  private dispatch(type: string, notifiedJobs: Set<string>, jobId?: string): boolean {
    if (jobId && !rememberJob(notifiedJobs, jobId)) return false;
    this.target.dispatchEvent(new Event(type));
    return true;
  }
}

let defaultNotifier: JobEventNotifier | null = null;

function notifier(): JobEventNotifier {
  defaultNotifier ??= new JobEventNotifier(window);
  return defaultNotifier;
}

export function notifyDataUpdated(jobId?: string): boolean {
  return notifier().notifyDataUpdated(jobId);
}

export function notifyDatabaseStateChanged(jobId?: string): boolean {
  return notifier().notifyDatabaseStateChanged(jobId);
}

const PRIVACY_ZONES_CHANGED = "rai:privacy-zones-changed";

export function notifyPrivacyZonesChanged(): void {
  window.dispatchEvent(new Event(PRIVACY_ZONES_CHANGED));
  try {
    localStorage.setItem(PRIVACY_ZONES_CHANGED, crypto.randomUUID());
  } catch {
    // Export still revalidates with the server when cross-tab storage is unavailable.
  }
}

export function subscribePrivacyZonesChanged(listener: () => void): () => void {
  const onStorage = (event: StorageEvent): void => {
    if (event.key === PRIVACY_ZONES_CHANGED) listener();
  };
  window.addEventListener(PRIVACY_ZONES_CHANGED, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PRIVACY_ZONES_CHANGED, listener);
    window.removeEventListener("storage", onStorage);
  };
}
