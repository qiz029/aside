/** Structured artifacts live in D1; R2 is reserved for audio bytes. */
export class Records {
  constructor(private db: D1Database) {}
  async list<T>(prefix: string): Promise<Map<string, T>> {
    const { results } = await this.db.prepare(
      "SELECT key,value FROM artifacts WHERE key>=? AND key<? ORDER BY key,part",
    ).bind(prefix, prefix + "\uffff").all<{ key: string; value: string }>();
    const records = new Map<string, string>();
    for (const row of results) records.set(row.key, (records.get(row.key) ?? "") + row.value);
    return new Map([...records].map(([key, value]) => [key, JSON.parse(value) as T]));
  }
  async has(key: string) {
    return !!(await this.db
      .prepare("SELECT key FROM artifacts WHERE key=? LIMIT 1")
      .bind(key)
      .first());
  }
  async get<T>(key: string): Promise<T | undefined> {
    const { results } = await this.db
      .prepare("SELECT value FROM artifacts WHERE key=? ORDER BY part")
      .bind(key)
      .all<{ value: string }>();
    return results.length
      ? (JSON.parse(results.map((row) => row.value).join("")) as T)
      : undefined;
  }
  async put(key: string, value: unknown) {
    const json = JSON.stringify(value),
      statements = [
        this.db.prepare("DELETE FROM artifacts WHERE key=?").bind(key),
      ];
    let part = 0;
    for (let at = 0; at < json.length;) {
      let end = Math.min(at + 64000, json.length);
      const code = json.charCodeAt(end - 1);
      if (end < json.length && code >= 0xd800 && code <= 0xdbff) end--;
      statements.push(
        this.db
          .prepare("INSERT INTO artifacts VALUES(?,?,?)")
          .bind(key, part++, json.slice(at, end)),
      );
      at = end;
    }
    if (part > 250) throw Error("Structured artifact exceeds storage limit");
    await this.db.batch(statements);
  }
}
