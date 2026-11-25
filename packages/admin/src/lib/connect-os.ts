import { text as M } from "../messages/connect-os";
import { derived } from "../i18n/runtime";
import type { OAuthShell } from "./oauth-connect";

export type ConnectOs = "mac" | "windows" | "linux";
export const CONNECT_OSES: readonly ConnectOs[] = ["mac", "windows", "linux"];
export const isConnectOs = (v: unknown): v is ConnectOs => typeof v === "string" && (CONNECT_OSES as readonly string[]).includes(v);

export function osFromHeaders(h: { get(name: string): string | null }): ConnectOs {
  const hint = (h.get("sec-ch-ua-platform") ?? "").replace(/"/g, "").trim();
  if (hint && !/^unknown$/i.test(hint)) {
    if (/win/i.test(hint)) return "windows";
    if (/mac|ios/i.test(hint)) return "mac";
    if (/linux|chrom|android/i.test(hint)) return "linux";
  }
  const ua = h.get("user-agent") ?? "";
  if (/Windows/i.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "mac";
  if (/Linux|X11|CrOS/i.test(ua)) return "linux";
  return "mac";
}

export function resolveOs(param: string, h: { get(name: string): string | null }): { os: ConnectOs; auto: boolean } {
  return isConnectOs(param) ? { os: param, auto: false } : { os: osFromHeaders(h), auto: true };
}

export const osShell = (os: ConnectOs): OAuthShell => (os === "windows" ? "powershell" : "posix");

export const OS_TITLE: Record<ConnectOs, string> = { mac: "macOS", windows: "Windows", linux: "Linux" };

export type KeyStep = { keys: readonly string[] } | { say: string };

export interface OsGuide {
  app: string;
  openTitle: string;
  open: readonly KeyStep[];
  paste: readonly KeyStep[];
  pasteNote: string | null;
}

export const OS_GUIDE: Record<ConnectOs, OsGuide> = derived(() => ({
  mac: {
    app: M.terminal, openTitle: M.openTerminal,
    open: [{ keys: ["cmd", "space"] }, { say: M.typeTerminal }, { keys: ["enter"] }],
    paste: [{ keys: ["cmd", "v"] }, { keys: ["enter"] }],
    pasteNote: null,
  },
  windows: {
    app: "PowerShell", openTitle: M.openPowershell,
    open: [{ keys: ["win"] }, { say: M.typePowershell }, { keys: ["enter"] }],
    paste: [{ keys: ["ctrl", "v"] }, { keys: ["enter"] }],
    pasteNote: M.ifAskedAboutMultipleLinesClick,
  },
  linux: {
    app: M.terminal, openTitle: M.openTerminal,
    open: [{ keys: ["ctrl", "alt", "t"] }],
    paste: [{ keys: ["ctrl", "shift", "v"] }, { keys: ["enter"] }],
    pasteNote: null,
  },
}));

export function codexKeyLineFor(os: ConnectOs, key: string): string {
  if (os === "windows") return `setx MEMORY_KEY "${key}"`;
  const rc = os === "linux" ? "~/.bashrc" : "~/.zshrc";
  return `echo 'export MEMORY_KEY="${key}"' >> ${rc} && source ${rc}`;
}
