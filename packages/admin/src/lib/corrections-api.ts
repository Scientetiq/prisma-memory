import "server-only";
import { createHash } from "node:crypto";
import { multiline } from "./corrections";

export const noteDigest = (text: string): string => createHash("sha256").update(multiline(text), "utf8").digest("hex");
