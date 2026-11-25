import { NextResponse } from "next/server";
import { PREVIEW_COOKIE, PREVIEW_KEY_COOKIE } from "@/lib/user-session";

export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const out = new NextResponse(null, { status: 303, headers: { Location: "/login", "Cache-Control": "no-store" } });
  out.cookies.set(PREVIEW_COOKIE, "", { path: "/", maxAge: 0 });
  out.cookies.set(PREVIEW_KEY_COOKIE, "", { path: "/", maxAge: 0 });
  return out;
}
