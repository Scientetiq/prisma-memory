// Only the browser transform imports this module. Text arrives with the server render, before any child hydrates.
export type ClientMessages = Readonly<Record<string, string>>;
const SLOT = "__memoryClientMessages";
const host = globalThis as unknown as Record<string, unknown>;

export function installClientMessages(messages: ClientMessages): void {
  if (typeof document === "undefined") return;
  const existing = (host[SLOT] ??= Object.create(null)) as Record<string, string>;
  Object.assign(existing, messages);
}

export function clientText(id: string): string {
  const value = (host[SLOT] as ClientMessages | undefined)?.[id];
  if (typeof value !== "string") throw new Error(`Missing client message: ${id}`);
  return value;
}

/** A lazy object shape: property getters read request data only when a consumer uses that property. */
export function clientCatalog<T extends object>(create: () => T, array: boolean): T {
  let value: T | undefined;
  const get = (): T => value ??= create();
  return new Proxy(array ? [] : {}, {
    get: (_target, key) => Reflect.get(get(), key),
    has: (_target, key) => Reflect.has(get(), key),
    ownKeys: () => Reflect.ownKeys(get()),
    getOwnPropertyDescriptor: (_target, key) => {
      const descriptor = Reflect.getOwnPropertyDescriptor(get(), key);
      if (!descriptor) return undefined;
      if (array && key === "length") return { ...descriptor, configurable: false };
      return { ...descriptor, configurable: true };
    },
  }) as T;
}

/** Local catalog constants are lazy too: another member's helper must not require unrelated request data. */
export function clientLocal<T>(cache: Map<string, unknown>, key: string, create: () => T): T {
  if (!cache.has(key)) cache.set(key, create());
  return cache.get(key) as T;
}
