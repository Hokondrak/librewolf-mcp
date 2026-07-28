export interface RingBufferReadOptions {
  readonly limit?: number;
  readonly clear?: boolean;
}

export class RingBuffer<T> implements Iterable<T> {
  readonly #capacity: number;
  readonly #items: Array<T | undefined>;
  #head = 0;
  #size = 0;
  #dropped = 0;

  public constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0 || capacity > 1_000_000) {
      throw new RangeError('Ring buffer capacity must be between 1 and 1,000,000.');
    }
    this.#capacity = capacity;
    this.#items = new Array<T | undefined>(capacity);
  }

  public get capacity(): number {
    return this.#capacity;
  }

  public get size(): number {
    return this.#size;
  }

  public get droppedCount(): number {
    return this.#dropped;
  }

  public push(item: T): T | undefined {
    let evicted: T | undefined;
    if (this.#size === this.#capacity) {
      evicted = this.#items[this.#head];
      this.#dropped += 1;
    } else {
      this.#size += 1;
    }
    this.#items[this.#head] = item;
    this.#head = (this.#head + 1) % this.#capacity;
    return evicted;
  }

  public read(options: RingBufferReadOptions = {}): readonly T[] {
    const limit = options.limit ?? this.#size;
    if (!Number.isSafeInteger(limit) || limit < 0) {
      throw new RangeError('Ring buffer read limit must be a non-negative safe integer.');
    }
    const entries = this.toArray();
    const result = entries.slice(Math.max(0, entries.length - limit));
    if (options.clear === true) {
      this.clear();
    }
    return result;
  }

  public toArray(): T[] {
    const result: T[] = [];
    const start = (this.#head - this.#size + this.#capacity) % this.#capacity;
    for (let offset = 0; offset < this.#size; offset += 1) {
      const item = this.#items[(start + offset) % this.#capacity];
      // Occupancy is tracked by #size, so undefined is a valid T value.
      result.push(item as T);
    }
    return result;
  }

  public drain(): T[] {
    const result = this.toArray();
    this.clear();
    return result;
  }

  public clear(): void {
    this.#items.fill(undefined);
    this.#head = 0;
    this.#size = 0;
  }

  public *[Symbol.iterator](): Iterator<T> {
    yield* this.toArray();
  }
}
