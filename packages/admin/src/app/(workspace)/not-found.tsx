import { notFoundText as M } from "@/messages/ws-not-found";
import type { Metadata } from "next";
import { MissingBody } from "@/components/missing";

export function generateMetadata(): Metadata { return { title: M.pageNotFound }; }

export default function WorkspaceNotFound() {
  return <MissingBody />;
}
