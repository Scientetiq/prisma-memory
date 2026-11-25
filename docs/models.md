# Models

This guide is for administrators who connect language, embedding and reranking models to **Prisma Memory**.
It covers the connections, what data goes where, and how to change the embedding model on a filled database.
See also: [configuration](./configuration.md), [the models section of the installation guide](./installation.md#models), and [troubleshooting](./troubleshooting.md).

## Connecting models after an install

**What it provides.** A fresh installation names no model. It stores records and searches them by keyword until
you connect a chat model, which writes summaries and extracts events, and an embedding model, which adds search
by meaning. A reranker is optional and off by default.

**Which data goes where:**

- The chat model receives the text of records. The embedding model receives passages and search queries.
- A model call goes out only to an endpoint and a model listed in `models.allow_open` (open records only) or in
  `models.allow_closed` (open and closed records). Any other call is refused and the record waits.
- List a cloud endpoint in `models.allow_open`. List a server of your own in `models.allow_closed`.
- API keys are stored encrypted and are sent only to the address of their own connection.

**Settings** (the model settings of the panel, or a provisioning file):

| Key | Default | Purpose |
| --- | --- | --- |
| `models.chat_provider` | `""` | Kind of API of the chat model: `openai-compatible`, `anthropic` or `gemini` |
| `models.chat_base_url`, `models.chat_model`, `models.chat_api_key` | empty | Address, model name and key of the chat model |
| `models.embeddings_provider` | `""` | Kind of API of the embedding model: `openai-compatible`, `voyage`, `cohere` or `gemini` |
| `models.embeddings_base_url`, `models.embeddings_model`, `models.embeddings_api_key` | empty | Address, model name and key of the embedding model |
| `models.embeddings_params` | `{}` | Overrides of the embedding profile, for example `{"dims": 2048, "native_dims": 2048}` |
| `models.allow_open`, `models.allow_closed` | `[]` | Pairs `{"base_url": …, "model": …}` that may receive records |

The file `deploy/compose/provision/models.example.json` holds these settings with example values. Copy it, put in
your addresses and model names, and apply the copy on the server:

```bash
deploy/bin/memory-admin provision apply - < models.json
```

An item can be written when its stored value is NULL or the seed default. If the proposed value is already in force,
provisioning reports `same_value`. When the file contains the complete legacy model profile, provisioning keeps the
whole profile if any member is marked `changed`. Enter the API keys in the panel.

**How to check.** In the authenticated admin `GET /api/v1/health` response, look at `checks.embedder.detail`.
With no active embedder, it gives a `keyword-only` reason. A search with a query in the default mode `hybrid` then
carries the note `No embedding model is configured: results are keyword-only`.

**Common errors:**

| Code | What to do |
| --- | --- |
| `keyword-only: no embedding model configured` | Connect an embedding model and list it in `models.allow_open` or `models.allow_closed` |
| A record waits and the audit log shows a refused model call | The endpoint or the model is not listed: add the pair to `models.allow_open` or `models.allow_closed` |

## Recommended models

**What it provides.** A starting choice of the embedding model. The evidence is a lab bench on one synthetic
corpus in English and Russian, 338 questions in hybrid search, and not an installed product.

| Your situation | Model | Stored dimension | Cost class | Evidence near the top (MRR@10): all / English / Russian |
| --- | --- | --- | --- | --- |
| Recommended | `voyage-4` | 2048 | about 0.06 USD per million tokens | 0.575 / 0.599 / 0.536 |
| You only have an OpenAI key | `text-embedding-3-large` | 1024 | about 0.13 USD per million tokens | 0.547 / 0.589 / 0.481 |
| Own hardware, open weights | `bge-m3` | 1024 | your hardware | 0.561 / 0.603 / 0.494 |

Notes on this table:

- The recommended model was in the best group of the bench and the cheaper of that group: no measured model was
  significantly better. It needs its full dimension, so set `{"dims": 2048, "native_dims": 2048}` in
  `models.embeddings_params`, as the example file does.
- The OpenAI model works. It is weaker on material that is not English.
- The open model runs on any server with an OpenAI-compatible embeddings API, and no text leaves your network.
- The second and the third model store 1024 numbers per vector, which is half the index size of the first.
- No reranker is recommended yet. Search merges the keyword and the meaning results without one.
- No chat model is recommended yet. Choose one that returns JSON by a strict schema.
- Prices are those of the vendors' price lists in November 2026.

**How to check.** After you connect the model, load a few records and search for a phrase by meaning, in words
the records do not contain. The search answer must carry no keyword-only note.

Each embedding model keeps its own vectors and its own index, and vectors of two models are never mixed. To move
to another model later without losing search, use the second connection described in the next section.
## Changing the embedding model on a filled database

**What it provides.** You can move search by meaning to another embedding model while search keeps working.
The next model fills its vectors in the background and takes over search once every chunk it may see has a vector.

**Which data goes where:**

- The two embedding connections, `models.embeddings_*` and `models.embeddings_b_*`, each name one model.
- The connection that holds the search model serves search, and the next model goes into the other connection.
  After a switch they trade places.
- The worker registers the next model as the *candidate*. The job `embed_backfill` then sends the text of every live
  chunk to the candidate's model in batches, under the candidate's data policy. Search stays on the current model.
- New documents get vectors from both models in the meantime.
- Search never mixes vectors of two sources. Each vector records its source: the connection's address, model, vector
  space and vector generation, but never the key. The vector part of a search uses only vectors of the query's source.
- If you change a connection's address or model, its stored vectors become stale. Search finds those chunks by keyword,
  and the search answer says so in a note. Health counts the stale vectors.
- Stale vectors are not computed again on their own, because each recomputation is paid. To recompute them, set
  `recompute_stale` in `retrieval.reembed` to `true`, until the admin page has a «Recompute vectors» action.
- The setting works once. It applies to the vectors that are stale when you set it. When they are all recomputed,
  the worker sets it back to `false`. After a later change of the connection, set it again.
- The setting counts only the vectors the backfill can recompute: chunks of current, visible records, in a class the
  connection may see, and not set aside after a rejected input. Vectors of hidden or deleted records, of old versions
  and of set-aside chunks stay stale and do not keep the setting on.
- When the setting goes back to `false`, by the worker or by you, its permission ends. A later change of the
  connection, or a return to an earlier one, needs a new setting.
- Every vector that this release stores records its source. A vector without a source is stale: search does not
  use it. `adoption_seen` in `retrieval.reembed`, the health line about adopted vectors and the audit event
  `embedder_vectors_adopted` concern vectors stored without a source, which a new installation of this release does
  not have.
- The worker looks at a connection before it stores the connection's first vector. If that look fails, preparing
  records for search waits and tries again in a minute.
- The text of a record that is moving between the open and the closed class is not sent. Its chunks wait until the
  move settles, and then they are filled in the record's new class.
- A record that is prepared for search for the first time while it is moving is not found by keyword either until
  the move settles. Its chunks are written only after the move.

**Settings** (the **Models** and **Processing** sections):

| Key | Default | Purpose |
| --- | --- | --- |
| `retrieval.reembed` | `{"batch": 64, "max_chunks_per_run": 5000, "pause_ms": 0, "sweep_min": 30, "auto_switch": true, "retain_days": 7, "recompute_stale": false, "adoption_seen": false}` | Backfill batch size, chunks per run, pause between batches, sweep timer in minutes, automatic switch, days the previous model is kept, recomputation of stale vectors, the adoption line seen |
| `processing.rebuild_disk` | `"auto"` | Free-space check of the database volume while vectors are added: `auto`, `require` or `skip` |
| `models.embeddings_b_provider`, `models.embeddings_b_base_url`, `models.embeddings_b_model`, `models.embeddings_b_api_key` | empty | Second embedding connection, for the next model |

Notes on these settings:

- `sweep_min` is read when the worker starts.
- `auto_switch` lets the switch happen on its own once every chunk is covered.
- `retain_days` is how long the previous model and its vectors are kept for a rollback before the vectors are deleted.
- `recompute_stale` lets the backfill recompute stale vectors, which is paid. It works once and turns itself off when
  they are done.
- `adoption_seen` hides the health line about adopted vectors without a source.
- With `auto`, free space is checked only when the gateway guards disk paths (`MEMORY_DISK_GUARD_PATHS`). Without such
  paths the rebuild runs, and health notes that free space is not checked.
- With `require`, the rebuild is refused when no disk paths are guarded. With `skip`, free space is never checked.

**The switch never narrows coverage on its own.** The automatic switch waits in either of these cases:

- The next model may see fewer classes of records than the current one. This counts by the data policy now, and by the
  vectors the current model already holds, even when its connection was later switched off, removed or narrowed.
- The next model rejected some chunks, which are then parked.

Health line `embedding_index` says how many chunks would become keyword-only. Only a confirmed switch passes. The
confirmation will be on the admin page, which is not in the panel yet. Only after a confirmed switch are the previous
model's vectors deleted after `retain_days`. Without the confirmation they are kept, and health says why.

**How to check.** Read the health line `embedding_index`.

| State | When |
| --- | --- |
| degraded | Stops that need an administrator: `config`, `stalled`, `disk` |
| warning | A rebuild in progress, with done and total chunks per database |
| warning | Chunks not included or parked |
| warning | Chunks waiting for a class move |
| warning | Records whose preparation for search has waited long for a class move (`index_held_long`) |
| warning | A changed vector source, with the vectors still to recompute and how to recompute them |
| warning | Vectors without a source adopted as the current model's, with their number |
| warning | A held purge of the previous model |
| warning | An unguarded disk |
| ok | The previous model is still kept, with its rollback date |

Audit events (`admin`):

| Event | When |
| --- | --- |
| `embedder_switch` | The automatic switch |
| `embedder_cancel` | A candidate was cancelled because its connection changed |
| `embedder_purge` | Strict, written before the previous model is closed |
| `embedder_vectors_deleted` | Every deletion of vectors, per database |
| `embedder_source_changed` | A connection's source changed; carries the number of vectors to recompute |
| `embedder_vectors_adopted` | Vectors without a source were adopted as the current model's, once; carries their number |
| `embedder_vector_generation_raised` | An operator recompute of the vectors; carries the number of vectors |
| `embedder_recompute_requested` | `recompute_stale` was set; carries the number of vectors to recompute |
| `embedder_recompute_done` | The vectors asked for by `recompute_stale` are recomputed, and the setting is off again |

**Common errors:**

| Code | What to do |
| --- | --- |
| `config` | The setup is wrong (a missing vector index, an embedder id outside the index rule, a failed source check of the databases): follow the detail, fix the schema or the databases; the first good pass of the same model in that database clears the stop |
| `stalled` | More than 200 chunks were rejected by the next model: check its input limit and the rejected chunks; the stop stays while that model is the candidate, so fix the model or change its connection, which cancels the candidate |
| `disk` | The database volume lacks the free space the vectors need: free space or extend the volume |
| `provider` | The embedding service failed or refused: the backfill pauses and resumes by itself; check the connection and its key |
| `lock` | The records were busy for several runs in a row: the backfill resumes by itself; check for long transactions |
| `index_held_long` | A class move of the record does not finish: check it on the **Data class moves** tab; the stage repeats by itself and wakes as soon as the move settles |
| `index_store_locked` | The vectors of a record were computed, and paid for, but not saved: on the stage's last attempt the record, its chunks, the chunks of its previous version or the vector index were locked by another operation. The stage is failed and does not repeat by itself. Keyword search already finds the record; the backfill adds the missing vectors at its next sweep (`retrieval.reembed.sweep_min`), paid once more. Find the long transaction or the index rebuild in the records database and let it end, then press **Retry** on the stage or **Process now** on the record (the tool `memory_process_now`): either sets the attempts back to zero. Raising `processing.retries.limit` also lets the stage run again |
| `index_wait` | Preparing a record for search waits one minute: the record, its chunks, the chunks of its previous version or the vector index are locked by another operation (the name after the colon: `record_busy`, `record_chunks_busy`, `superseded_chunks_busy`, `vector_index_busy`). Nothing to do. The wait is free while no vectors were computed; a pass that had computed them keeps its attempt, and on the last of `processing.retries.limit` attempts it fails as `index_store_locked` |

See also: [configuration](./configuration.md), [the models section of the installation guide](./installation.md#models), [troubleshooting](./troubleshooting.md).

---

[README](../README.md) · [Quick start](./quickstart.md) · [Installation](./installation.md) ·
[Backup and restore](./backup.md) · [Configuration](./configuration.md) · [Models](./models.md) ·
[Troubleshooting](./troubleshooting.md) · [Glossary](./glossary.md)
