/** Accept one canonical HTTPS origin, never a CSP source expression or URL path. */
function formOrigin(value) {
  if (typeof value !== "string" || /[\s;*]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Next's bootstrap and server-rendered styles are inline; eval is development-only.
 * @param {{ formOrigin?: unknown, consent?: boolean }} [options]
 */
export function contentSecurityPolicy({ formOrigin: configuredOrigin, consent = false } = {}) {
  const origin = formOrigin(configuredOrigin);
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline'${process.env.NODE_ENV === "production" ? "" : " 'unsafe-eval'"}`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https:", "font-src 'self' data:",
    "connect-src 'self'", "object-src 'none'", "base-uri 'self'",
    ...(consent ? [] : [`form-action 'self'${origin ? ` ${origin}` : ""}`]),
    "frame-ancestors 'none'",
  ].join("; ");
}
