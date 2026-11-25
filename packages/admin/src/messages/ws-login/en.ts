import { productName } from "../../i18n/brand";

export const LOGIN_PAGE_PLAIN = {
    get lead() { return `Sign in as you would to your computer or company email. ${productName()} does not store your password.`; },
    get down() { return `${productName()} is temporarily unavailable. Try again in a few minutes.`; },
    off: "Workspace sign-in is not enabled yet.",
    offAdmin: "A memory administrator enables it in the panel under “Sign-in and LDAP” or “Single sign-on (OpenID Connect)”. Until then, nobody can sign in to the workspace. Administrators can use “View as” in the panel to preview employee and manager views.",
    help: "Having trouble signing in?",
    get helpPassword() { return `Use the same login and password as for your computer. ${productName()} does not store or change passwords. If you forgot your password or it does not work, contact your company’s usual support team to change it.`; },
    helpAccess: "If your password works but memory says you have no access, your account is not in the memory access group.",
    details: "Details for administrators",
    admin: "Administrators: panel sign-in",
    fresh: "To enable external access, sign in again. You will be asked for your password even if you are already signed in.",
} as const;

export const TEXT = {
  enterYourLoginAndPassword: "Enter your login and password",
  refreshPage: "Refresh page",
  code: " code {value1}",
  theSignInPageIsOutOf: "<strong1>The sign-in page is out of date or could not open.</strong1> The service may have been updated while the page was open. Reload fully (Ctrl+F5, or Cmd+Shift+R on Mac) and sign in again. If it happens again, tell your memory administrator{value1}.",
  workspaceSignIn: "Workspace sign-in",
  signIn: "Sign in",
  signingIn: "Signing in…",
  detailsForAdministrators: "Details for administrators",
  password: "Password",
  login: "Login",
  signIn2: "Sign-in",
  or: "or",
  youHaveSignedOutYourAgentsKeys: "You have signed out. Your agents’ keys remain active.{value1}",
  allYourWorkspaceSessionsHaveEndedHere: "All your workspace sessions have ended, here and on other devices. Your agents’ keys remain active.{value1}",
  workspaceSignIn2: "Workspace sign-in",
  workspace: "workspace",
  exampleCom: "example.com",
  orUser: (value1: string | number | null | undefined): string => ` or ${value1}\\user`,
  userUserAsYouSignInTo: (value1: string | number | null | undefined, value2: string | number | null | undefined): string => `user, user@${value1}${value2} — as you sign in to your computer`,
};
