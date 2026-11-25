// The gateway's process wiring that logs a failure: the handler of an unhandled rejection lives here and
// not in src/index.ts, which starts the whole gateway and cannot be imported — a test runs it as the process does. The line
// carries a class of failure.ts, never the rejection's message, name, code, cause or stack.
import { failureClass } from "@memory/connectors";
import { log } from "@memory/shared";

/** process.on("unhandledRejection") of the gateway: an error line with the class, the process keeps serving. */
export const unhandledRejectionLine = (e: unknown): void => { log.error("unhandled_rejection", { error: failureClass(e) }); };
