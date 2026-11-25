import { DIRECTORY_TEXT } from "../../../messages/api-directory";
import { NextResponse } from "next/server";
import { meGw } from "@/lib/me-api";
import type { DirectorySearch } from "@/lib/types";
import { readUserSession } from "@/lib/user-session";

const DIRECTORY_QUERY_MIN = 2, DIRECTORY_QUERY_MAX = 100;

export async function GET(req: Request): Promise<Response> {
  const session = await readUserSession();
  if (!session) return NextResponse.json({ ok: false, message: DIRECTORY_TEXT.expired }, { status: 401 });
  const q = (new URL(req.url).searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  if (q.length < DIRECTORY_QUERY_MIN) return NextResponse.json({ ok: false, message: DIRECTORY_TEXT.tooShort(DIRECTORY_QUERY_MIN) }, { status: 400 });
  if (q.length > DIRECTORY_QUERY_MAX) return NextResponse.json({ ok: false, message: DIRECTORY_TEXT.tooLong(DIRECTORY_QUERY_MAX) }, { status: 400 });

  const res = await meGw<DirectorySearch>(session.key, "/api/v1/directory/search", { query: { q }, timeoutMs: 15_000 });
  if (!res.ok) return NextResponse.json({ ok: false, message: res.message, retryAfter: res.retryAfter ?? null }, { status: res.status });
  return NextResponse.json({
    ok: true,
    truncated: Boolean(res.data.truncated),
    items: (res.data.items ?? []).map((h) => ({ display_name: h.display_name ?? null, login: h.login, department: h.department ?? null, title: h.title ?? null,
                                                in_memory: h.in_memory !== false })),
  });
}
