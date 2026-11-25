import { REPORT_DESPITE_TEXT } from "../messages/components";
import { rich } from "../i18n/rich";
import { LocalTime } from "@/components/local-time";
import { Code, TableWrap } from "@/components/ui";
import { shortId } from "@/lib/format";
import { DESPITE_REFUSED_TITLES, DESPITE_SHOWN_TITLES } from "@/lib/show-anyway";
import type { DespiteReport } from "@/lib/types";

export function DespiteReportBlock({ d, hours }: { d: DespiteReport; hours: number }) {
  const refused = DESPITE_REFUSED_TITLES.filter(([k]) => d.refused[k] > 0);
  return (
    <div className="despite-report" id="despite-report">
      <p className="hint">{rich(REPORT_DESPITE_TEXT.summary, null, { value1: hours, value2: DESPITE_SHOWN_TITLES.map(([k, t], i) => <span key={k}>{i ? ", " : ""}{t} — <strong>{d[k]}</strong></span>), value3: <strong>{d.text_only}</strong>, value4: refused.length
          ? refused.map(([k, t], i) => <span key={k}>{i ? ", " : ""}{t} — <strong>{d.refused[k]}</strong></span>) : <strong>0</strong> })}</p>
      {d.recent.length ? (
        <TableWrap>
          <table className="board">
            <thead><tr><th>{REPORT_DESPITE_TEXT.record}</th><th>{REPORT_DESPITE_TEXT.space}</th><th>{REPORT_DESPITE_TEXT.author}</th><th>{REPORT_DESPITE_TEXT.when}</th><th>{REPORT_DESPITE_TEXT.accepted}</th></tr></thead>
            <tbody>
              {d.recent.map((r) => (
                <tr key={`${r.record_id}-${r.at ?? ""}`}>
                  <td><Code title={r.record_id}>{shortId(r.record_id)}</Code></td>
                  <td>{r.space_slug ? <Code>{r.space_slug}</Code> : "—"}{r.scope === "solo" ? <div className="cell-sub">{REPORT_DESPITE_TEXT.authorOnly}</div> : r.scope === "shared" ? <div className="cell-sub">{REPORT_DESPITE_TEXT.shared}</div> : null}</td>
                  <td>{r.author_login ?? "—"}</td>
                  <td>{r.at ? <LocalTime iso={r.at} /> : "—"}</td>
                  <td>{r.rules.join(", ") || "—"}{r.text_only ? <div className="cell-sub">{REPORT_DESPITE_TEXT.textOnly}</div> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableWrap>
      ) : null}
    </div>
  );
}
