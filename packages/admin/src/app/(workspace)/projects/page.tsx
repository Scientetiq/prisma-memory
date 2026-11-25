import { redirect } from "next/navigation";
import { param, type SearchParams } from "@/lib/paging";
import { projectsListRedirect } from "@/lib/spaces";

export default async function ProjectsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  redirect(projectsListRedirect({ acur: param(sp, "acur"), page: param(sp, "page"), archived: param(sp, "archived") }));
}
