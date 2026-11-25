"use client";
import { rich } from "@/i18n/rich";
import { uploadZone as M } from "@/messages/ws-materials";
import { useRouter } from "next/navigation";
import { useRef, useState, type ChangeEvent, type DragEvent } from "react";
import { ActionForm } from "@/components/action-form";
import { Icon } from "@/components/icons";
import { Notice } from "@/components/ui";
import { ACCESS_ACTION, CLOSED_CLASS_TEXT, OPEN_CLASS_SPEC, uploadKept, uploadKeptClosed } from "@/lib/closed-class";
import { formatsLine } from "@/lib/home";
import { mimeTitle, QUEUE_LANE_HINTS } from "@/lib/labels";
import { showAnywayHref } from "@/lib/show-anyway";
import type { OpenCheckMark } from "@/lib/types";
import { TRASH_TEXT } from "@/lib/trash";
import { runUploadQueue, uploadSummary, uploadWaitLine, type UploadReply } from "@/lib/upload-queue";
import { deleteAction, openAction } from "../actions";
import { SaveTo, type TargetSpace } from "./save-to";

interface Item { name: string; state: "wait" | "send" | "ok" | "err"; msg: string; hint?: string; accepted?: string[]; id?: string; closed?: boolean; kept?: boolean }

type Body = NonNullable<UploadReply["body"]> & { hint?: string | null; accepted?: string[]; path?: string; id?: string; class?: string;
                                                queue?: { lane?: string | null; eta_sec?: number | null } | null; open_check?: OpenCheckMark | null };

const mb = (bytes: number): string => M.mb(Math.round(bytes / 1048576));

