# Zapier → Prisma Memory

`workflow.json` is a **manual setup recipe**, not a Zapier export or an importable
Zap. It includes mail → webhook and form → note variants. Zapier is not included;
use is subject to Zapier Platform terms and your plan's available actions.
Signing is tested against the real handler; Zapier execution is **not verified
live** (owner account required).

## Set up

1. In Prisma Memory, enable `integrations.connectors_enabled` and
   `integrations.webhooks_enabled`, create an active generic `webhook` connector,
   and configure its owner, target, data class and consent policy. Get its UUID
   and **webhook signing secret**. Leave bearer mode disabled.
2. Zapier must reach the HTTPS instance origin's `/api/v1/hooks/` and status path.
   For a private installation, arrange a trusted ingress or run automation inside
   its network. Check that the listener allows these routes. Replace the
   placeholder origin `https://memory.example.test` with your instance origin.
3. Select a **new email** or **new form submission** trigger. Follow the variant
   in `workflow.json`. Add **Code by Zapier → Run JavaScript** and paste `sign.js`.
   It uses the Node `crypto` built-in, without installing packages.
4. Map Code Input Data: `base_url`, `connector_id`, `event_id`, `variant` (`mail`
   or `form`), `operation` (`post`) and `source` (a JSON string). Set `source.id`
   to a stable Message-ID/submission ID, `source.text` to nonempty plain text,
   and `source.subject` (mail) or `source.title` (form) to an optional title.
   For example, the form source is
   `{"id":"submission-17","title":"Feedback","text":"A useful note."}`.
   Mail becomes a note; attachments and HTML conversion are outside this recipe.
5. Supply `signing_secret` from protected account configuration, never from email
   or form fields. Code Input Data can be visible in Zap history: restrict editors,
   access and retention. If your plan cannot protect this value, place the signer
   on a private Node runner and send only trusted mapped fields to it. Do not put
   the secret in a shared Zap or a public signing service. The script never
   returns the secret or echoes input in errors.
6. Add **Webhooks by Zapier → Custom Request**. Set POST and the returned `url`.
   Map `body` directly to **Data** as a raw string; do not construct a JSON object,
   unflatten fields or wrap it in quotes. Set `Content-Type: application/json`
   and the returned `headers.webhook-id`, `headers.webhook-timestamp` and
   `headers.webhook-signature` as individual headers. Keep redirects disabled;
   if the action cannot enforce that, use a private HTTP runner that can.
7. Continue on 202, or 200 with `duplicate: true`. Add a ten-second delay, then
   another copy of `sign.js` with `operation: "status"`, the original signing
   output's `external_id` and `type`, the same trusted configuration and event ID,
   and the protected signing secret. Add one GET to the returned `url` with the
   newly returned headers, **no body**, and redirects disabled. This is exactly
   one status lookup; inspect its response before marking delivery successful.

## Signing and retry rules

Standard Webhooks signs `webhook-id.webhook-timestamp.body` with HMAC-SHA256 under
the base64-decoded `whsec_` key. `webhook-timestamp` is current Unix seconds;
`webhook-signature` is `v1,` plus the base64 MAC. Keep the runner clock synchronized
(default tolerance: 300 seconds). Preserve the exact signed raw UTF-8 bytes;
JSON reserialization, whitespace changes and Unicode changes invalidate the MAC.
Status GETs sign an empty body and create no replay event. Keep their item path,
type and method fixed: the signature covers the ID, timestamp and body, not URL.

For a retry after a timeout, 429 or 5xx, rerun Code with the same event ID and
source revision/body, a fresh timestamp and bounded backoff honoring `Retry-After`.
Do not rely on a platform HTTP-only replay after the signature expires. `event_id`
must be stable per source event/revision, 1–256 characters from letters, digits,
`._:-`; persist a SHA-256 hex mapping if the source ID uses other characters.
Keep `source.id` for updates; give a changed revision a new event ID. A duplicate
200 acknowledges queuing, not delivery. Fix a 400 mapping error; investigate
401/404 configuration instead of retrying them indefinitely.

202 means **staged**. The status may be `staged`, `delivered`, `held` with a reason,
or `failed` with a reason; identical existing content can be `unchanged`. A single
lookup may still be staged: inspect the Connectors page later. A held item needs
the indicated policy/placement/consent correction; do not claim it is in memory.

## Meetings

The same snippet accepts `variant: "meeting"`, source `id`, `started_at`
(RFC 3339), plain `transcript`, optional `title`/`language` (default `en`) and
participants such as
`{"email":"speaker@example.com","role":"attendee","attendance_confirmed":true}`.
Calendar-only participants use `role: "invitee"`. Only provider-confirmed boolean
`attendance_confirmed: true` becomes `attended: true`, never for an invitee.
Names, truthy strings and an arbitrary `attended` input do not establish attendance.
The connector policy determines access; it may be owner-only by default, and
unconfirmed colleagues may need organizer confirmation. Do not map source consent,
class, space or owner into the payload.

Source IDs consisting only of `.` or `..` are rejected because URL clients
normalize those path segments. Map them to a stable prefixed ID upstream for
both POST and status reads.
