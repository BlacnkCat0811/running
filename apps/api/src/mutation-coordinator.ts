export class MutationConflictError extends Error {
  readonly statusCode = 409;
  // 缺 code 会退化成通用 "request_error"，客户端无法与其它 409 区分。
  readonly code = "mutation_conflict";

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
