// Messages in the language of the current request. One export per dictionary.
export const STATUS_TEXT = {
  expired: "Your session has ended",
  idsRequired: "No record IDs were provided",
  tooMany: (max: number): string => `You can request at most ${max} records at a time`,
};
