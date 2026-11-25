"use client";
// Language switch: a plain form to POST /api/locale with one button per locale, each named in its own language. Works
// without JavaScript (the hidden `return_to` is the path the page gives); with JavaScript the path and query the
// browser shows are sent instead. The answer is a full page load, so server and client parts change language together.
// The field is not called `next`: the sign-in pages already carry a `next` of their own.
import type { FormEvent } from "react";
import { currentLocale } from "../i18n/runtime";
import { language, LANGUAGE_NAMES } from "../messages/language";

export function LanguageSwitch({ returnTo, className }: { returnTo: string; className?: string }) {
  const current = currentLocale();
  const keepPlace = (e: FormEvent<HTMLFormElement>): void => {
    const field = e.currentTarget.elements.namedItem("return_to");
    if (field instanceof HTMLInputElement && typeof location !== "undefined") field.value = `${location.pathname}${location.search}`;
  };
  return (
    <form method="post" action="/api/locale" className={className ? `lang-switch ${className}` : "lang-switch"} aria-label={language.label} onSubmit={keepPlace}>
      <input type="hidden" name="return_to" value={returnTo} />
      {LANGUAGE_NAMES.map(({ locale, name }) => (
        <button key={locale} type="submit" name="locale" value={locale} lang={locale} aria-pressed={locale === current}>{name}</button>
      ))}
    </form>
  );
}
