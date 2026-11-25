import type { IconName } from "@/components/icons";

export const NAV_ICONS = {
  overview: "home",
  materials: "folder",
  search: "search",
  spaces: "layers",
  meetings: "mic",
  people: "users",
  team: "network",
  review: "badge-check",
  activity: "history",
  connect: "plug",
  keys: "key",
  plans: "list-checks",
  corrections: "pencil",
  trash: "trash",
  custody: "archive",
  profile: "circle-user",
  consents: "unlock",
  external: "globe",
  agentView: "monitor",      // "What my agent sees": what the person's agents find
  panelOverview: "gauge",
  processing: "inbox",
  deletionRequests: "file-x",
  roles: "shield",
  services: "server",
  preview: "eye",
  report: "chart",
  searchQuality: "activity",
  audit: "list",
  settings: "sliders",
  ldap: "log-in",
  sso: "id-card",
  agentLogin: "bot",
  mail: "mail",
  openCheck: "shield-check",
  operator: "user",
  edgeExport: "send",
  localFactor: "lock",       // "Two-step sign-in" of the local administrator
} as const satisfies Record<string, IconName>;

export type NavConcept = keyof typeof NAV_ICONS;
