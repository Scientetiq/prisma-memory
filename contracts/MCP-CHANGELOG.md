# MCP contract: version history

The version number of the MCP contract `contracts/mcp-tools.json` (the tool catalogue) is `server.version`. The REST
contract `contracts/openapi-ingest.yaml` carries the same number in `info.version`; a version that changes only REST
says so. Tool outputs are strict (`additionalProperties: false`, closed enums). A client caches the tool listing for
up to 300 s, or until a long agent session restarts, and a client holding an older listing rejects a response with
new fields. A version that adds output fields therefore says "restart agent sessions". The note of the current
version is also in `server.protocol.notes` of `contracts/mcp-tools.json`.

## 0.35.0

The first public version.

- Server id: `prisma-memory`. MCP clients choose their own connection names.
- Outputs are strict. A client that connected before the deployment must restart agent sessions so that it fetches
  the current tool listing.
- Texts are English by default: tool titles and descriptions, schema descriptions, instructions, resources and
  prompts. With the setting `locale.mcp_language` = `ru`, the gateway serves the Russian texts of
  `contracts/locales/ru/mcp-tools.json` over the same schemas; names, schemas, codes and limits are shared.
- The REST contract is `contracts/openapi-ingest.yaml`, titled "Prisma Memory · Gateway REST API". It is served on
  `/api/v1/…` by the same gateway that serves MCP on `/mcp`.
- The project line of the instructions reads «Project memory: space <slug>».
- Audit actor labels are English display labels, for example "me".
- Examples use reserved domains (`corp.test`, `example.com`) and made-up names.
