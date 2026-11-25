import type { Context } from "hono";

export const NOT_IMPLEMENTED = { code: "not_implemented", message: "This function is not switched on in this release yet" } as const;
export const SESSION_EXPIRED = { code: "session_expired", message: "The administrator session has ended. Sign in again" } as const;
export const ROLE_FORBIDDEN = { code: "role_forbidden", message: "This action is not available to your role" } as const;
export const BREAKGLASS_ONLY = { code: "breakglass_only", message: "Emergency access allows only actions that narrow access" } as const;
export const STEPUP_REQUIRED = { code: "stepup_required", message: "Touch the key once more: this action needs a fresh confirmation" } as const;

export const notImplemented = (c: Context): Response => c.json(NOT_IMPLEMENTED, 501);
