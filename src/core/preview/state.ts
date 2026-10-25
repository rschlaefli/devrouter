export type StateRecord<T> = { version: string; value: T };

export interface PreviewStateStore {
  read<T>(key: string, validate: (value: unknown) => T): Promise<StateRecord<T> | null>;
  compareAndSwap<T>(key: string, expectedVersion: string | null, value: T): Promise<string>;
}

export class PreviewStateConflict extends Error {
  constructor() {
    super("Preview state changed concurrently; re-read before retrying.");
    this.name = "PreviewStateConflict";
  }
}

export function validateStateKey(key: string): void {
  if (
    key.length === 0 ||
    key.length > 512 ||
    !/^[A-Za-z0-9/_-]+$/.test(key) ||
    key.split("/").some((segment) => segment.length === 0)
  )
    throw new Error("Preview state key must be a bounded relative namespace.");
}

export async function updatePreviewState<T>(options: {
  store: PreviewStateStore;
  key: string;
  validate: (value: unknown) => T;
  update: (current: T) => T;
}): Promise<StateRecord<T>> {
  validateStateKey(options.key);
  // The callback is pure: a conflict may evaluate it again, before any provider effect.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await options.store.read(options.key, options.validate);
    if (!current)
      throw new Error("Preview state is absent; explicit installation initialization is required.");
    const value = options.validate(options.update(current.value));
    try {
      const version = await options.store.compareAndSwap(options.key, current.version, value);
      return { value, version };
    } catch (error) {
      if (!(error instanceof PreviewStateConflict)) throw error;
      if (attempt === 3) throw error;
    }
  }
  throw new PreviewStateConflict();
}
