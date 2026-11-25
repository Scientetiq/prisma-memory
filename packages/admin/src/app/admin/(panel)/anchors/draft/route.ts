import { NextResponse, type NextRequest } from "next/server";
import { call } from "@/lib/gateway";
import { readSession } from "@/lib/session";
import { requestOrigin } from "@/lib/workplace-login";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const base = requestOrigin(req) ?? req.url;
  const back = (code: string) => NextResponse.redirect(new URL(`/admin/anchors?draft_error=${code}`, base), 303);
  const session = await readSession();
  if (!session) return NextResponse.redirect(new URL("/admin/login", base), 303);
  const { status, data } = await call("/api/v1/admin/anchors/draft", { token: session.token, timeoutMs: 30_000 });
  if (status === 401) return NextResponse.redirect(new URL("/admin/login?expired=1", base), 303);
  if (status !== 200 || !data || typeof data !== "object") {
    const { code, reason } = (data ?? {}) as { code?: string; reason?: string };
    return back(code === "stepup_required" ? "stepup" : status === 403 ? "role" : reason === "roles_not_split" ? "roles_not_split" : "failed");
  }
  const serial = Number((data as { serial?: unknown }).serial) || 0;
  return new Response(`${JSON.stringify(data, null, 2)}\n`, {
    headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="trust-anchors-inner.${serial}.json"`, "cache-control": "no-store" },
  });
}
