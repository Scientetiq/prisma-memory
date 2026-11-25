"use client";
import { SHELL_TEXT } from "../messages/components";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { startTransition, useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { productName } from "../i18n/brand";
import { Brand, BrandMark } from "./brand";
import { ConfirmDialog } from "./confirm-dialog";
import { Icon, type IconName } from "./icons";
import { LanguageSwitch } from "./language-switch";
import { NavHereContext, navPath, type NavOverride } from "./nav-here";
import { ToastProvider } from "./toasts";

export interface NavItem { href: string; title: string; icon: IconName; count?: number | null; exact?: boolean; also?: string[]; hint?: string }
export interface NavSection { label?: string; items: NavItem[] }
export interface NavItem { countLabel?: string; alert?: { n: number; label: string } | null }

interface Props {
  sub: string;
  home?: string;
  sections: NavSection[];
  user: { name: string; sub: string };
  logout: (formData: FormData) => Promise<void>;
  logoutTitle?: string;
  logoutExtra?: ReactNode;
  accountActions?: ReactNode;
  children: ReactNode;
  beforeMain?: ReactNode;
}

const MOBILE = "(max-width: 800px)";
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapTarget<T>(items: readonly T[], current: T | null, back: boolean): T | null {
  if (!items.length) return null;
  const i = current === null ? -1 : items.indexOf(current);
  if (i < 0) return back ? items[items.length - 1]! : items[0]!;
  if (back && i === 0) return items[items.length - 1]!;
  if (!back && i === items.length - 1) return items[0]!;
  return null;
}

export function navActive(item: NavItem, path: string): boolean {
  const under = (href: string) => path === href || path.startsWith(`${href}/`);
  return (item.exact || item.href === "/" || item.href === "/admin" ? path === item.href : under(item.href)) || (item.also ?? []).some(under);
}

export function Shell({ sub, home, sections, user, logout, logoutTitle = SHELL_TEXT.logout, logoutExtra, accountActions, children, beforeMain }: Props) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [mobile, setMobile] = useState(false);
  const asideRef = useRef<HTMLElement>(null);
  const burgerRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(false);
  const [here, setHere] = useState<NavOverride | null>(null);
  const [leaving, setLeaving] = useState<FormData | null>(null);
  const drawer = mobile && open;

  useEffect(() => setOpen(false), [pathname]);
  useEffect(() => {
    const mq = window.matchMedia(MOBILE);
    const apply = () => setMobile(mq.matches);
    apply();
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);
  useEffect(() => {
    if (!drawer) return;
    const root = document.documentElement;
    root.classList.add("drawer-open");
    return () => root.classList.remove("drawer-open");
  }, [drawer]);
  useEffect(() => {
    if (!mobile) { wasOpen.current = open; return; }
    if (open) asideRef.current?.querySelector<HTMLElement>("a, button")?.focus();
    else if (wasOpen.current) burgerRef.current?.focus();
    wasOpen.current = open;
  }, [open, mobile]);

  const current = navPath(pathname, here);
  const isActive = (item: NavItem) => navActive(item, current);
  const onAsideKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (!drawer || e.key !== "Tab" || !asideRef.current) return;
    const items = Array.from(asideRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    const next = trapTarget(items, document.activeElement as HTMLElement | null, e.shiftKey);
    if (next) { e.preventDefault(); next.focus(); }
  };
  const onLogout = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setLeaving(new FormData(e.currentTarget));
  };

  return (
    <NavHereContext.Provider value={setHere}>
    <ToastProvider>
      <a className="skip-link" href="#content">{SHELL_TEXT.skip}</a>
      {beforeMain}
      <div className="app">
        <div className="mobile-bar" inert={drawer}>
          <button ref={burgerRef} type="button" className="burger" aria-label={open ? SHELL_TEXT.closeMenu : SHELL_TEXT.openMenu} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            <Icon name={open ? "x" : "menu"} />
          </button>
          {home
            ? <Link href={home} prefetch={false} className="bar-brand"><BrandMark /><strong>{productName()}</strong></Link>
            : <><BrandMark /><strong>{productName()}</strong></>}
          <span className="bar-right muted small">{sub}</span>
        </div>
        <div className={open ? "side-overlay show" : "side-overlay"} onClick={() => setOpen(false)} aria-hidden="true" />
        <aside ref={asideRef} className={open ? "side open" : "side"} aria-label={SHELL_TEXT.navigation} inert={mobile && !open} onKeyDown={onAsideKey}>
          <div className="side-head">
            <button type="button" className="side-close" aria-label={SHELL_TEXT.closeMenu} onClick={() => setOpen(false)}><Icon name="x" /></button>
            <Brand sub={sub} href={home} />
          </div>
          {sections.map((s, i) => (
            <nav className="nav" key={i} aria-label={s.label ?? SHELL_TEXT.sections}>
              {s.label ? <div className="nav-sec">{s.label}</div> : null}
              {s.items.map((item) => {
                const active = isActive(item);
                return (
                  <Link key={item.href} href={item.href} prefetch={false} className={active ? "active" : undefined} aria-current={active ? "page" : undefined}
                    title={item.hint} aria-description={item.hint}>
                    <Icon name={item.icon} />
                    {item.title}
                    {item.count !== undefined && item.count !== null ? <span className="count" title={item.countLabel} aria-hidden={item.countLabel ? true : undefined}>{item.count}</span> : null}
                    {item.alert ? <span className="count-alert" title={item.alert.label} aria-hidden="true">{item.alert.n}</span> : null}
                    {item.countLabel && item.count !== undefined && item.count !== null ? <span className="vis-hidden">{item.countLabel}</span> : null}
                    {item.alert ? <span className="vis-hidden">{item.alert.label}</span> : null}
                  </Link>
                );
              })}
            </nav>
          ))}
          <div className="side-user">
            <span className="ava" aria-hidden="true">{initials(user.name)}</span>
            <div className="who"><b title={user.name}>{user.name}</b><span title={user.sub}>{user.sub}</span></div>
            <form action={logout} className="logout-form" onSubmit={onLogout}>
              {logoutExtra}
              <button type="submit" className="out" title={logoutTitle} aria-label={logoutTitle}><Icon name="logout" /><span className="out-label" aria-hidden="true">{SHELL_TEXT.logout}</span></button>
            </form>
          </div>
          {accountActions}
          <LanguageSwitch className="side-lang" returnTo={pathname ?? home ?? "/"} />
        </aside>
        <main className="main" id="content" tabIndex={-1} inert={drawer}>{children}</main>
      </div>
      <ConfirmDialog spec={leaving ? { question: `${logoutTitle}?`, verb: SHELL_TEXT.logout } : null} onCancel={() => setLeaving(null)}
        onConfirm={() => { const data = leaving; setLeaving(null); if (data) startTransition(() => logout(data)); }} />
    </ToastProvider>
    </NavHereContext.Provider>
  );
}

function initials(name: string): string {
  const parts = name.trim().split(/[\s@._-]+/).filter(Boolean);
  const s = parts.length >= 2 ? `${parts[0]![0]}${parts[1]![0]}` : (parts[0] ?? "?").slice(0, 2);
  return s.toUpperCase();
}
