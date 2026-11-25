"use client";
// "Upload new version": the updated file goes to /api/upload with `replaces` — the route sends it to the REST ingest
// route of the memory (multipart, session key) after the same Origin, session and size checks as every upload. A text
// version is current at once: the page moves to it. A PDF or office version is processed first: the page stays and the
// "Versions" block shows it as being processed. To bring an earlier version back, its file is uploaded here again.
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Icon } from "@/components/icons";
import { Notice } from "@/components/ui";
import { uploadOutcome, type VersionUploadAnswer, type VersionUploadOutcome } from "@/lib/versions";
import { VERSIONS_TEXT } from "@/lib/versions.messages";

const T = VERSIONS_TEXT.upload;

type Outcome = VersionUploadOutcome | null;

export function VersionUpload({ replaces }: { replaces: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>(null);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const file = (form.elements.namedItem("file") as HTMLInputElement | null)?.files?.[0];
    if (!file) { setOutcome({ tone: "danger", text: T.noFile }); return; }
    const fd = new FormData();
    fd.set("file", file);
    fd.set("replaces", replaces);
    setBusy(true); setOutcome(null);
    let answer: VersionUploadAnswer | null = null;
    try {
      const r = await fetch("/api/upload", { method: "POST", body: fd });
      answer = await r.json().catch(() => null) as VersionUploadAnswer | null;
    } catch { answer = null; }
    setBusy(false);
    const { outcome, nav } = uploadOutcome(answer, replaces);   // lib/versions.ts: the words and the next page
    if (answer?.ok) form.reset();
    setOutcome(outcome);
    if (nav === "refresh") router.refresh(); else if (nav) router.push(nav);
  }

  return (
    <details className="version-upload">
      <summary><Icon name="upload" /> {T.summary}</summary>
      <p className="hint">{T.hint}</p>
      <form onSubmit={submit} className="version-upload-form">
        <label className="field">
          <span>{T.file}</span>
          <input type="file" name="file" required disabled={busy} />
        </label>
        <button type="submit" className="btn sm primary" disabled={busy}>{busy ? T.busy : T.button}</button>
      </form>
      {outcome ? (
        <Notice tone={outcome.tone}>
          {outcome.text}
          {outcome.hint ? <> {outcome.hint}</> : null}
          {outcome.currentId ? <> <a href={`/records/${outcome.currentId}`}>{VERSIONS_TEXT.openCurrent}</a></> : null}
        </Notice>
      ) : null}
    </details>
  );
}
