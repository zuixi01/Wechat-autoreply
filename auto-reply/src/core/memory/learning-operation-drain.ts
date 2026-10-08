/** Keep the original work (including late fee callbacks) alive until its owner can safely close. */
export class LearningOperationDrain {
  private readonly pending = new Set<Promise<unknown>>()
  track<T>(work: Promise<T>): Promise<T> {
    this.pending.add(work)
    void work.then(
      () => this.pending.delete(work),
      () => this.pending.delete(work)
    )
    return work
  }
  async drain(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending])
  }
}
