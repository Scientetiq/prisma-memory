import type pg from "pg";

export class LockConnectionLost extends Error {
  constructor() {
    super("lock_connection_lost");
    this.name = "LockConnectionLost";
  }
}

export function watchLock(client: pg.PoolClient): { alive(): Promise<void>; lost(): boolean; done(): void } {
  let broken = false;
  const onError = () => { broken = true; };
  client.on("error", onError);

  return {
    async alive() {
      if (!broken) {
        try { await client.query("SELECT 1"); }
        catch { broken = true; }
      }
      if (broken) throw new LockConnectionLost();
    },
    lost: () => broken,
    done: () => { client.off("error", onError); },
  };
}
