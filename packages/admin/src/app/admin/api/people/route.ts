import { TEXT } from "../../../../messages/panel-api";
import { NextResponse } from "next/server";
import { gw } from "@/lib/api";
import { GatewayError } from "@/lib/gateway";
import type { Page, Person } from "@/lib/types";
import { readSession } from "@/lib/session";
import { readAdminView } from "@/lib/view-as";

const PEOPLE_QUERY_MIN = 2;
const PEOPLE_QUERY_MAX = 100;

export async function GET(req: Request): Promise<Response> {
  if (!(await readSession())) return NextResponse.json({ ok: false, message: TEXT.yourPanelSessionHasEndedSignIn }, { status: 401 });
  if ((await readAdminView()) === "auditor") return NextResponse.json({ ok: false, message: TEXT.suggestionsAreUnavailableInAuditorView }, { status: 403 });
  const url = new URL(req.url);
  const q = (url.searchParams.get("q") ?? "").replace(/\s+/g, " ").trim();
  const noDemo = url.searchParams.get("nodemo") === "1";
  if (q.length < PEOPLE_QUERY_MIN) return NextResponse.json({ ok: false, message: TEXT.typeAtLeastCharacters(PEOPLE_QUERY_MIN) }, { status: 400 });
  if (q.length > PEOPLE_QUERY_MAX) return NextResponse.json({ ok: false, message: TEXT.atMostCharacters(PEOPLE_QUERY_MAX) }, { status: 400 });
  try {
    const res = await gw<Page<Person>>("/api/v1/admin/people", { query: { q, active: "true", limit: 10 }, timeoutMs: 15_000 });
    return NextResponse.json({
      ok: true,
      items: res.items.filter((p) => !noDemo || String(p.attrs?.demo) !== "true").map((p) => ({ id: p.id, login: p.login, display_name: p.display_name ?? null, department: p.department ?? null, title: p.role ?? null })),
    });
  } catch (e) {
    if (e instanceof GatewayError) return NextResponse.json({ ok: false, message: e.message }, { status: e.status });
    throw e;
  }
}
