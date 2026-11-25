export const SETTINGS_VALUES_TEXT = {
  numberRequired: "Enter a number",
  booleanRequired: "Choose “on” or “off”",
  invalidJson: (message: string): string => `Invalid JSON: ${message}`,
  arrayRequired: "Expected a JSON array: [ … ]",
  objectRequired: "Expected a JSON object: { … }",
  secretEdgeSpaceHint: "The password starts or ends with a space. It will be saved as entered.",
  changedInOtherWindow: "This setting was changed in another window. Refresh the page",
  clearKeyQuestion: (key: string, dirty: boolean): string => `Clear key “${key}”? Memory will stop working for all colleagues and their agents until a new key is entered. The panel does not show keys: you will need the key itself to restore service.${dirty ? " Unsaved changes to other fields in this category will be lost." : ""}`,
  emptiedQuestion: (keys: string[]): string => `${keys.length === 1 ? `The required setting “${keys[0]}” is empty.` : `Required settings are empty: ${keys.map((k) => `“${k}”`).join(", ")}.`} Saving now will stop memory for all colleagues and their agents until the values are entered again. Save with an empty value?`,
  requiredEmptyError: "Required setting: an empty value will stop memory for everyone. Enter a value. Clearing it requires confirmation.",
  changedElsewhere: "the setting changed in another tab. Refresh the page and try again",
};
