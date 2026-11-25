"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export const WATCH_EVERY_MS = 15_000;
export const WATCH_FOR_MS = 5 * 60_000;

export function startWatch(refresh: () => void, visible: () => boolean, now: () => number = Date.now): () => void {
  const until = now() + WATCH_FOR_MS;
  const id = setInterval(() => {
    if (now() > until) { clearInterval(id); return; }
    if (visible()) refresh();
  }, WATCH_EVERY_MS);
  return () => clearInterval(id);
}

export function ConnectWatch({ waiting }: { waiting: boolean }) {
  const router = useRouter();
  useEffect(() => (waiting ? startWatch(() => router.refresh(), () => document.visibilityState === "visible") : undefined), [waiting, router]);
  return null;
}
