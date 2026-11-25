// Embeddings role of the model layer: embedder profile, presets, wire shapes, the dimension probe, the
// registry of embedders and the facade (embedderFor, the only caller of the platform's embeddings transport).
// The model connection (models/connection.ts, models/types.ts) is exported by the package index.
export * from "./profile.ts";
export * from "./presets.ts";
export * from "./wire.ts";
export * from "./probe.ts";
export * from "./registry.ts";
export * from "./settings-rules.ts";
export * from "./transform.ts";
export * from "./embedder.ts";
