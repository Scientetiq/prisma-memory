import { TEXT } from "../messages/first-run";

export type FirstRunStatus = "needed" | "done" | "unreachable";
export interface FirstRunInfo { status: FirstRunStatus; codeRequired: boolean }

export function parseFirstRun(status: number, data: unknown): FirstRunInfo {
  if (status !== 200) return { status: "unreachable", codeRequired: false };
  const d = (data ?? {}) as { needed?: unknown; code_required?: unknown };
  return { status: d.needed === true ? "needed" : "done", codeRequired: d.code_required === true };
}


export function firstRunFailText(status: number, data: unknown, retryAfter?: number): string | null {
  if (status < 400) return null;
  const code = (data as { code?: unknown } | null)?.code;
  if (status === 403 && code === "first_run_code_invalid") return TEXT.theSetupCodeDidNotWorkCheck;
  if (status === 403) return TEXT.theFirstAdministratorHasAlreadyBeenCreated;
  if (status === 429) {
    const body = (data as { retry_after?: unknown } | null)?.retry_after;
    const wait = retryAfter ?? (typeof body === "number" && body > 0 ? body : 900);
    return TEXT.tooManyIncorrectCodesInARow(Math.max(1, Math.ceil(wait / 60)));
  }
  const message = (data as { message?: unknown } | null)?.message;
  return typeof message === "string" && message ? message : TEXT.theGatewayReturnedHTTP(status);
}

export { TEXT } from "../messages/first-run";
