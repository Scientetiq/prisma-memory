import Link from "next/link";
import { Icon } from "@/components/icons";

export { MISSING_PLAIN } from "../messages/components";
import { MISSING_PLAIN } from "../messages/components";

export function MissingBody() {
  return (
    <div className="missing">
      <h1>{MISSING_PLAIN.title}</h1>
      <p className="sub">{MISSING_PLAIN.lead}</p>
      <div className="missing-actions">
        <Link href="/" className="btn primary" prefetch={false}><Icon name="home" />{MISSING_PLAIN.home}</Link>
        <Link href="/search" className="btn" prefetch={false}><Icon name="search" />{MISSING_PLAIN.search}</Link>
      </div>
    </div>
  );
}
