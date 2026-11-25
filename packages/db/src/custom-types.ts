// Custom column types that drizzle-orm does not know: pgvector halfvec, tsvector, bytea.
import { customType } from "drizzle-orm/pg-core";

/** SHA-256 and other binary values; Buffer in the application. */
export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/** Full-text generated columns; read only in SQL (`@@`), a string in the application. */
export const tsvector = customType<{ data: string; driverData: string }>({
  dataType: () => "tsvector",
});

/**
 * An embedding in half precision (pgvector halfvec) without a fixed dimension: each embedder stores vectors of its own
 * length, and its index fixes the length by the expression (embedding::halfvec(N)). Sent as the text '[0.1,0.2,…]'.
 */
export const halfvec = customType<{ data: number[]; driverData: string }>({
  dataType: () => "halfvec",
  toDriver: (value: number[]) => `[${value.join(",")}]`,
  fromDriver: (value: string) => value.slice(1, -1).split(",").map(Number),
});
