import "server-only";
import { cache } from "react";
import { callTool, type McpResult } from "./mcp";
import { profileMemo, shellUser } from "./nav-cache";
import type { Me } from "./types";

export const getMe = cache(async (key: string): Promise<McpResult<Me>> => {
  const r = await callTool<Me>(key, "memory_me", {}, 20_000);
  if (r.ok && r.data?.person) profileMemo.put(key, shellUser(r.data));
  return r;
});
