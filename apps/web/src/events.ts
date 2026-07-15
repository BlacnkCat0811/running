type EventTargetLike = Pick<EventTarget, "dispatchEvent">;

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
    if (jobId) {
      if (notifiedJobs.has(jobId)) return false;
      notifiedJobs.add(jobId);
    }
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
