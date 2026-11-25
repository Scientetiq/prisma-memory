"use server";
import { refresh } from "next/cache";
import { endedState } from "@/lib/action-ended";
import { failState, okState, type ActionState } from "@/lib/action-state";
import { meGw } from "@/lib/me-api";
import {
  baseFromForm, basePublicFromForm, clashes, clashLine, mergePublic, MY_PROFILE_API, OVERWRITE_FIELD, PENDING_FIELD, profileState, publicFromForm, publicNeeded, refusalLine,
  sectionField, sectionsFromForm,
} from "@/lib/my-profile";
import { PROFILE_PLAIN } from "@/lib/plain";
import { PREVIEW_TEXT } from "@/lib/preview";
import type { MyProfile, MyProfileSaved, WorkProfilePublicSection } from "@/lib/types";
import { actionSession } from "@/lib/user-session";
import { PROFILE_SECTION_TITLES, PROFILE_SECTIONS, PUBLIC_SECTIONS } from "@/lib/work-profile";

export async function saveProfileAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const session = await actionSession(); if ("ok" in session) return session;
  if (session.preview) return failState(PREVIEW_TEXT.previewDenied, { lines: [PREVIEW_TEXT.previewDeniedHint] });
  const fields = PROFILE_SECTIONS.some((s) => formData.has(sectionField(s)));
  const checked = publicFromForm(formData);
  if (!fields && checked === undefined) return failState(PROFILE_PLAIN.notSaved, { lines: [PROFILE_PLAIN.noProfile] });
  const base = baseFromForm(formData), basePub = basePublicFromForm(formData);
  const sections = sectionsFromForm(formData, base);
  const pubWanted = checked !== undefined && publicNeeded(checked, basePub, formData.get(PENDING_FIELD) === "1");
  if (!Object.keys(sections).length && !pubWanted) {
    return base && Object.keys(base).length ? okState(PROFILE_PLAIN.unchanged) : failState(PROFILE_PLAIN.notSaved, { lines: [PROFILE_PLAIN.noProfile] });
  }
  let pub: WorkProfilePublicSection[] | undefined = pubWanted ? checked : undefined;
  if (checked !== undefined && base) {
    const cur = await meGw<MyProfile>(session.key, MY_PROFILE_API);
    if (!cur.ok) {
      const ended = endedState(cur);
      if (ended) return ended;
      return failState(PROFILE_PLAIN.notSaved, { lines: [refusalLine(cur.message), ...(cur.hint ? [cur.hint] : [])] });
    }
    if (profileState(cur).kind !== "ok") return failState(PROFILE_PLAIN.notSaved, { lines: [PROFILE_PLAIN.failed] });
    const clash = clashes(sections, base, cur.data);
    if (clash.length && formData.get(OVERWRITE_FIELD) !== "on") {
      return failState(PROFILE_PLAIN.clash, { lines: [clashLine(clash, cur.data), PROFILE_PLAIN.clashHint], ask: OVERWRITE_FIELD });
    }
    pub = pubWanted && !cur.data.hidden ? mergePublic(cur.data.public, basePub, checked) : undefined;
    if (!Object.keys(sections).length && pub === undefined) return okState(PROFILE_PLAIN.unchanged);
  }
  const body = { ...(Object.keys(sections).length ? { sections } : {}), ...(pub !== undefined ? { public: pub } : {}) };
  const res = await meGw<MyProfileSaved>(session.key, MY_PROFILE_API, { method: "PUT", body });
  if (!res.ok) {
    const ended = endedState(res);
    if (ended) return ended;
    return failState(PROFILE_PLAIN.notSaved, { lines: [refusalLine(res.message), ...(res.hint ? [res.hint] : [])] });
  }
  refresh();
  const shownNow = PUBLIC_SECTIONS.filter((s) => res.data.profile.public_preview?.sections?.[s]);
  const titles = shownNow.map((s) => PROFILE_SECTION_TITLES[s]);
  if (res.data.already_known) {
    const seen = new Set(String(formData.get("seen") ?? "").split(",").filter(Boolean));
    const same = shownNow.length === seen.size && shownNow.every((s) => seen.has(s));
    return same ? okState(PROFILE_PLAIN.unchanged) : okState(PROFILE_PLAIN.saved, { lines: [PROFILE_PLAIN.savedPublic(titles)] });
  }
  if (res.data.profile.hidden) return okState(PROFILE_PLAIN.saved, { lines: [PROFILE_PLAIN.savedHidden] });
  return okState(PROFILE_PLAIN.saved, { lines: [...(res.data.changed?.length ? [PROFILE_PLAIN.savedLine] : []), PROFILE_PLAIN.savedPublic(titles)] });
}
