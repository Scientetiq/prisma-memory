import { missing } from "@/messages/root";
import type { Metadata } from "next";
import Link from "next/link";
import { headers } from "next/headers";
import { Brand } from "@/components/brand";
import { MISSING_PLAIN, MissingBody } from "@/components/missing";
import { PATH_HEADER } from "@/lib/login-return";
import { readUserSession } from "@/lib/user-session";
import WorkspaceLayout from "./(workspace)/layout";

export function generateMetadata(): Metadata { return { title: missing.title }; }

export default async function NotFound() {
  const workspace = (await headers()).has(PATH_HEADER);
  if (workspace && (await readUserSession())) return <WorkspaceLayout><MissingBody /></WorkspaceLayout>;
  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand sub={workspace ? missing.workspaceSub : ""} />
        <h1>{MISSING_PLAIN.title}</h1>
        <p className="sub">{MISSING_PLAIN.lead}</p>
        {workspace
          ? <p className="foot"><Link href="/login" className="btn primary" prefetch={false}>{missing.signIn}</Link></p>
          : <p className="foot"><Link href="/">{missing.workspace}</Link> · <Link href="/admin">{missing.panel}</Link></p>}
      </div>
    </div>
  );
}
