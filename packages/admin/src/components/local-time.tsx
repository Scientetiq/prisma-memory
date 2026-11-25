"use client";
import { useEffect, useState } from "react";
import { formatWhen, formatWhenFull } from "@/lib/format";

export function LocalTime({ iso, short, seconds, relative = true }: {
  iso: string | null | undefined;
  short?: boolean;
  minutes?: boolean;
  seconds?: boolean;
  relative?: boolean;
}) {
  const [local, setLocal] = useState<{ text: string; full: string } | null>(null);
  useEffect(() => {
    if (!iso || Number.isNaN(new Date(iso).getTime())) return;
    setLocal({ text: formatWhen(iso, { seconds, relative }), full: formatWhenFull(iso) });
  }, [iso, seconds, relative]);
  if (!iso) return <span className="muted">—</span>;
  const valid = !Number.isNaN(new Date(iso).getTime());
  const server = !valid ? iso : `${formatWhen(iso, { tz: "UTC", relative: false, year: true, seconds })} UTC`;
  const title = short ? undefined : local?.full ?? (valid ? `${formatWhenFull(iso, "UTC")} UTC` : undefined);
  return <time dateTime={iso} title={title} className="date">{local?.text ?? server}</time>;
}
