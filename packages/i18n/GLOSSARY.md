# Product glossary (English)

One glossary for every English text of the product: server messages (`packages/*/src/messages/**`), setting
descriptions, e-mails and the interface. Terms marked **fixed** are labels that people, the agents' skill or the MCP
contract quote literally: use them exactly as written. The Russian locale keeps today's words.

The first table is the interface glossary of the admin package (`packages/admin/src/messages/GLOSSARY.md`), repeated
here so that server texts name things the way the interface does; change both files in one commit.

## Interface terms

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

## Server and settings terms

| Term | Use for | Note |
|---|---|---|
| installation | one deployed copy of the product with its settings | "instance" only for the technical identifier |
| the memory | the product as an actor in a sentence ("the memory checks…") | {product} where a message can take the parameter |
| gateway | the product's server process (MCP and REST) | |
| worker | the background processing process | |
| model gateway | the service through which models are called | never a vendor name |
| semantic search model, reranker | the embeddings model and the reranking model | |
| chunk | a piece of text prepared for search | |
| stage | one step of the processing pipeline | |
| document converter, converter | the service that turns files into text | never a product name |
| original, original file | the uploaded file a record was made from | |
| open class, closed class | the two data classes of records | "open records", "closed records" in running text |
| directory | the company's LDAP directory (Active Directory) | "company account" for a person's account in it |
| OIDC provider, provider | the OpenID Connect or OAuth server used for sign-in | Keycloak only as an example |
| sign-in, sign in, sign out | entering and leaving | never "login" for the action; "login" is the account name |
| org table | the uploaded company structure | |
| former employee, custodian | a person deactivated by the org table, and who takes over their records | |
| test account, demo persona | accounts that are not employees | |
| on behalf of | a service acting for a person (X-On-Behalf-Of) | in quotes when it names the feature |
| system key | the installation's administrative key | |
| edge, external perimeter | the read-only copy reachable from the internet | |
| bridge, exporter, receiver, reconciler | the services between the memory and the edge | |
| anchors | the pinned values the edge and the inner perimeter are checked against | |
| External access | the feature a person switches on to sign in from the internet | **fixed**; "sign-in from outside", "outside connection" in running text |
| connection | an agent's authorised link to the memory | |
| probe, synthetic sign-in | the scheduled outside checks of the edge | |
| second factor, recovery codes | the second sign-in step and its spare codes | |
| second signature | approval of an action by another administrator | |
| weakening | a change that lowers protection | |
| alert, high alert | a notification to administrators | not "alarm" |
| basic, advanced | the two security modes | lower case, as the setting values |
| emergency access | the break-glass sign-in window | |
| audit log | the journal of events | |
| health, degraded | the health check and its warning state | |
| test installation | an installation used for testing | |

## Style

- Natural product English: sentence case; "you" and "your" for the employee, "the administrator" in admin texts.
- Setting descriptions: one or a few short sentences, no full stop at the end; ranges as "(1–60)"; values of a setting
  in plain text as they are stored (`off`, `"document"`); other settings are named by key (`smtp.enabled`), interface
  sections and buttons in “ ”.
- Quotes “ ”, the ellipsis "…", the en dash for ranges and for "value — meaning", no exclamation marks.
- A setting the code does not read says so: "Reserved: this version does not read it".
- No company names, internal addresses, people or decision numbers; examples use `example.com` and `example.test`.
- Do not translate word for word: keep the information, write the sentence an English product would show.
