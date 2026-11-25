"use client";
// Sign-in page hint: the public address is https, but this browser opened the page over plain HTTP — the `Secure`
// session cookie would never come back, so sign-in cannot work here. Only the browser knows the scheme it used (a TLS proxy
// may not tell the server), so visibility is decided on the client; the server render shows nothing. Loopback is exempt:
// browsers treat http://localhost as a secure context. The text and the address come from the server (plainHttpHint).
import { useSyncExternalStore } from "react";
import { Notice } from "@/components/ui";

const subscribe = () => () => {};
const openedOverHttp = (): boolean => {
  const { protocol, hostname } = window.location;
  const h = hostname.toLowerCase();
  const loopback = h === "localhost" || h.endsWith(".localhost") || h === "[::1]" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
  return protocol === "http:" && !loopback;
};

export function PlainHttpHint({ text, href }: { text: string; href: string }) {
  const plain = useSyncExternalStore(subscribe, openedOverHttp, () => false);
  return plain ? <Notice tone="warn" role="alert">{text} <a href={href}>{href}</a></Notice> : null;
}
