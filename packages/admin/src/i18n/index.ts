// Public surface of the panel's i18n layer for pages, components and lib modules. rich() is imported from ./rich on its
// own, so that pure modules stay free of React; the server message API of the core (t, defineMessages, plural,
// explain, negotiate) is not part of the panel's surface.
export { DEFAULT_LOCALE, LOCALES, localeOf, pluralCategory, pluralEn, pluralRu, type Locale, type Messages, type PluralCategory } from "./core";
export * from "./runtime";
export * from "./format";
export * from "./brand";
