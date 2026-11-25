import { contentSecurityPolicy } from "./src/lib/security-headers.mjs";

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

/** @type {import('next').NextConfig} */
const nextConfig = {
  turbopack: {
    rules: {
      "*.{ts,tsx}": [
        { condition: "browser", loaders: ["./tools/i18n/client-split.cjs"] },
        { condition: { not: "browser" }, loaders: ["./tools/i18n/route-messages.cjs"] },
      ],
    },
  },
  reactStrictMode: true,
  poweredByHeader: false,
  devIndicators: false,
  allowedDevOrigins: ["*.*.*.*"],
  experimental: {
    serverActions: { bodySizeLimit: "8mb" },
  },
  async redirects() {
    const sections = ["settings", "people", "roles", "services", "spaces", "unprocessed", "report", "audit", "first-run"];
    const adminOnly = new Set(["people", "spaces"]);
    return [
      ...sections.map((s) => ({ source: `/${s}`, destination: `/admin/${s}`, permanent: false,
        ...(adminOnly.has(s) ? { has: [{ type: "cookie", key: "memory_admin_session" }] } : {}) })),
      { source: "/favicon.ico", destination: "/icon.svg", permanent: false },
    ];
  },
  async headers() {
    const noStore = { key: "Cache-Control", value: "no-store" };
    const csp = { key: "Content-Security-Policy", value: contentSecurityPolicy() };
    // Consent follows a 303 through the issuer to a registered agent callback, possibly a native scheme.
    // A form-action restriction can block that chain; the server validates every continuation destination.
    const consentCsp = { ...csp, value: contentSecurityPolicy({ consent: true }) };
    return [
      { source: "/:path*", headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        csp,
      ] },
      { source: "/auth/oidc/:path*", headers: [{ key: "Referrer-Policy", value: "no-referrer" }, noStore] },
      { source: "/login", headers: [noStore] },
      { source: "/admin/login", headers: [noStore] },
      // Agent consent screen and its handlers (built-in agent sign-in): never cached, never framed —
      // the page carries the request id and the CSRF value of the request. Referrer-Policy stays same-origin, not
      // no-referrer: an old browser without Sec-Fetch-Site would then send `Origin: null` with the form and the decision
      // handler would refuse it. Repeated here so the screen keeps them even if the general entry changes.
      ...["/connect/authorize", "/connect/authorize/:path*"].map((source) => ({ source, headers: [
        noStore,
        { key: "Referrer-Policy", value: "same-origin" },
        { key: "X-Frame-Options", value: "DENY" },
        consentCsp,
      ] })),
    ];
  },
};

function configure(phase) {
  // Production startup uses the built data on a read-only filesystem; only build/dev generate artifacts.
  const { PHASE_PRODUCTION_BUILD, PHASE_DEVELOPMENT_SERVER } = require("next/constants");
  if (phase === PHASE_PRODUCTION_BUILD || phase === PHASE_DEVELOPMENT_SERVER) {
    require("./tools/i18n/client-manifest.cjs").generate();
  }
  return nextConfig;
}

// Keep the existing config object API available to source-level consumers as well as Next's phase callback.
export default Object.assign(configure, nextConfig);
