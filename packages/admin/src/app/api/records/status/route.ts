import { STATUS_TEXT } from "../../../../messages/api-records-status";
import { NextResponse } from "next/server";
import { meGw } from "@/lib/me-api";
import type { StatusBatch } from "@/lib/types";
import { readUserSession } from "@/lib/user-session";

export const MAX_IDS = 50;

export async function GET(req: Request): Promise<Response> {
  const session = await readUserSession();
  if (!session) return NextResponse.json({ ok: false, message: STATUS_TEXT.expired }, { status: 401 });
  const ids = (new URL(req.url).searchParams.get("ids") ?? "").split(",").map((s) => s.trim()).filter((s) => /^[0-9a-f-]{36}$/i.test(s));
  if (!ids.length) return NextResponse.json({ ok: false, message: STATUS_TEXT.idsRequired }, { status: 400 });
  if (ids.length > MAX_IDS) return NextResponse.json({ ok: false, message: STATUS_TEXT.tooMany(MAX_IDS) }, { status: 400 });

  const res = await meGw<StatusBatch>(session.key, "/api/v1/records/status", { query: { ids: ids.join(","), derived: false }, timeoutMs: 20_000 });
  if (!res.ok) return NextResponse.json({ ok: false, message: res.message, retryAfter: res.retryAfter ?? null }, { status: res.status });
  return NextResponse.json({
    ok: true,
    items: (res.data.items ?? []).map((d) => ({ id: d.id, stages: d.stages ?? [], queue: d.queue ?? null, conversion: d.conversion ?? null, access: d.access ?? null })),
  });
}
