// Frame of the agent consent screen (/connect/authorize, built-in agent sign-in): a bare card like the
// sign-in page, without the workplace menu — a person who came here from an app sees only the request. Signed-out people go
// to the sign-in page and come back here (the return path is the x-memory-path header of proxy.ts, query included). The
// page checks the session itself too: a layout is not re-rendered on every navigation. The frame follows the request language.
import { currentLocale } from "@/i18n/runtime";
import type { ReactNode } from "react";
import { BrandMark } from "@/components/brand";
import { consentText } from "@/lib/agent-consent-text";
import { requireUserSession } from "@/lib/user-session";

export const dynamic = "force-dynamic";

export default async function ConsentLayout({ children }: { children: ReactNode }) {
  await requireUserSession();
  return (
    <div className="login-wrap consent-wrap" lang={currentLocale()}>
      <main className="login-card wide consent-card">
        <div className="brand"><BrandMark /><span className="brand-name">{consentText("brand")}</span></div>
        {children}
      </main>
    </div>
  );
}
