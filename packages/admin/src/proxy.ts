// Every page/action path reaches the role gate, including file-looking paths.
// API uploads bypass Next's body-cloning proxy to retain their streaming limits;
// their role-specific gateway transport enforces the boundary.
import { NextResponse, type NextRequest } from "next/server";
import { PATH_HEADER } from "@/lib/login-return";
import { isPanelPath, roleAllows, webRole } from "@/lib/web-role";
import { adminPlaneSeparate, gatewayBase, gatewayFetch } from "@/lib/gateway-transport";
import { contentSecurityPolicy } from "@/lib/security-headers.mjs";

const notFound = (): NextResponse => new NextResponse("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export async function proxy(req: NextRequest): Promise<NextResponse> {
  const path = req.nextUrl.pathname;
  if (!roleAllows(webRole(), path)) return notFound();
  const headers = new Headers(req.headers);
  headers.set("x-memory-client-path", `${path}${req.nextUrl.search}`.slice(0, 2048));
  // Both path headers are set here only: a browser's x-memory-client-path is overwritten, its x-memory-path dropped.
  headers.delete(PATH_HEADER);
  if (path === "/admin/login") {
    let origin: unknown;
    if (adminPlaneSeparate()) {
      try {
        // Only the configured admin transport supplies the IdP origin; no browser headers are forwarded.
        const res = await gatewayFetch(gatewayBase("admin"), "/api/v1/admin-auth/methods", { signal: AbortSignal.timeout(10_000) });
        const methods = await res.json() as { sso?: unknown } | null;
        if (res.ok && methods?.sso === true) origin = res.headers.get("X-Memory-Sso-Origin");
      } catch { /* Unavailable or unconfigured SSO retains same-origin forms. */ }
    }
    const res = NextResponse.next({ request: { headers } });
    // Proxy response headers replace next.config's default policy only on this exact page (including plain form POSTs).
    res.headers.set("Content-Security-Policy", contentSecurityPolicy({ formOrigin: origin }));
    return res;
  }
  if (isPanelPath(path) || path.startsWith("/auth/")) return NextResponse.next({ request: { headers } });
  headers.set(PATH_HEADER, `${path}${req.nextUrl.search}`.slice(0, 2048));
  return NextResponse.next({ request: { headers } });
}

export const config = {
  matcher: ["/((?!api(?:/|$)).*)"],
};
