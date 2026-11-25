# Troubleshooting

This page helps administrators locate a failing check before changing **Prisma Memory** configuration.
It lists the checks that health names, where to look and what to do.
See also: [configuration](./configuration.md), [installation](./installation.md), and [models](./models.md).

## The essentials in one minute

1. Inspect `/api/v1/health` with the system key on the admin socket `run/admin/api.sock` of the home directory, the
   socket that step 5 of the [quick start](./quickstart.md) uses.
2. Find the named failing check; an external request receives only the overall status.
3. Treat `fail_closed` as a safety refusal: health returns HTTP 503 and normal requests are blocked.
4. Inspect individual checks for `degraded`; HTTP 200 alone does not mean that every component works.

Detailed checks require the system key or an administrator's session on the admin listener, or a system caller on an
internal channel.
Add `?force=1` to refresh cached checks.
Share check names, status codes, and record identifiers when reporting a problem; remove secrets and source content.

## Installation

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Health reports missing required settings | `checks.settings`; administrator settings response `missing_required` | Fill the named required values through the settings interface, then refresh health |
| Health refuses service because a record database has the wrong class or excessive privileges | `checks.db_open`, `checks.db_closed` | Have the operator restore the database class and application-role grants using the installed schema procedure |
| Gateway role can read or update the audit log | `checks.audit_append_only` | Restore the intended append-only role grants before resuming normal service |
| A second installation collides with an existing deployment | The line of `setup` that starts with `setup: refused:` | `setup` refuses before it changes an existing container. Give the second installation its own name with `--instance NAME`, its own home with `--home DIR` and two free ports, as [A second install on one server](../deploy/compose/README.md#a-second-install-on-one-server) describes |

## Models

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Processing appears ready but model requests fail | `checks.models`, `checks.llm`, and the model request error | For a direct connection, health checks configuration and data policy. Use the request error to check reachability |
| Health reports that the legacy gateway does not serve a model | `checks.platform` detail | Match the configured model names to the gateway's served names and refresh the check |
| Health reports that the legacy gateway cannot be reached | `checks.platform` detail | Check address, credentials, certificates, and connectivity from the gateway's network |

## Sign-in

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Directory sign-in fails while enabled | `checks.ldap` | Correct the named settings or restore directory DNS and TCP connectivity from the gateway |
| Identity-provider sign-in fails while enabled | `checks.oidc` | Correct the issuer settings or restore discovery access; inspect the named metadata problem |
| Directory group membership stops updating | `checks.group_sync` | Restore the directory and group synchronization; while synchronization fails, membership through a group is kept until `ldap.group_stale_hours` (24 h by default) passes without a successful sync, then removed until the directory answers (high alert `directory_groups_stale`) |

## Agents

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Agent authorization readiness fails | `checks.oauth` | Follow its readiness detail and verify the configured authorization mode and issuer |
| Proxied requests arrive under unexpected host names | `checks.external_channel` | Compare the observed host names with configured external and agent hosts; correct proxy host forwarding and host lists |
| Open-record writes fail while reading still works | `checks.open_check` | Inspect the checker thread state and retry delay; restore the checker rather than disabling content checks |

## Search

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Semantic search covers fewer records after a model or address change | `checks.embedding_index` | Search can find those chunks by keyword. To authorize backfill of stale vectors, set `recompute_stale` in `retrieval.reembed` to `true`. It defaults to `false`. See [models](./models.md#changing-the-embedding-model-on-a-filled-database) |
| A rebuild of the embedding model stopped | `checks.embedding_index` | Follow the stop's code (config, stalled, disk) in [models](./models.md#changing-the-embedding-model-on-a-filled-database) |
| Search results keep the order they had before reranking and carry the note `Reranker not called: order by RRF` | The search event in the audit log: the value of `details.rerank_failed` | `record_held`: one of the records the search was about to rerank could not be given to the reranking model at that moment. In a single search this means the record was changed, deleted or moved just then; nothing needs doing. When it repeats, a class move is in work for that record or for a record above it (its parent, or another version of the same agent note). This is a known effect: while the move is in work, no search whose candidates include that record or a record below it is reranked; nothing is missing from the results, only their order is not refined. The workers carry a move in work by themselves and it cannot be retried by hand: follow it on the **Data class moves** tab. Reranking returns when the move ends, whether it is done or has failed. If the move does not end, check that the workers are running. `policy_denied`: no move is involved — the data policy does not allow the reranking model to receive data of the search's class. A search counts as closed when the caller may read closed records or any of its candidates is closed, even if every result shown is open |

## Processing

| Symptom | Where to look | What to do |
| --- | --- | --- |
| Model stages are paused or awaiting a retry | `checks.llm` and processing retry times | Distinguish an intentional pause from a model failure; inspect the stated hold, timeout, or retry reason |
| Conversion waits or fails | `checks.converter` | Follow the converter detail; inspect its connection, credentials, and oldest waiting work |
| A record is found by keyword but not by meaning, and its search preparation waits or has failed | The stage's reason (`index_wait`, `index_store_locked`); the worker's log lines `index_vectors_lost` (`record_id`, `code`, `vectors_lost`: vectors that were paid for and not saved) and `stage_wait_past_limit` (a stage past its last attempt met a wait and was left failed) | Look for a long transaction or an index rebuild in the records database and let it end; a waiting stage then goes on by itself, a failed one needs **Retry**; see [models](./models.md#changing-the-embedding-model-on-a-filled-database) |
| Uploads stop while reading and search work | `checks.disk_guard` | Restore free space or access to the configured filesystem marker paths, then refresh health |
| Object storage is unavailable | `checks.storage` | Restore storage connectivity and credentials; check health again before retrying affected work |

## If something goes wrong

Read the table at the end of [installation](./installation.md#if-something-goes-wrong) for failures of the installer.
Include the failing check and the action already tried in a report; avoid attaching raw configuration or record
contents.

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
