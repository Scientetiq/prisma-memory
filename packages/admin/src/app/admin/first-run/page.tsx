import { TEXT } from "../../../messages/panel-first-run";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Brand } from "@/components/brand";
import { firstRunInfo } from "@/lib/gateway";
import { FirstRunForm } from "./first-run-form";

export function generateMetadata(): Metadata { return { title: TEXT.firstRun }; }

export default async function FirstRunPage() {
  const info = await firstRunInfo();
  if (info.status !== "needed") redirect("/admin/login");

  return (
    <div className="login-wrap">
      <div className="login-card wide">
        <Brand sub={TEXT.adminPanel} />
        <h1>{TEXT.firstRun2}</h1>
        <p className="sub">{TEXT.thisInstanceHasNoAdministratorYetCreate}</p>
        <FirstRunForm codeRequired={info.codeRequired} />
      </div>
    </div>
  );
}
