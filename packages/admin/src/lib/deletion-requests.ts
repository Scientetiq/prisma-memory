import "server-only";
import { cache } from "react";
import { meGw } from "./me-api";
import { DELETION_REQUESTS_MESSAGES, DELETION_REASON_TITLES } from "../messages/deletion-requests";

export type DeletionStatus = "open" | "declined" | "kept";
export type DeletionReason = "by_mistake" | "private" | "no_consent" | "other";
export const DELETION_REASONS: readonly DeletionReason[] = ["by_mistake", "private", "no_consent", "other"];
export { DELETION_REASON_TITLES } from "../messages/deletion-requests";
export const deletionReasonTitle = (r: string | null | undefined): string | null => (r ? DELETION_REASON_TITLES[r as DeletionReason] ?? r : null);

interface Base { id: string; record_id: string; status: DeletionStatus; created_at: string; declined_at: string | null; kept_at?: string | null; reason?: DeletionReason | null; title: string | null }
export interface IncomingRequest extends Base { requester: { login: string; display_name: string | null }; requester_gone?: "left" | "removed" }
export interface OutgoingRequest extends Base { owner: { login: string; display_name: string | null } }
export interface MyDeletionRequests { incoming: IncomingRequest[]; outgoing: OutgoingRequest[] }
type PersonRef = { login: string; display_name: string | null };
export interface AdminDeletionRequest { id: string; record_id: string; status: DeletionStatus; created_at: string; declined_at: string | null; kept_at: string | null;
  kept_by: string | null; reason: DeletionReason | null; requester: PersonRef }
export interface AdminDeletionMeeting { record_id: string; class: "open" | "closed"; status: DeletionStatus; occurred_at: string | null; duration_sec: number | null;
  participants: number | null; space: { slug: string; name: string } | null; owner: PersonRef; requests: AdminDeletionRequest[]; kept: { at: string; by: string | null } | null }
export interface AdminDeletionRequests { items: AdminDeletionMeeting[]; next_cursor: string | null; open: number; declined: number; kept?: number }

/** Texts of this module that other sections read; one dictionary, so that it can follow the interface language. */
export { DELETION_REQUESTS_TEXT } from "../messages/deletion-requests";

export { REQUESTER_GONE } from "../messages/deletion-requests";

export const myDeletionRequests = cache(async (key: string): Promise<MyDeletionRequests> => {
  const res = await meGw<MyDeletionRequests>(key, "/api/v1/me/deletion-requests");
  return res.ok ? res.data : { incoming: [], outgoing: [] };
});

export { DELETION_REQUESTS_MESSAGES } from "../messages/deletion-requests";
