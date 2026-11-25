import Link from "next/link";
import { productName } from "../i18n/brand";
export { brand as BRAND_TEXT } from "../messages/common";
import { Icon } from "./icons";

export function BrandMark() {
  return <span className="brand-mark" aria-hidden="true"><Icon name="layers" /></span>;
}

export function Brand({ sub, href }: { sub?: string; href?: string }) {
  const inner = <><BrandMark /><span className="brand-name">{productName()}</span>{sub ? <span className="brand-sub">{sub}</span> : null}</>;
  return href ? <Link href={href} className="brand" prefetch={false}>{inner}</Link> : <div className="brand">{inner}</div>;
}
