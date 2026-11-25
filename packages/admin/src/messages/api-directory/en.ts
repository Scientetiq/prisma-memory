// Messages in the language of the current request. One export per dictionary.
export const DIRECTORY_TEXT = {
  expired: "Your session has ended — sign in again",
  tooShort: (min: number): string => `Type at least ${min} characters`,
  tooLong: (max: number): string => `Use no more than ${max} characters`,
};
