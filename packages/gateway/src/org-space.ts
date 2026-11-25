// The organizational space (kind org, slug org) for people — "Company shared knowledge":
// one name in the base (the workplace, the panel and the agent in memory_me see it) and in gateway texts for people. A new org
// gets it from the org table load; on running instances 04-seed.sql renames the old "Organizational" — only if the administrator
// has not touched it. The slug, the /org path, kind='org' and the org_curator role do not change.
export const ORG_SPACE_NAME = "Company knowledge";
export const ORG_SPACE_DESCRIPTION = "Policies, reference guides and employee profiles";
