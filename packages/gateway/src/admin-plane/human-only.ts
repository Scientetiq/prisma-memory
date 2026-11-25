// People only: where it applies.
// A personal administrator session (mem_as_ through the identity provider) exists only on a separate admin listener (MEMORY_ADMIN_LISTEN):
// the main listener always refuses it (auth.ts, admin_token_on_main). In the older layout — an installation of its own without the
// admin plane add-on — nobody has a person's session, and the people-only rule would lock the keys of the always group, the roles
// memory_admin and security_auditor and cancelling an alert letter for all, a person in the panel too (there one signs in by
// the local administrator account or an old panel session). So those rules apply only where personal sessions exist; in
// the older layout all is as before: the perimeter cannot open there (the gate needs the admin listener on a unix socket, group 1
// needs a person's session). A standard deployment always has the admin listener. A module without route dependencies:
// settings-guard.ts, admin.ts and mail-admin.ts use it.
import { processTopology } from "./listeners.ts";

/** Whether the process has personal administrator sessions (a separate admin listener). */
export const humanSessionsHere = (): boolean => processTopology().adminSeparate;
