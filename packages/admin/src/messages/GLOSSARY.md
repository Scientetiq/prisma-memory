# Interface glossary (English)

Binding for every English catalog of the panel and the workspace (`src/messages/**/en.ts`). Terms marked **fixed** are
labels that people, the agents' skill or the MCP contract quote literally: use them exactly as written. The Russian
locale keeps today's words. Use the matching keys in the `en.ts` and `ru.ts` files to find each pair.

## Terms

| Term | Use for | Note |
|---|---|---|
| {product} | the product name ("Prisma Memory" by default) | a parameter, never written into a text; an installation may set its own name |
| memory, company memory | what the product keeps for the company | |
| workspace | the employee interface | |
| admin panel | the administrators' interface | |
| space | a container of records | |
| personal space, team space, project, Company knowledge | the kinds of spaces | as in the MCP contract |
| record | one item stored in memory | never "entry" or "item" |
| note, document, meeting, meeting summary | kinds of records | |
| decision, task, risk or question, fact | kinds of statements inside records | |
| open record, visible to agents | a record that AI agents may read | the panel may say "open" |
| closed record, people only | a record that only people may read | |
| Show to agents, Hide from agents | the actions that open or close a record | |
| Make available to agents | the action of the same name | **fixed** |
| open check | the check before a record becomes open | as in the MCP contract |
| AI agent | a program that works with memory; "agent" after the first mention | |
| Connect an agent, Keys and agents | the sections of the same names | **fixed** |
| personal key, extended key, service key | the kinds of keys | |
| Overview, My records, Search | the sections of the same names | |
| Spaces and projects, New project | the section and its action | **fixed** |
| Meetings with me, Colleagues | the sections of the same names | **fixed** |
| Company knowledge review | the review of shared records by curators | |
| My actions, My profile | the sections of the same names | **fixed** |
| Bulk changes, change plan | changes to many records at once, and their plan | |
| Record edits, correction | the section, and one proposed edit | **fixed** |
| Trash, Delete permanently, Restore | the trash and its actions | |
| Handed over to me, custodian | records handed over to a person, and that person | **fixed** |
| Service access, External access | the sections of the same names | |
| How we work | the section of the same name | **fixed** |
| Show to colleagues, Ask to delete | the actions of the same names | **fixed** |
| Useful, Wrong, not for everyone | the feedback buttons | **fixed** |
| owner, member, read-only | the roles inside a space | |
| curator | the person who reviews shared records | |
| org table, department | the company structure and its unit | |
| company account, single sign-on | the person's account at the company, and signing in with it | |
| Settings, Services, Report, Audit log | the admin sections of the same names | |
| Unprocessed, Alerts, Readiness | the admin sections of the same names | |
| Security mode | the admin section of the same name | the modes "Standard" and "Hardened" keep their names |
| model gateway, gateway | the service that calls models, and the product's server | admin panel only |
| night window | the hours of heavy nightly processing | |
| today, yesterday | relative days in dates | |

## Style

- Natural product English for an employee without technical training: sentence case, "you" and "your".
- No internal codes in the workspace (T0/T2, slug, "class"); the admin panel may name technical things it configures.
- Quotes “ ”, the ellipsis "…", no exclamation marks.
- Dates day first with a 24-hour clock: "5 October 2026, 16:03", "today, 16:03", "5–11 October".
- Do not translate word for word: keep the information, write the sentence an English product would show.
- Whole sentences only: never glue fragments; counts go through a catalog function with the number as its parameter;
  mixed markup goes through `rich()`.
