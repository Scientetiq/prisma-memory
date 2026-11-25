import { Server, type JSONRPCRequest, type Result, type ServerContext } from "@modelcontextprotocol/server";

type Handler = (request: JSONRPCRequest, context: ServerContext) => Promise<Result>;

/** The SDK keeps the revision negotiation, validation and cache hints; the rights are read only at the handshake. */
export class InstructionsServer extends Server {
  private pendingInstructions?: Promise<string>;

  constructor(
    info: ConstructorParameters<typeof Server>[0],
    options: ConstructorParameters<typeof Server>[1],
    private readonly resolveInstructions: () => Promise<string>,
  ) {
    super(info, options);
  }

  protected override _wrapHandler(method: string, handler: Handler): Handler {
    if (method !== "initialize" && method !== "server/discover") return super._wrapHandler(method, handler);
    // The hook is called both in super() and when the SDK transport re-registers discover as usual. Subclass fields are read
    // only at the request. The spread runs BEFORE the super wrapper: the SDK keeps the cache hint under a symbol, we keep it.
    return super._wrapHandler(method, async (request, context) => ({
      ...await handler(request, context),
      instructions: await (this.pendingInstructions ??= this.resolveInstructions()),
    }));
  }
}
