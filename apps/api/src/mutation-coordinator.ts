export class MutationConflictError extends Error {
  readonly statusCode = 409;

  constructor(readonly activeOperation: string) {
    super(`另一项写操作正在执行：${activeOperation}`);
  }
}

export class MutationCoordinator {
  private activeOperation: string | null = null;

  acquire(operation: string): () => void {
    if (this.activeOperation !== null) {
      throw new MutationConflictError(this.activeOperation);
    }
    this.activeOperation = operation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeOperation = null;
    };
  }
}
