export const uploadQueue = {
  memoryIsNotAcceptingFiles: "Memory is not accepting files",
  uploadedAlreadySavedFailed: (value0: unknown, value1: unknown, value2: unknown): string => `Uploaded: ${value0} · Already saved: ${value1} · Failed: ${value2}`,
  memoryAsksYouToWaitSUploading: (value0: unknown): string => `Memory asks you to wait ${value0} s — uploading will resume automatically. Keep this page open`,
  noConnectionFileWasNotSent: "no connection: file was not sent",
  memoryIsStillAskingYouToWait: "memory is still asking you to wait — send this file later",
};
