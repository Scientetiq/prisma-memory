// The settings keyring for connector secrets in the gateway: the secrets of connectors are encrypted with the
// keyring of secret settings. The gateway passes the keyring it loaded at start-up (App.settingsKeyring); an App
// built by hand (tests, tools) derives it from the application secret once.
import { settingsKeyring, type SettingsKeyring } from "@memory/shared/crypto";
import type { App } from "../context.ts";

const derived = new WeakMap<object, SettingsKeyring>();

/** The keyring that reads and writes connector secrets. */
export function connectorKeyring(app: App): SettingsKeyring {
  if (app.settingsKeyring) return app.settingsKeyring;
  let k = derived.get(app);
  if (!k) {
    k = settingsKeyring({ appSecret: app.appSecret });
    derived.set(app, k);
  }
  return k;
}
