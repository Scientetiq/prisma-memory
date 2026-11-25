// Messages in the language of the current request. One export per dictionary.
export const WEB_ROLE_TEXT = {
  invalid: (v: string): string => `MEMORY_WEB_ROLE=${v.slice(0, 20)}: expected all, workplace or panel`,
};
