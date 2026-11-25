// Messages in the language of the current request. One export per dictionary.
export const TRANSPORT_TEXT = {
  absoluteSocket: "Gateway address unix:/absolute/path requires an absolute path",
  addressScheme: "Gateway address must be http(s)://… or unix:/absolute/path",
  panelOnly: "The admin panel (MEMORY_WEB_ROLE=panel) cannot access the workplace gateway",
  workplaceOnly: "The workspace (MEMORY_WEB_ROLE=workplace) cannot access the gateway admin API",
  adminAddressRequired: "GATEWAY_ADMIN_URL is missing: the admin panel (MEMORY_WEB_ROLE=panel) requires the gateway admin listener address",
};
