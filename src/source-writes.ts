import path from 'node:path';

export interface SourceWrite {
  readonly directory: string;
  matches(): Promise<boolean>;
}

type Observer = (writes: readonly SourceWrite[]) => () => Promise<void>;
const observers = new Map<string, Set<Observer>>();
const key = (project: string) => process.platform === 'win32' ? path.resolve(project).toLowerCase() : path.resolve(project);

/** Observe publication-owned source edits without turning them into watch inputs. */
export function observeSourceWrites(project: string, observer: Observer): () => void {
  const id = key(project);
  const listeners = observers.get(id) ?? new Set<Observer>();

  listeners.add(observer);
  observers.set(id, listeners);

  return () => {
    listeners.delete(observer);

    if (!listeners.size) {
      observers.delete(id);
    }
  };
}

/** Keep watcher baselines synchronized with an owned write and its rollback. */
export async function withSourceWrites<T>(project: string, writes: readonly SourceWrite[], write: () => Promise<T>): Promise<T> {
  const finish = [...observers.get(key(project)) ?? []].map(observer => observer(writes));

  try {
    return await write();
  } finally {
    for (const complete of finish) {
      await complete();
    }
  }
}
