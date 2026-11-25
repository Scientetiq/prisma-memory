"use client";
import type { ReactNode } from "react";
import { installClientMessages, type ClientMessages } from "./client-data";

/** Synchronous installation is intentional: all first-paint text must be present before descendants render. */
export function MessageBoundary({ messages, children }: { messages: ClientMessages; children: ReactNode }) {
  installClientMessages(messages);
  return children;
}
