// n8n Code node, Run Once for All Items. Allow only the crypto built-in on a trusted runner.
const input = { ...$input.first().json, signing_secret: $env.PRISMA_WEBHOOK_SECRET };
// Standard Webhooks: send the returned body as raw UTF-8, without parsing or reserializing it.
const { createHmac } = require("crypto");
const base = new URL(input.base_url);
if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
  throw new Error("Configure an HTTPS instance origin without credentials, path, query or fragment.");
}
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.connector_id || "")) {
  throw new Error("Configure the webhook connector UUID.");
}
// Use the provider's stable event/revision id; a random execution id would defeat replay protection.
if (typeof input.event_id !== "string" || !/^[A-Za-z0-9._:-]{1,256}$/.test(input.event_id)) {
  throw new Error("Map a stable source event id using letters, digits, dots, underscores, colons or hyphens.");
}
const secret = input.signing_secret;
if (typeof secret !== "string" || !secret.startsWith("whsec_")) throw new Error("Configure the signing secret in protected storage.");
const encoded = secret.slice(6);
const key = Buffer.from(encoded, "base64");
if (key.length < 24 || key.length > 64 || key.toString("base64") !== encoded) throw new Error("Invalid signing secret format.");
const operation = input.operation || "post";
if (!["post", "status"].includes(operation)) throw new Error("Unknown operation.");
let item, external_id, type;
if (operation === "post") {
  const source = typeof input.source === "string" ? JSON.parse(input.source) : input.source;
  if (!source || typeof source.id !== "string" || !source.id) throw new Error("Map the stable source item id.");
  external_id = source.id;
  if (input.variant === "mail" || input.variant === "form") {
    if (typeof source.text !== "string" || !source.text) throw new Error("Map nonempty plain text.");
    type = "note";
    item = { type, external_id, text: source.text };
    const title = input.variant === "mail" ? source.subject : source.title;
    if (title) item.title = title;
  } else if (input.variant === "meeting") {
    type = "meeting";
    if (typeof source.transcript !== "string" || !source.transcript || !source.started_at) throw new Error("Map the transcript and start time.");
    item = { type, external_id, started_at: source.started_at, language: source.language || "en", transcript: { text: source.transcript, format: "plain" } };
    if (source.title) item.title = source.title;
    item.participants = (source.participants || []).map((p) => {
      const role = p.role === "invitee" ? "invitee" : p.role === "host" ? "host" : "attendee";
      const participant = { role };
      if (p.email) participant.email = p.email;
      if (p.name) participant.name = p.name;
      // This boolean must come from provider attendance evidence; calendar membership is insufficient.
      if (role !== "invitee" && p.attendance_confirmed === true) participant.attended = true;
      return participant;
    });
  } else throw new Error("Choose the mail, form or meeting variant.");
} else {
  external_id = input.external_id;
  type = input.type;
  if (typeof external_id !== "string" || !external_id || !["note", "meeting"].includes(type)) throw new Error("Map the original item id and type for the status lookup.");
}
// Dot-only path segments are normalized away by URL clients, even when percent-encoded.
if (external_id === "." || external_id === "..") throw new Error("Prefix dot-only source ids with a stable source namespace.");
// Serialize once. GET is signed over an empty body, never over the original POST payload.
const body = operation === "status" ? "" : JSON.stringify({ items: [item] });
const timestamp = String(Math.floor(Date.now() / 1000));
const signature = "v1," + createHmac("sha256", key).update(`${input.event_id}.${timestamp}.`, "utf8").update(body, "utf8").digest("base64");
const url = `${base.origin}/api/v1/hooks/${input.connector_id}`
  + (operation === "status" ? `/items/${encodeURIComponent(external_id)}?type=${encodeURIComponent(type)}` : "");
// Never return the secret or the whole input object to the platform's execution history.
const result = {
  url, method: operation === "status" ? "GET" : "POST", body, external_id, type,
  base_url: base.origin, connector_id: input.connector_id, event_id: input.event_id,
  headers: { "content-type": "application/json", "webhook-id": input.event_id, "webhook-timestamp": timestamp, "webhook-signature": signature },
};
return [{ json: result }];
