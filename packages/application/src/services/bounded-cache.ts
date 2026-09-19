/** Run-local LRU, bounded by entries and sample count, not total history size. */
export class BoundedCache<T> {
  private readonly entries = new Map<string, { value: T; weight: number }>();
  private weight = 0;
  hits = 0;
  misses = 0;
  constructor(private readonly maxEntries: number, private readonly maxWeight: number) {}
  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) { this.misses++; return undefined; }
    this.hits++;
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: string, value: T, weight: number): void {
    const old = this.entries.get(key);
    if (old) { this.weight -= old.weight; this.entries.delete(key); }
    if (weight > this.maxWeight) return;
    while (this.entries.size && (this.entries.size >= this.maxEntries || this.weight + weight > this.maxWeight)) {
      const first = this.entries.keys().next().value!;
      this.weight -= this.entries.get(first)!.weight;
      this.entries.delete(first);
    }
    this.entries.set(key, { value, weight });
    this.weight += weight;
  }
  clear(): void { this.entries.clear(); this.weight = 0; this.hits = 0; this.misses = 0; }
}
