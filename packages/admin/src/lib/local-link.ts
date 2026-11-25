export function linkFromHash(hash: string): string | null {
  const link = hash.startsWith("#") ? hash.slice(1) : hash;
  return /^mem_lnk_[A-Za-z0-9_-]{43}$/.test(link) ? link : null;
}
