// Optional packs of this build. A pack brings presets of built-in connector kinds, and its presets are offered only
// when the pack's id is listed in integrations.connectors_packs. This build carries no pack: a build that does names
// it here and nowhere else.
import type { Pack } from "../sdk/types.ts";

export const BUILTIN_PACKS: readonly Pack[] = [];
