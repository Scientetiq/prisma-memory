# n8n → Prisma Memory

These files are our templates; n8n is a separate product and is not included.
The signing code is tested against the real Prisma Memory route handler. Workflow
structure is checked locally; import and execution in n8n are **not verified live**.
No n8n installation or additional JavaScript dependency is needed for those tests.

## Set up

1. In Prisma Memory, enable connector ingestion and signed webhooks in Settings
   (`integrations.connectors_enabled`, `integrations.webhooks_enabled`). Create and
   activate a generic `webhook` connector. Set its owner, target, data class and
   consent policy. Copy its UUID and its **webhook signing secret**, not a provider
   API key or a bearer push token. Do not enable bearer mode for these templates.
2. Your n8n host must reach the instance over HTTPS at `/api/v1/hooks/`, including
   the item status path. Cloud n8n needs a reachable public ingress; a private
   instance needs a trusted tunnel or a self-hosted runner inside its network.
   Verify that your listener permits these paths: a normal API health check alone
   does not establish webhook reachability. The example origin
   `https://memory.example.test` is a placeholder, not a service.
3. On a trusted self-hosted n8n runner, allow only the built-in `crypto` module for
   the Code node (`NODE_FUNCTION_ALLOW_BUILTIN=crypto`). Provide
   `PRISMA_WEBHOOK_SECRET` through protected runner configuration and permit the
   trusted Code node to access it. Never paste the secret into workflow JSON,
   pinned data, or a source trigger. A cloud runner that disallows this needs a
   private signing service; do not use a public signing website.
4. Import `mail.workflow.json` or `form.workflow.json`. Both are inactive and start
   with a manual trigger and synthetic input. Edit **Example input**: set
   `base_url` to the HTTPS instance origin and `connector_id` to the UUID. Replace
   the manual trigger and example node with your email/form trigger and field
   mapping when the example succeeds. `sign.js` is exactly the **Sign webhook**
   Code node, in **Run Once for All Items** mode. Process one source item per run;
   split batches upstream so that a source item cannot be silently dropped.
5. Map `source.id` to the stable email Message-ID or form submission ID,
   `source.text` to nonempty plain text, and `source.subject` (mail) or
   `source.title` (form) to an optional title. Both produce a `note`; mail
   attachments and HTML conversion are not included. Map `event_id` to a stable
   provider event/revision identifier, using letters, digits, `._:-` (1–256
   characters). If a Message-ID contains other characters, derive and persist a
   SHA-256 hex event ID in the trigger mapping. Keep `source.id` unchanged for
   updates; give each changed revision a new `event_id`.
6. **Send webhook** uses POST, the returned URL and all returned headers, and
   `body` in **raw** mode with `application/json`. Keep redirects disabled on both
   HTTP nodes. **Wait for delivery** waits ten seconds, **Sign status** signs an
   empty body with a fresh timestamp, and **Read status** issues exactly one GET.
   It uses the item ID and type from **Sign webhook**, not the HTTP response.

## Signature, retries and outcomes

Standard Webhooks uses HMAC-SHA256 with the base64-decoded bytes after `whsec_`:
`webhook-id.webhook-timestamp.body`. Send `webhook-id`, `webhook-timestamp` (Unix
seconds) and `webhook-signature` (`v1,` plus a base64 MAC). The snippet serializes
once: preserve the exact UTF-8 raw body, including Unicode and whitespace. Do not
parse it into the HTTP node's JSON editor. Keep the runner clock synchronized;
the default acceptance window is 300 seconds. Signing material is never returned
by the snippet. Restrict workflow editors and protect execution history: source
texts, signed requests and trigger data can still appear there.

For a retry after a timeout, 429 or 5xx, run the signing step again with the same
event ID and the same source revision/body; use a fresh timestamp and honor
`Retry-After` with bounded backoff. Do not rely on a delayed HTTP-only retry with
old headers. A 200 with `duplicate: true` acknowledges an already queued event;
it does not mean delivered. Correct a 400 mapping error; inspect configuration
for 401/404 rather than retrying forever.

202 means durably **staged**, not yet in memory. The one status lookup can report
`staged`, `delivered`, `held` (inspect `reason`) or `failed` (inspect `reason`).
`unchanged` is also possible for an existing identical item. If still staged,
inspect the Connectors page later; the workflow does not poll indefinitely or
report ingestion success as delivery success. A status GET signs an empty body
and creates no replay event. Keep its method, item path and type fixed; Standard
Webhooks authenticates the event ID, timestamp and body, not the URL or method.

## Optional meeting mapping

Use `variant: "meeting"` with `source.id`, `source.started_at` (RFC 3339),
`source.transcript` (plain text), optional `title` and `language` (default `en`),
and `participants`. For example:

```json
{"participants":[{"email":"speaker@example.com","role":"attendee","attendance_confirmed":true},{"email":"invited@example.com","role":"invitee"}]}
```

Map `attendance_confirmed: true` only from provider attendance evidence. It becomes
`attended: true`; calendar invitees remain `role: "invitee"` without attendance.
A truthy string or an arbitrary `attended` field is ignored. Names and calendar
invitations alone do not establish access. The connector policy determines access;
the default policy may keep records owner-only, and unconfirmed colleagues may
need organizer confirmation. The source cannot set consent, owner, class or space.

Source IDs consisting only of `.` or `..` are rejected because URL clients
normalize those path segments. Map them to a stable prefixed ID upstream for
both POST and status reads.
