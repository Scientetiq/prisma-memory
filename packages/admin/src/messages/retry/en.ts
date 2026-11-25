export const retry = {
  requested: (product: string, seconds: number): string => `${product} asks you to wait ${seconds} s — this page will refresh automatically.`,
  again: (seconds: number): string => `We will try again in ${seconds} s — this page will refresh automatically.`,
  repeat: (seconds: number): string => `Retrying in ${seconds} s — this page will refresh automatically.`,
  refreshing: "Refreshing…",
  busy: (product: string, attempted: boolean): string => `${product} is ${attempted ? "still" : "currently"} busy. Try again a little later.`,
  manual: "Try again.",
};

export const unavailable = {
  limited: (product: string): string => `${product} is currently busy.`,
  unreachable: (product: string): string => `${product} is not responding.`,
  setup: (product: string): string => `${product} is not accepting requests right now. An administrator needs to finish setting it up.`,
  other: (product: string): string => `${product} did not respond.`,
};
