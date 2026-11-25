import "server-only";
import { connectorGw } from "./connector-api";
import { GatewayError } from "./gateway";

export interface ConnectorOptions {
  people: Array<{ id: string; login: string; display_name: string; active: boolean }>;
  spaces: Array<{ id: string; name: string; slug: string; kind: string; default_class: "open" | "closed" }>;
  more: boolean;
  error: boolean;
}
export async function loadConnectorOptions(peopleQuery = "", spaceQuery = ""): Promise<ConnectorOptions> {
  const results = await Promise.allSettled([
    connectorGw<{ items: ConnectorOptions["people"]; next_cursor?: string }>("/api/v1/admin/people", { query: { active: true, limit: 100, q: peopleQuery.slice(0, 100) } }),
    connectorGw<{ items: ConnectorOptions["spaces"]; next_cursor?: string }>("/api/v1/admin/spaces", { query: { exclude: "personal", limit: 100, q: spaceQuery.length >= 2 ? spaceQuery.slice(0, 100) : "" } }),
  ]);
  for (const r of results) if (r.status === "rejected" && !(r.reason instanceof GatewayError)) throw r.reason;
  return {
    people: results[0].status === "fulfilled" ? results[0].value.items : [],
    spaces: results[1].status === "fulfilled" ? results[1].value.items.filter((s) => s.kind === "team" || s.kind === "project") : [],
    more: results.some((r) => r.status === "fulfilled" && r.value.next_cursor),
    error: results.some((r) => r.status === "rejected"),
  };
}
