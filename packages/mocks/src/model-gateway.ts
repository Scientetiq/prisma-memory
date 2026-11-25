//   pnpm --filter @memory/mocks model-gateway -- --port 8700 --host 127.0.0.1 --protocol openai
import { defaultListenHost, isLoopbackHost, MODEL_GATEWAY_MOCK_DEFAULTS as D, MODEL_GATEWAY_MODES, MODEL_PROTOCOLS, ModelGatewayMock, type ModelGatewayMode, type ModelProtocol } from "./model-gateway-server.ts";

const argv = process.argv.slice(2);
function opt(name: string, env: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[i + 1] : "1";
  return process.env[env];
}
const num = (v: string | undefined, d: number) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
const pick = <T extends string>(v: string | undefined, all: readonly T[], d: T): T => (all.includes(v as T) ? v as T : d);

const port = num(opt("port", "PORT"), 8700);
const mode = pick<ModelGatewayMode>(opt("mode", "MOCK_MODEL_MODE"), MODEL_GATEWAY_MODES, D.mode);
const given = (v: string | undefined) => (v !== undefined && v.trim() !== "" ? v.trim() : undefined);   // empty means "not given", never "every interface"
const host = given(opt("host", "MOCK_MODEL_HOST")) ?? defaultListenHost(mode);
const recordToken = given(process.env.MOCK_MODEL_RECORD_TOKEN) ?? null;
if (mode === "record" && !isLoopbackHost(host) && !recordToken) {
  console.error(JSON.stringify({ event: "mock_model_gateway_refused", host, mode,
                                 reason: "record mode holds the upstream key: on an address other than loopback it starts only with MOCK_MODEL_RECORD_TOKEN" }));
  process.exit(2);
}
const models = opt("models", "MOCK_MODEL_IDS");
const mock = new ModelGatewayMock({
  protocol: pick<ModelProtocol>(opt("protocol", "MOCK_MODEL_PROTOCOL"), MODEL_PROTOCOLS, D.protocol),
  models: models ? models.split(",").map((m) => m.trim()).filter(Boolean) : D.models,
  strictModels: ["1", "true"].includes(String(opt("strict-models", "MOCK_MODEL_STRICT") ?? "")),
  embedDims: num(opt("embed-dims", "MOCK_MODEL_EMBED_DIMS"), D.embedDims),
  fill: num(opt("fill", "MOCK_MODEL_FILL"), D.fill),
  mode,
  fixturesDir: opt("fixtures", "MOCK_MODEL_FIXTURES") ?? null,
  upstream: opt("upstream", "MOCK_MODEL_UPSTREAM") ?? null,
  upstreamKey: given(process.env.MOCK_MODEL_UPSTREAM_KEY) ?? null,   // trimmed: the key as the header carries it
  recordToken,
  slowMs: num(opt("slow-ms", "MOCK_MODEL_SLOW_MS"), D.slowMs),
});
const actual = await mock.listen(port, host);
const s = mock.state();
console.log(JSON.stringify({ event: "mock_model_gateway_started", host, port: actual, protocol: s.protocol, mode: s.mode, models: s.models,
                             embed_dims: mock.opts.embedDims, fill: s.fill, fixtures: mock.opts.fixturesDir !== null, upstream: mock.opts.upstream !== null, record_token: recordToken !== null }));
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { void mock.close().then(() => process.exit(0)); });
