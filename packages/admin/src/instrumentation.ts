// Start of the panel process: Next awaits register() before the first request. The Node runtime reads the instance
// values (interface language, time zone, product name) from the gateway once, at most 3 s; afterwards they refresh on
// demand (src/i18n/instance.server.ts). Other runtimes do nothing here.
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { startInstanceReader } = await import("./i18n/instance.server");
  await startInstanceReader();
}
