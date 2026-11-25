"use client";
import { createContext, useContext, useLayoutEffect, type Dispatch, type SetStateAction } from "react";

export interface NavOverride { path: string; at: string }

export const NavHereContext = createContext<Dispatch<SetStateAction<NavOverride | null>> | null>(null);

export function navPath(pathname: string, here: NavOverride | null): string {
  return here && here.at === pathname ? here.path : pathname;
}

export function NavHere({ path, at }: { path: string; at: string }) {
  const set = useContext(NavHereContext);
  useLayoutEffect(() => {
    if (!set) return;
    const mine: NavOverride = { path, at };
    set(mine);
    return () => set((cur) => (cur === mine ? null : cur));
  }, [set, path, at]);
  return null;
}
