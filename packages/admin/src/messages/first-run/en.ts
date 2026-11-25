
export const TEXT = {
  firstRunCodeHint: "The code is on the server: setup wrote it to the file secrets/gateway/first-run-code in the installation's home directory, and the Install code line of setup's summary shows the command that prints it. If that file does not exist, the gateway printed a code once in its log (event first_run_code_generated). Only someone with server access can see it.",
  theGatewayReturnedHTTP: (value1: string | number | null | undefined): string => `The gateway returned HTTP ${value1}`,
  tooManyIncorrectCodesInARow: (value1: string | number | null | undefined): string => `Too many incorrect codes in a row. Try again in ${value1} min.`,
  theFirstAdministratorHasAlreadyBeenCreated: "The first administrator has already been created. Sign in with that account.",
  theSetupCodeDidNotWorkCheck: "The setup code did not work. Print it again on the server with the command of the Install code line of setup's summary (the file secrets/gateway/first-run-code in the installation's home directory; if that file does not exist, the gateway's log event first_run_code_generated), copy only the code with nothing after it, and enter it again.",
};
