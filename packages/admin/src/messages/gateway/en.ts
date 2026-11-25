// Messages in the language of the current request. One export per dictionary.
export const GATEWAY_TEXT = {
  unreachable: "The gateway is not responding. Check that the gateway service is running and reachable from the admin panel",
  responseLost: "The memory response was interrupted. It is unknown whether the action completed",
  httpError: (status: number): string => `The gateway returned HTTP error ${status}`,
  healthUnexpected: "The gateway returned an unexpected response to /api/v1/health",
  healthUnreachable: "The gateway is not responding",
};
