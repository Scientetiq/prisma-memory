import type { Metadata } from "next";
import { Brand } from "@/components/brand";
import { LOCAL_SETUP } from "@/messages/local-setup";
import { TEXT } from "@/messages/ws-login";
import { setLocalPasswordAction } from "./actions";
import { SetPasswordForm } from "./set-password-form";

export function generateMetadata(): Metadata { return { title: LOCAL_SETUP.title }; }

export default function SetPasswordPage() {
  return (
    <div className="login-wrap">
      <div className="login-card">
        <Brand sub={TEXT.workspace} />
        <h1>{LOCAL_SETUP.title}</h1>
        <p className="sub">{LOCAL_SETUP.lead}</p>
        <SetPasswordForm action={setLocalPasswordAction} />
        <p className="foot"><a href="/login">{LOCAL_SETUP.toSignIn}</a></p>
      </div>
    </div>
  );
}
