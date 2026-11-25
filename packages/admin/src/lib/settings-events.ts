export const SETTINGS_DIRTY_EVENT = "memory:settings-dirty";
export const SETTINGS_SAVED_EVENT = "memory:settings-saved";

export interface SettingsDirtyDetail { section: string; dirty: boolean }
export interface SettingsSavedDetail { section: string; ok: boolean }

export function emitSettings(name: typeof SETTINGS_DIRTY_EVENT, detail: SettingsDirtyDetail): void;
export function emitSettings(name: typeof SETTINGS_SAVED_EVENT, detail: SettingsSavedDetail): void;
export function emitSettings(name: string, detail: SettingsDirtyDetail | SettingsSavedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(name, { detail }));
}

export const sectionFormSelector = (section: string): string => `form[data-settings-section="${section}"]`;
