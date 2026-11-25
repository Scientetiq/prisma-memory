import { TEXT } from "../../../../messages/panel-login";
import type { Metadata } from "next";
import { Brand } from "@/components/brand";
import { param, type SearchParams } from "@/lib/paging";
import { SsoCallbackClient } from "../webauthn-client";

export function generateMetadata(): Metadata { return { title: TEXT.signIn }; }
export const dynamic = "force-dynamic";

export default async function AdminLoginCallbackPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const params = { state: param(sp, "state"), code: param(sp, "code"), iss: param(sp, "iss"), error: param(sp, "error") };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand sub={TEXT.adminPanel} />
        <h1>{TEXT.panelSignIn}</h1>
        <SsoCallbackClient params={params} />
      </div>
    </div>
  );
}
