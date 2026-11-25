import "server-only";
import type { Me } from "./types";

export const isOrgCurator = (me: Pick<Me, "spaces">): boolean => me.spaces.some((s) => s.kind === "org" && s.role === "owner");
