export interface DatabaseFilePublisherOptions {
  candidatePath: string;
  targetPath: string;
  rollbackPath: string;
  targetExists: () => boolean;
  prepareOriginal: () => void | Promise<void>;
  moveFile: (source: string, destination: string) => Promise<void>;
  installCandidate?: (source: string, destination: string) => Promise<void>;
  validateInstalled?: () => boolean | Promise<boolean>;
  validationErrorMessage?: string;
  onOriginalMoved?: () => void;
}

export interface DatabaseFilePublication {
  originalExisted: boolean;
  originalMoved: boolean;
}

export async function publishDatabaseFile(
  options: DatabaseFilePublisherOptions
): Promise<DatabaseFilePublication> {
  const originalExisted = options.targetExists();
  let originalMoved = false;
  if (originalExisted) {
    await options.prepareOriginal();
    await options.moveFile(options.targetPath, options.rollbackPath);
    originalMoved = true;
    options.onOriginalMoved?.();
  }
  await (options.installCandidate ?? options.moveFile)(options.candidatePath, options.targetPath);
  if (options.validateInstalled && !await options.validateInstalled()) {
    throw new Error(options.validationErrorMessage ?? "Installed database candidate is not readable");
  }
  return { originalExisted, originalMoved };
}
