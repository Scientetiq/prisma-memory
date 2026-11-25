import type { Metadata } from "next";
import { PageHead } from "@/components/ui";
import { requireWorkspace } from "@/lib/me";
import { LOCAL_CHANGE } from "@/messages/local-change";
import { changeLocalPasswordAction } from "./actions";
import { ChangePasswordForm } from "./change-password-form";

export function generateMetadata(): Metadata { return { title: LOCAL_CHANGE.title }; }

export default async function PasswordPage() {
  await requireWorkspace();
  return (
    <>
      <PageHead title={LOCAL_CHANGE.title} lead={LOCAL_CHANGE.lead} />
      <section className="sp-card" aria-label={LOCAL_CHANGE.title}>
        <ChangePasswordForm action={changeLocalPasswordAction} />
      </section>
    </>
  );
}
