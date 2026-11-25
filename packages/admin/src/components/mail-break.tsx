import { Fragment, type ReactNode } from "react";

export function mailBreak(text: string): ReactNode {
  const parts = text.split("@");
  if (parts.length < 2) return text;
  return <>{parts.map((p, i) => i === 0 ? p : <Fragment key={i}><wbr />@{p}</Fragment>)}</>;
}

export function keepHyphenated(text: string): ReactNode {
  const parts = text.split(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/u);
  if (parts.length < 2) return text;
  return <>{parts.map((p, i) => i % 2 ? <span key={i} className="nobr">{p}</span> : p)}</>;
}
