import type { ConversionEngine, EngineId } from "./engine.ts";

const ENGINE_ID = /^[a-z][a-z0-9_-]{0,31}$/u;

export class EngineConfigurationError extends Error {
  constructor(
    readonly code: "engine_not_registered" | "engine_already_registered" | "invalid_engine_id",
    readonly engineId: EngineId,
  ) {
    super(`${code}: ${engineId}`);
    this.name = "EngineConfigurationError";
  }
}

export function assertEngineId(id: string): void {
  if (!ENGINE_ID.test(id)) throw new EngineConfigurationError("invalid_engine_id", id);
}

export class EngineRegistry {
  private readonly engines = new Map<EngineId, ConversionEngine>();

  register(engine: ConversionEngine): void {
    const { id } = engine;
    assertEngineId(id);
    if (this.engines.has(id)) throw new EngineConfigurationError("engine_already_registered", id);
    this.engines.set(id, engine);
  }

  get(id: EngineId): ConversionEngine {
    const engine = this.engines.get(id);
    if (!engine) throw new EngineConfigurationError("engine_not_registered", id);
    return engine;
  }

  has(id: EngineId): boolean {
    return this.engines.has(id);
  }

  ids(): EngineId[] {
    return [...this.engines.keys()].sort();
  }
}

export const documentEngines = new EngineRegistry();
