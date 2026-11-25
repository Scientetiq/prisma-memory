// Messages in the language of the current request. One export per dictionary.
export const UPLOAD_TEXT = {
  tooLarge: (max: number): string => `The file exceeds ${max} MB`,
  origin: "Files can only be uploaded from workspace pages",
  expired: "Your session has ended — sign in again",
  formRequired: "Expected a form containing a file",
  fileRequired: "No file was provided",
  invalidSpace: "Invalid space",
  cannotWrite: "You cannot write to this space. Choose your personal space or a space where you are an owner or member",
};
