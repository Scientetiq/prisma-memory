import { X509Certificate } from "node:crypto";

export const CERT_WARN_DAYS = 30;

function firstCert(pem: string | Buffer): X509Certificate {
  const text = Buffer.isBuffer(pem) ? pem.toString("utf8") : pem;
  const m = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(text);
  if (!m) throw new TypeError("certificate: no PEM CERTIFICATE found in the text");
  return new X509Certificate(m[0]);
}

export function certNotAfter(pem: string | Buffer): Date {
  return new Date(firstCert(pem).validTo);
}

export function certNotBefore(pem: string | Buffer): Date {
  return new Date(firstCert(pem).validFrom);
}

export function daysLeft(pem: string | Buffer, now: Date | number = Date.now()): number {
  const t = typeof now === "number" ? now : now.getTime();
  return Math.floor((certNotAfter(pem).getTime() - t) / 86_400_000);
}
