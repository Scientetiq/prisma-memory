import type { Metadata } from "next";
import { connection } from "next/server";
import type { ReactNode } from "react";
import { productName } from "@/i18n/brand";
import { currentLocale, instanceProductName, instanceTz } from "@/i18n/runtime";
import { root } from "@/messages/root";
// Styles in this order: the fonts, then the base tokens and components (base.css), then the service layer. The order matters.
import "./fonts.css";
import "./base.css";
import "./memory.css";
import "./ux-panel.css";
import "./ux-connect.css";
import "./ux-home.css";
import "./ux-spaces.css";
import "./ux-search.css";
import "./ux-service.css";
import "./ux-common.css";

/**
 * Head of every page in the locale of the request: the product name is the title (and the suffix of page titles), the
 * description comes from the catalog. Rendered per request, like every page of the panel.
 */
export async function generateMetadata(): Promise<Metadata> {
  await connection();
  const product = productName();
  return {
    title: { default: product, template: `%s · ${product}` },
    description: root.description,
    robots: { index: false, follow: false },
  };
}

/**
 * The document: <html lang> is the locale of the request; data-tz is the time zone of the installation and data-product
 * the installation's own product name (only when it has one): client components read all three from here.
 */
export default async function RootLayout({ children }: { children: ReactNode }) {
  await connection();
  const product = instanceProductName();
  return (
    <html lang={currentLocale()} data-tz={instanceTz()} {...(product ? { "data-product": product } : {})}>
      <body>{children}</body>
    </html>
  );
}
