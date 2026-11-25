type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = (process.env.MEMORY_LOG_LEVEL as Level) ?? "info";

function emit(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = JSON.stringify({ at: new Date().toISOString(), level, component: process.env.MEMORY_ROLE ?? "gateway", event, ...fields });
  (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
}

export const log = {
  setLevel(l: string): void { if (l in ORDER) threshold = l as Level; },
  debug: (event: string, f?: Record<string, unknown>) => emit("debug", event, f),
  info: (event: string, f?: Record<string, unknown>) => emit("info", event, f),
  warn: (event: string, f?: Record<string, unknown>) => emit("warn", event, f),
  error: (event: string, f?: Record<string, unknown>) => emit("error", event, f),
};
