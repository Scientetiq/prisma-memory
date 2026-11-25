"use client";
// The person's time zone as a hidden form field: <input type="datetime-local"> sends a time without a zone, and the server
// turns it into UTC by this zone (lib/format.ts localDateTimeToIso). Without JavaScript the field is empty and the server
// reads the time in the zone of the installation.
import { useEffect, useState } from "react";
import { systemZone } from "@/i18n/format";

export function TzField({ name = "tz" }: { name?: string }) {
  const [tz, setTz] = useState("");
  useEffect(() => {
    setTz(systemZone());   // "" when the browser does not tell: the server then uses the zone of the installation
  }, []);
  return <input type="hidden" name={name} value={tz} />;
}
