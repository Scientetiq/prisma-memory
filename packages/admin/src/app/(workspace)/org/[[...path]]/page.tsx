import { redirect } from "next/navigation";
import { memoryLinkTarget } from "@/lib/memory-link";

export default async function MemoryPathRedirect({ params }: { params: Promise<{ path?: string[] }> }) {
  redirect(memoryLinkTarget("org", (await params).path));
}
