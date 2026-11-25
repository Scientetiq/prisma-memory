// Messages in the language of the current request. One export per dictionary.
export const PREVIEW_TEXT = {
 previewDenied: "Preview is read-only",
 previewDeniedHint: "In preview you can only browse, search and read. To make changes, leave preview and sign in to the workspace with your own account.",
  bar: (persona: string, role: string): string => `You are viewing as ${persona} (${role}, a fictional colleague for demonstration). This is read-only: you cannot save, upload or delete records, show records to agents, issue keys or change members here.`,
};
