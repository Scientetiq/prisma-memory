"use client";
import { TEXT } from "../../../messages/panel-home";
import { SectionError } from "@/components/error-actions";

export default function PanelError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return <SectionError digest={error.digest} reset={reset} home="/admin" itNote={TEXT.seeTheAdminServiceLogsForDetails} />;
}
