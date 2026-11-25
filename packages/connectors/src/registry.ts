// The registry of connector kinds of this build. Connector code is compiled in (no runtime loading); optional packs
// bring presets of built-in kinds and are offered only when their id is listed in integrations.connectors_packs.
// A kind with an invalid manifest, declared outbound actions, methods that disagree with its capabilities or a name
// used twice is refused — building the registry throws, so a bad kind fails at start-up and in tests, never at run time.
import { mcpSourceConnector } from "./builtin/mcp-source/index.ts";
import { webhookConnector } from "./builtin/webhook/index.ts";
import { BUILTIN_PACKS } from "./packs/index.ts";
import { connectorShapeProblems, validateManifest, validatePartialConfig } from "./sdk/manifest.ts";
import type { Connector, Pack, Preset, Problem } from "./sdk/types.ts";

/** Built-in kinds; each connector task appends its kind here. */
export const BUILTIN_CONNECTORS: readonly Connector[] = [webhookConnector as Connector, mcpSourceConnector as Connector];

/** Optional packs of this build: the list of packs/index.ts. This build has none. */
export { BUILTIN_PACKS };

/** Ids of the packs this build has (what integrations.connectors_packs may list). */
export const packIds = (): string[] => BUILTIN_PACKS.map((p) => p.id);

const ID = /^[a-z][a-z0-9_]{1,31}$/;

export class ConnectorRegistryError extends Error {
  constructor(readonly problems: Problem[]) {
    super(`connector registry refused ${problems.length} problem(s): ${problems.map((p) => `${p.code}${p.path ? ` at ${p.path}` : ""}`).join("; ")}`);
  }
}

export interface ConnectorRegistry {
  kinds: ReadonlyMap<string, Connector>;
  /** Presets of the listed packs. */
  presets: readonly Preset[];
  /** Listed pack ids this build does not have (ignored). */
  unknownPacks: string[];
  preset(id: string): Preset | null;
}

export function buildRegistry(connectors: readonly Connector[], packs: readonly Pack[], enabledPacks: readonly string[]): ConnectorRegistry {
  const problems: Problem[] = [];
  const kinds = new Map<string, Connector>();
  connectors.forEach((c, i) => {
    const name = typeof c?.manifest?.kind === "string" ? c.manifest.kind : `#${i}`;
    const own = [...validateManifest(c?.manifest), ...(c?.manifest ? connectorShapeProblems(c) : [])];
    for (const p of own) problems.push({ ...p, path: `/kinds/${name}${p.path ?? ""}`, message: `kind ${name}: ${p.message}` });
    if (own.length > 0) return;
    if (kinds.has(name)) problems.push({ code: "duplicate_kind", path: `/kinds/${name}`, message: `kind ${name} is registered twice` });
    else kinds.set(name, c);
  });

  const packIdsSeen = new Set<string>();
  const presetIds = new Set<string>();
  const all: Preset[] = [];
  for (const pack of packs) {
    if (!ID.test(pack.id)) {
      problems.push({ code: "pack_id", path: `/packs/${pack.id}`, message: "a pack id is lowercase letters, digits and _ (2–32 characters)" });
      continue;
    }
    if (packIdsSeen.has(pack.id)) {
      problems.push({ code: "duplicate_pack", path: `/packs/${pack.id}`, message: `pack ${pack.id} is registered twice` });
      continue;
    }
    packIdsSeen.add(pack.id);
    for (const preset of pack.presets) {
      const at = `/packs/${pack.id}/presets/${preset.id}`;
      const before = problems.length;
      if (!ID.test(preset.id)) problems.push({ code: "preset_id", path: at, message: "a preset id is lowercase letters, digits and _ (2–32 characters)" });
      else if (presetIds.has(preset.id)) problems.push({ code: "duplicate_preset", path: at, message: `preset ${preset.id} is registered twice` });
      presetIds.add(preset.id);
      if (preset.pack !== pack.id) problems.push({ code: "preset_pack", path: at, message: `preset ${preset.id} names pack ${preset.pack}, not ${pack.id}` });
      const kind = kinds.get(preset.kind);
      if (!kind) problems.push({ code: "preset_kind", path: at, message: `preset ${preset.id} configures kind ${preset.kind}, which this build does not have` });
      else if (validatePartialConfig(kind.manifest, preset.config).length > 0)
        problems.push({ code: "preset_config", path: at, message: `preset ${preset.id}: its config defaults do not fit kind ${preset.kind}` });
      if (problems.length === before) all.push(preset);
    }
  }
  if (problems.length > 0) throw new ConnectorRegistryError(problems);

  const enabled = new Set(enabledPacks);
  const presets = all.filter((p) => enabled.has(p.pack));
  const unknownPacks = [...enabled].filter((id) => !packIdsSeen.has(id));
  return {
    kinds,
    presets,
    unknownPacks,
    preset: (id) => presets.find((p) => p.id === id) ?? null,
  };
}

/** The registry of this build for the packs listed in integrations.connectors_packs. */
export function builtinConnectors(packs: readonly string[]): ConnectorRegistry {
  return buildRegistry(BUILTIN_CONNECTORS, BUILTIN_PACKS, packs);
}
