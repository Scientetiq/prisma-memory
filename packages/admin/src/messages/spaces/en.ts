import type { ProjectTab } from "../../lib/spaces";
export const spaces = {
  personalAndCompanyWide: "Personal and company-wide",
  departmentAndTeams: "Department and teams",
  projects: "Projects",
  myTeam: "My team",
  myTeams: "My teams",
};

export const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

export const PROJECT_TAB_TITLES: Record<ProjectTab, string> = { overview: "Overview", records: "Records", members: "Members", repo: "For developers", settings: "Settings" };
