export const isWholeInternet = (cidr: string): boolean => /\/0$/.test(String(cidr).trim());

export function isNetBound(cidrs: readonly string[] | null | undefined): boolean {
  return Array.isArray(cidrs) && cidrs.length > 0 && !cidrs.some(isWholeInternet);
}
