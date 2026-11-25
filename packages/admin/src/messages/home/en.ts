export const text = {
  aiAgent: "AI agent",
  isConnected: (value0: string | number | null | undefined): string => `${value0} is connected`,
  andAreConnected: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} and ${value1} are connected`,
  andMoreAreConnected: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} and ${value1} more are connected`,
  text: "text",
  images: "images",
  upToMb: (value0: string | number | null | undefined, value1: string | number | null | undefined): string => `${value0} · up to ${value1} MB`,
  materialsLead: (t: { name: string; personal: boolean; defaultClass: "open" | "closed"; org?: boolean } | null, show: string): string => { const head = "Upload documents and write notes"; if (!t) return `${head}.`; if (t.personal) return t.defaultClass === "closed" ? `${head}. Only you can see new records; you can show a record to AI agents on its page — “${show}”.` : `${head}. You and your AI agents can see new records.`; const who = t.org ? "all company employees" : `members of “${t.name}”`; return t.defaultClass === "closed" ? `${head} — ${who} can see them; AI agents cannot.` : `${head} — ${who} and their AI agents can see them.`; },
};


export const HOME_TEXT = {
  materialsTitle: "My records",
  allMaterials: "All records",
  spacesTitle: "Spaces and projects",
  allSpaces: "All spaces and projects",
  emptyMine: "Your documents and notes will appear here.",
  emptyMineSub: "Upload a file or write down a thought — memory will find it when you need it.",

  transcripts: "Do not upload meeting transcripts here — the organiser sends them:",
  saveTo: "Will be saved in:",
};
