export interface RememberedLive {
  token: string;
  episodeId: string;
  sessionId: string;
}
/** Secure, installation-local lease journal. Never closes another device's session. */
export class LiveSessionJournal {
  private queue = Promise.resolve();
  constructor(
    private storage: {
      read(): Promise<string | null>;
      write(value: string): Promise<void>;
      remove(): Promise<void>;
    },
  ) {}
  private serial(run: () => Promise<void>) {
    const next = this.queue.catch(() => {}).then(run);
    this.queue = next;
    return next;
  }
  private async read() {
    const raw = await this.storage.read();
    if (!raw) return;
    try {
      const value = JSON.parse(raw) as RememberedLive;
      if (
        [value.token, value.episodeId, value.sessionId].every(
          (s) => typeof s === "string" && s.length > 0,
        )
      )
        return value;
    } catch {
      /* An invalid journal has no authority over a remote session. */
    }
  }
  remember(value: RememberedLive) {
    return this.serial(() => this.storage.write(JSON.stringify(value)));
  }
  forget(token: string, sessionId?: string) {
    return this.serial(async () => {
      const old = await this.read();
      if (
        old?.token === token &&
        (sessionId === undefined || old.sessionId === sessionId)
      )
        await this.storage.remove();
    });
  }
  recover(token: string, close: (value: RememberedLive) => Promise<void>) {
    return this.serial(async () => {
      const old = await this.read();
      if (old?.token !== token) return;
      await close(old);
      await this.storage.remove();
    });
  }
}