export function UploadZone({ space, accepted, maxBytes, converter, exact }:
  { space: TargetSpace; accepted: string[]; maxBytes: number; converter: boolean; exact: boolean }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);

  const [summary, setSummary] = useState<string | null>(null);

  async function send(files: File[]) {
    if (!files.length) return;
    setBusy(true);
    setSummary(null);
    const start = items.length;
    setItems((cur) => [...cur, ...files.map((f) => ({ name: f.name, state: "wait" as const, msg: M.waitingToSend }))]);
    const set = (i: number, patch: Partial<Item>) => setItems((cur) => cur.map((it, n) => (n === start + i ? { ...it, ...patch } : it)));
    let changed = false;
    const tally = await runUploadQueue(files, {
      precheck: (f) => (f.size > maxBytes ? M.tooLargeMbLimit((f.size / 1048576).toFixed(1), mb(maxBytes)) : null),
      send: async (f) => {
        const fd = new FormData();
        fd.set("file", f); fd.set("space", space.slug);
        const r = await fetch("/api/upload", { method: "POST", body: fd });
        return { status: r.status, body: (await r.json().catch(() => null)) as Body | null };
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      onSending: (i) => set(i, { state: "send", msg: M.sending }),
      onWait: (i, sec) => set(i, { state: "wait", msg: uploadWaitLine(sec) }),
      onDone: (i, verdict, reply, note) => {
        const body = reply?.body as Body | null | undefined;
        if (verdict !== "failed" && body) {
          changed = true;
          const lane = body.queue?.lane ? QUEUE_LANE_HINTS[body.queue.lane] : null;
          const kept = uploadKept(space, body);
          const msg = kept ? (body.already_known ? CLOSED_CLASS_TEXT.uploadKeptAgain : uploadKeptClosed(body.open_check ?? {}, space))
            : body.already_known ? M.alreadySavedInMemory : M.accepted(lane ?? M.processingWillStartAutomatically);
          set(i, { state: "ok", msg, id: body.id, closed: body.class === "closed", kept });
          return;
        }
        set(i, { state: "err", msg: note ?? body?.message ?? M.notAcceptedErrorCode(reply?.status ?? "—"), hint: body?.hint ?? undefined, accepted: body?.accepted });
      },
      onSkipped: (i, message) => set(i, { state: "err", msg: M.notSent(message) }),
    });
    setBusy(false);
    if (files.length > 1 || tally.failed) setSummary(uploadSummary(tally));
    if (changed) router.refresh();
  }

  function onDrop(e: DragEvent<HTMLDivElement>) { e.preventDefault(); setOver(false); void send(Array.from(e.dataTransfer.files)); }
  function onPick(e: ChangeEvent<HTMLInputElement>) { void send(Array.from(e.target.files ?? [])); e.target.value = ""; }

  return (
    <div className="mt-upload">
      <SaveTo space={space} />
      <div className={over ? "dropzone mt-drop over" : "dropzone mt-drop"} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={onDrop}
        role="button" tabIndex={0} onClick={() => input.current?.click()} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.current?.click(); } }} aria-busy={busy}>
        <span className="mt-drop-ic"><Icon name="upload" /></span>
        <b>{busy ? M.sending2 : <>{rich(M.dropFilesHereChooseAFileLine, { tag1: (children) => <span className="mt-drop-fine">{children}</span>, tag2: (children) => <span className="mt-drop-coarse">{children}</span> })}</>}</b>
        <span className="mt-drop-or mt-drop-fine">{rich(M.orChooseFromYourComputerLine, { tag1: (children) => <span className="mt-drop-pick">{children}</span> })}</span>
        <span className="formats">{formatsLine(accepted, maxBytes)}{exact ? "" : M.exactListShownWhenUploading}</span>
        <input ref={input} type="file" multiple onChange={onPick} hidden />
      </div>

      {summary ? <p className="upload-summary" role="status">{summary}</p> : null}
      {items.length ? (
        <ul className="upload-list" aria-live="polite">
          {items.map((it, i) => (
            <li key={i} className={it.state === "err" ? "err" : it.state === "ok" ? "ok" : undefined}>
              <Icon name={it.state === "ok" ? "circle-check" : it.state === "err" ? "circle-alert" : "hourglass"} />
              <span className="nm">{it.name}</span>
              <span className="msg">{it.msg}{it.id ? <> {it.kept ? <a href={showAnywayHref(it.id)}>{CLOSED_CLASS_TEXT.uploadKeptLink}</a> : <a href={`/records/${it.id}`}>{M.open}</a>}</> : null}</span>
              {it.hint ? <span className="msg small">{it.hint}</span> : null}
              {it.accepted?.length ? <span className="msg small">{rich(M.currentlyAcceptedMemoryDoesNotAcceptLine, null, { value1: [...new Set(it.accepted.map(mimeTitle))].join(", "), value2: converter ? "" : M.pdfIsAvailableAfterTheAdministratorConnects })}</span> : null}
              {it.closed && !it.kept ? <span className="msg small">{CLOSED_CLASS_TEXT.closedClassLine}</span> : null}
              {it.state === "ok" && it.id ? (
                <span className="acts">
                  {it.closed && !it.kept ? (
                    <details>
                      <summary>{ACCESS_ACTION.show}</summary>
                      <Notice tone="warn"><strong>{CLOSED_CLASS_TEXT.openClassLead}</strong> {CLOSED_CLASS_TEXT.openClassWarning}</Notice>
                      <ActionForm action={openAction} submitLabel={ACCESS_ACTION.show} pendingLabel="…" danger confirm={OPEN_CLASS_SPEC}>
                        <input type="hidden" name="id" value={it.id} />
                        <label className="check ack-fallback"><input type="checkbox" name="confirm" /> {M.iUnderstandTheConsequences2}</label>
                      </ActionForm>
                    </details>
                  ) : null}
                  <ActionForm action={deleteAction} submitLabel={M.delete2} pendingLabel="…" compact danger confirm={TRASH_TEXT.deleteConfirm}>
                    <input type="hidden" name="id" value={it.id} />
                  </ActionForm>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
