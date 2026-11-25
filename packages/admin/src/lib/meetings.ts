import "server-only";
import { meGw, type MeResult } from "./me-api";
import type { MeetingReason } from "./meeting-state";

export { meetingState, REASON_TEXT, type MeetingReason } from "./meeting-state";

export interface PersonRef { login: string; display_name: string | null }
export interface MyMeeting {
  id: string; title: string | null; occurred_at: string; ingested_at: string; role: "owner" | "participant"; owner: PersonRef;
  participants: number; summary_line: string | null; stages: { summary: string | null; events: string | null;
    indexed?: string | null };
  lane: "now" | "night"; reason: MeetingReason | null; new: boolean;
  retry_at?: string | null;
  failed_final?: boolean;
  participant_names?: PersonRef[];
  projects?: ProjectRef[];
}
export interface ProjectRef { slug: string; name: string }
export interface MyMeetingsPage { items: MyMeeting[]; next_cursor: string | null; new_unavailable?: true; project?: ProjectRef | null }
export interface LeftParticipant extends PersonRef { at: string }
export interface NotInvited extends PersonRef { department: string | null; why: "speaker" | "actor" }
export interface MeetingParticipants {
  id: string; owner: PersonRef;
  participants: Array<PersonRef & { department: string | null; gone?: true }>;
  pending: PersonRef[]; unresolved: string[]; can_edit: boolean;
  left?: LeftParticipant[];
  not_invited?: NotInvited[];
  notify?: boolean;
  project_mark?: ProjectRef | null;
  organizer_transfer?: { from: PersonRef; at: string | null } | null;
}

export interface MeetingsQuery { q?: string; role?: "owner" | "participant" | ""; fresh?: boolean; space?: string }
export const MEETINGS_Q_MIN = 2, MEETINGS_Q_MAX = 100;

export const personName = (p: PersonRef): string => p.display_name?.trim() || p.login;

export async function myMeetings(key: string, cursor: string, limit = 30, f: MeetingsQuery = {}): Promise<MeResult<MyMeetingsPage>> {
  const q = (f.q ?? "").replace(/\s+/g, " ").trim();
  const query: Record<string, string> = { limit: String(limit), ...(cursor ? { cursor } : {}),
    ...(q.length >= MEETINGS_Q_MIN ? { q: q.slice(0, MEETINGS_Q_MAX) } : {}), ...(f.role ? { role: f.role } : {}), ...(f.fresh ? { new: "1" } : {}),
    ...(f.space ? { space: f.space } : {}) };
  return meGw<MyMeetingsPage>(key, "/api/v1/me/meetings", { query });
}

export async function meetingParticipants(key: string, id: string): Promise<MeResult<MeetingParticipants>> {
  return meGw<MeetingParticipants>(key, `/api/v1/records/${id}/participants`);
}
