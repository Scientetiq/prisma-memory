# Make → Prisma Memory

`workflow.json` is a **manual setup recipe**, not an importable Make blueprint.
It describes mail → webhook and form → note. Make and code modules are separate
products and are not included. Signing is tested against the real handler;
execution in Make is **not verified live** (owner account required).
Runtime built-ins and raw HTTP mappings must be checked in that account.

## Set up

1. In Prisma Memory, enable `integrations.connectors_enabled` and
   `integrations.webhooks_enabled`. Create an active generic `webhook` connector
   and configure its owner, target, data class and consent policy. Obtain its UUID
   and **webhook signing secret**, not an API key or push token. Leave bearer
   mode disabled.
2. Make must reach the HTTPS origin's `/api/v1/hooks/` and its item status route.
   A private installation needs trusted ingress or automation inside its network.
   Check that the listener allows the hook paths. The origin
   `https://memory.example.test` is a placeholder, not a hosted service.
3. Select an email or form trigger and follow its variant in `workflow.json`.
   Use a JavaScript code step with an `input` object, Node's built-in `crypto`,
   `Buffer`, `URL` and `Date`; paste `sign.js`. Confirm built-in support in your
   Make Code runtime before activation. No npm package is needed. If those
   built-ins are unavailable, run this same function body in a trusted private
   Node runner with `input` and `require` supplied by the runner; map its returned
   object back into the scenario. The JSON recipe is deliberately independent
   of third-party code-module IDs. Do not substitute an untrusted public signer.
4. Map trusted `base_url`, `connector_id`, `event_id`, `variant` (`mail` or `form`),
   `operation: "post"`, and `source` (an object or JSON string). Source fields:
   stable `id` (Message-ID/submission ID), nonempty plain `text`, optional mail
   `subject` or form `title`. For example:
   `{"id":"submission-17","title":"Feedback","text":"A useful note."}`.
   Mail becomes a note; attachments and HTML conversion are not included.
5. Map `signing_secret` from protected configuration, not from a source event or
   a shared blueprint. Restrict scenario editors and execution-history retention;
   Code inputs can contain the secret even though the script never returns it.
   Where protected inputs are unavailable, keep the secret only on the private
   signer and send it trusted normalized fields. Never allow source data to
   control the signer origin, connector or signing configuration.
6. Add **HTTP → Make a request**: POST to returned `url`, **Raw** request body,
   content type `application/json`, and returned `body` without quoting, trimming,
   or JSON conversion. Map all returned headers individually: `webhook-id`,
   `webhook-timestamp`, `webhook-signature` and `content-type`. Disable redirects
   so content cannot be forwarded to a different destination.
7. Continue on 202, or 200 with `duplicate: true`. Add a ten-second delay, then
   call the code again with `operation: "status"`, `external_id` and `type` from
   the original signing output, the same trusted configuration/event ID and
   protected secret. Make exactly one GET to its returned `url` with its new
   headers and an empty body; keep redirects disabled. Route the returned state
   to an appropriate success, wait or review branch.

## Signature, retry and state

Standard Webhooks uses HMAC-SHA256 over `webhook-id.webhook-timestamp.body`, with
the base64-decoded bytes after `whsec_` as the key. The timestamp is Unix seconds;
the MAC header is `v1,` followed by base64. Keep the runner clock synchronized
(default window: 300 seconds). Forward the exact signed raw UTF-8 string. Any
JSON reserialization or changed whitespace invalidates its signature. The status
GET signs an empty body, never the POST payload, and creates no replay event.
Keep the method, item ID and type fixed: this signature does not sign the URL.

For a retry after a timeout, 429 or 5xx, execute signing again with the same
event ID and identical source revision/body; use a fresh timestamp and bounded
backoff honoring `Retry-After`. Avoid delayed HTTP-only retries with expired
headers. `event_id` is stable per provider event/revision (letters, digits,
`._:-`, 1–256 characters). Persist a SHA-256 hex event ID if the source identifier
uses other characters. Keep `source.id` across updates and use a new event ID
for changed content. A duplicate 200 is a queued acknowledgement. Fix a 400
mapping error; investigate 401/404 configuration instead of looping indefinitely.

202 means **staged**, not delivered. One status lookup can return `staged`,
`delivered`, `held` with a reason, or `failed` with a reason; an identical existing
item can be `unchanged`. If still staged, inspect the Connectors page later.
Held items require the indicated policy/placement/consent correction. Do not
treat a 202 or duplicate 200 as proof that the record is already in memory.

## Meetings

For `variant: "meeting"`, map source `id`, `started_at` (RFC 3339), plain
`transcript`, optional `title`/`language` (default `en`) and `participants`.
Use `{"email":"speaker@example.com","role":"attendee","attendance_confirmed":true}`
only with provider attendance evidence; calendar participants use `role: "invitee"`.
Only a confirmed boolean becomes `attended: true`, never for an invitee. Names,
truthy strings and arbitrary `attended` inputs do not establish attendance.
The connector policy controls access; it may be owner-only by default, and
unconfirmed colleagues may need organizer confirmation. Sources never choose
consent, class, space or owner.

Source IDs consisting only of `.` or `..` are rejected because URL clients
normalize those path segments. Map them to a stable prefixed ID upstream for
both POST and status reads.
