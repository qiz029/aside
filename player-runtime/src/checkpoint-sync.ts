import type { Checkpoint } from "@aside/engine/contracts";
export interface CheckpointStore {
  read(id: string): Promise<Checkpoint | null>;
  write(id: string, value: Checkpoint): Promise<Checkpoint>;
  cache?(id: string, value: Checkpoint): Promise<void>;
}
export class CheckpointConflict extends Error {
  constructor() {
    super("其他设备已更新收听进度");
  }
}
const contents = (value: Checkpoint | null) =>
  value
    ? JSON.stringify({
        positionMs: value.positionMs,
        resumeMs: value.resumeMs,
        history: value.history,
      })
    : "";
/** One serialized writer per player. A conflict never becomes an unconditional overwrite. */
export class CheckpointSync {
  private id = "";
  private version = 0;
  private saved = "";
  private generation = 0;
  private pending = Promise.resolve();
  conflict: Checkpoint | null | undefined;
  constructor(
    private store: CheckpointStore,
    private changed: () => void = () => {},
  ) {}
  reset() {
    this.id = "";
    this.generation++;
    this.version = 0;
    this.saved = "";
    this.conflict = undefined;
    this.changed();
  }
  async load(id: string) {
    this.reset();
    this.id = id;
    const generation = this.generation;
    const value = await this.store.read(id);
    if (generation !== this.generation) return null;
    this.version = value?.version ?? 0;
    this.saved = contents(value);
    return value;
  }
  async refresh() {
    if (!this.id) return undefined;
    const generation = this.generation,
      version = this.version,
      remote = await this.store.read(this.id);
    if (generation !== this.generation || version !== this.version)
      return undefined;
    if ((remote?.version ?? 0) !== this.version) {
      this.conflict = remote;
      this.changed();
    }
    return remote;
  }
  save(value: Checkpoint) {
    const generation = this.generation,
      id = this.id;
    const operation = async () => {
      if (!id || generation !== this.generation) return;
      await this.store.cache?.(id, value);
      if (generation !== this.generation) return;
      if (this.conflict !== undefined || contents(value) === this.saved) return;
      try {
        const written = await this.store.write(id, {
          ...value,
          version: this.version,
        });
        if (generation !== this.generation) return;
        this.version = written.version ?? this.version;
        this.saved = contents(value);
      } catch (error) {
        if (error instanceof CheckpointConflict) {
          const remote = await this.store.read(id);
          if (generation === this.generation) {
            this.conflict = remote;
            this.changed();
          }
        } else throw error;
      }
    };
    const result = this.pending.catch(() => {}).then(operation);
    this.pending = result;
    return result;
  }
  async keepLocal(value: Checkpoint) {
    if (this.conflict === undefined) return;
    this.generation++;
    this.version = this.conflict?.version ?? 0;
    this.conflict = undefined;
    this.saved = "";
    this.changed();
    await this.save(value);
  }
  useRemote() {
    const remote = this.conflict;
    if (remote === undefined) return undefined;
    this.generation++;
    this.version = remote?.version ?? 0;
    this.saved = contents(remote);
    this.conflict = undefined;
    this.changed();
    return remote;
  }
}
