// The syslog-over-TLS sink: RFC 5425 framing (length in octets, a space, the message), the message is RFC 5424,
// MSG is the journal line (JSON, UTF-8 with BOM, as RFC 5424 asks for UTF-8 MSG). One connection per process, TLS at
// least 1.2; the certificate is checked: the CA is only observability.audit_ship_target.ca_cert (none — no connection:
// a common CA list would accept any public certificate for a spoofed name), name: tls_server_name (else host). A batch is one write; accepted once it reached the socket (write callback
// with no error). A break or error closes the connection; the next try opens a new one (backoff is the job's).
import { hostname } from "node:os";
import { isIP, type TcpNetConnectOpts } from "node:net";
import tls from "node:tls";
import { allowReachable, checkedLookup, type AnswerJudge, type ModelLookup } from "@memory/shared";
import { lineText, type ShipLine } from "./line.ts";
import { ShipSinkError, type ShipSink } from "./sink.ts";

export interface SyslogTarget { host: string; port: number; ca_cert?: string; tls_server_name?: string }

/** facility 13 (log audit), severity 6 (info): PRI = 13·8 + 6. */
export const SYSLOG_PRI = 110;
export const SYSLOG_APP = "memory";
export const SYSLOG_MSGID = "audit";
const BOM = "﻿";
const CONNECT_TIMEOUT_MS = 10_000;
const WRITE_TIMEOUT_MS = 30_000;

/** RFC 5424 HOSTNAME: printable ASCII, no space, up to 255; else `-`. */
export function syslogHost(h = hostname()): string {
  const t = h.replace(/[^\x21-\x7e]/g, "").slice(0, 255);
  return t || "-";
}

/** RFC 5424 message of one journal line. */
export function syslogMessage(l: ShipLine, host = syslogHost()): string {
  return `<${SYSLOG_PRI}>1 ${l.at} ${host} ${SYSLOG_APP} - ${SYSLOG_MSGID} - ${BOM}${lineText(l)}`;
}

/** RFC 5425 frame (octet-counting): message length in UTF-8 octets, space, message. */
export function syslogFrame(l: ShipLine, host = syslogHost()): Buffer {
  const msg = Buffer.from(syslogMessage(l, host), "utf8");
  return Buffer.concat([Buffer.from(`${msg.length} `, "ascii"), msg]);
}

export function syslogTlsSink(t: SyslogTarget, o: { host?: string; lookup?: ModelLookup; judge?: AnswerJudge } = {}): ShipSink {
  let sock: tls.TLSSocket | null = null;
  const host = o.host ?? syslogHost();

  const drop = () => { sock?.destroy(); sock = null; };

  const connect = (): Promise<tls.TLSSocket> => new Promise((resolve, reject) => {
    if (!t.ca_cert) { reject(new ShipSinkError("target_invalid", "receiver ca_cert is missing")); return; }
    const name = t.tls_server_name ?? (isIP(t.host) ? undefined : t.host);
    const options: tls.ConnectionOptions & Pick<TcpNetConnectOpts, "autoSelectFamily"> = {
      host: t.host, port: t.port, ca: t.ca_cert, ...(name ? { servername: name } : {}),
      lookup: checkedLookup({ host: t.host, lookup: o.lookup, judge: o.judge ?? allowReachable }),
      autoSelectFamily: true,
      rejectUnauthorized: true, minVersion: "TLSv1.2",
      // name for the certificate check: tls_server_name if set (the receiver address may be an IP)
      checkServerIdentity: (_h, cert) => tls.checkServerIdentity(t.tls_server_name ?? t.host, cert),
    };
    const s = tls.connect(options);
    const timer = setTimeout(() => { s.destroy(); reject(new ShipSinkError("syslog_timeout", "connection was not established in time")); }, CONNECT_TIMEOUT_MS);
    s.once("secureConnect", () => {
      clearTimeout(timer);
      s.removeAllListeners("error");
      s.on("error", () => { if (sock === s) sock = null; s.destroy(); });
      s.on("close", () => { if (sock === s) sock = null; });
      // by RFC 5425 the receiver sends nothing back: input is read and dropped so the buffer does not grow
      s.on("data", () => undefined);
      resolve(s);
    });
    s.once("error", (e: Error & { code?: string }) => {
      clearTimeout(timer);
      s.destroy();
      const tlsErr = /CERT|SSL|TLS|self.signed|unable to verify|altname/i.test(`${e.code ?? ""} ${e.message}`);
      reject(new ShipSinkError(tlsErr ? "syslog_tls_failed" : "syslog_connect_failed", `${e.code ?? ""} ${e.message}`));
    });
  });

  return {
    kind: "syslog_tls",
    async write(lines: readonly ShipLine[]): Promise<void> {
      if (!lines.length) return;
      if (!sock || sock.destroyed || !sock.writable) sock = await connect();
      const s = sock;
      const buf = Buffer.concat(lines.map((l) => syslogFrame(l, host)));
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (e?: ShipSinkError) => {
          if (done) return;
          done = true;
          clearTimeout(timer); s.off("close", onClose); s.off("error", onError);
          if (e) { drop(); reject(e); } else resolve();
        };
        const onClose = () => finish(new ShipSinkError("syslog_closed", "receiver closed the connection"));
        const onError = (e: Error) => finish(new ShipSinkError("syslog_write_failed", e.message));
        const timer = setTimeout(() => finish(new ShipSinkError("syslog_timeout", "write did not complete in time")), WRITE_TIMEOUT_MS);
        s.once("close", onClose);
        s.once("error", onError);
        s.write(buf, (e) => (e ? finish(new ShipSinkError("syslog_write_failed", e.message)) : finish()));
      });
    },
    async close(): Promise<void> {
      const s = sock;
      sock = null;
      if (!s) return;
      await new Promise<void>((resolve) => { s.end(() => resolve()); setTimeout(() => { s.destroy(); resolve(); }, 2_000).unref(); });
    },
  };
}
