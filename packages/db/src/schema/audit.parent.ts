import { pgTable, uuid, timestamp, text, jsonb, integer, inet, primaryKey, check } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const auditEvents = pgTable("audit_events", {
  id: uuid().defaultRandom().notNull(),
  at: timestamp({ withTimezone: true, mode: "string" }).defaultNow().notNull(),
  instanceId: text("instance_id").notNull(),
  eventType: text("event_type").notNull(),
  keyId: uuid("key_id"),
  principalType: text("principal_type"),
  principalId: uuid("principal_id"),
  onBehalfOf: uuid("on_behalf_of"),
  serviceId: uuid("service_id"),
  tier: text(),
  class: text(),
  recordIds: uuid("record_ids").array().default([]).notNull(),
  spaceId: uuid("space_id"),
  queryText: text("query_text"),
  filters: jsonb(),
  resultCount: integer("result_count"),
  details: jsonb().default({}).notNull(),
  clientLabel: text("client_label"),
  ip: inet(),
}, (table) => [
  primaryKey({ columns: [table.id, table.at], name: "audit_events_pkey" }),
  check("audit_events_event_type_check", sql`event_type = ANY (ARRAY['read','search','list','write','promote','open','forget','extended_key_use','t1_fallback','confirmation','admin','processing','auth_failure','rate_limited','class_move','purge'])`),
]);
