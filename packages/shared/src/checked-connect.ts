import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { hostLocality, type HostLocality, type ModelLookup } from "./models/address.ts";

export type AnswerJudge = (answer: HostLocality) => { ok: true } | { ok: false; code: string };

export const allowReachable: AnswerJudge = (answer) => {
  if (answer.status === "unresolved") return { ok: false, code: "address_unresolved" };
  if (answer.addresses.some(({ address }) => !isIP(address))) return { ok: false, code: "address_invalid" };
  return { ok: true };
};

interface CheckedHost {
  host: string;
  lookup?: ModelLookup;
  judge?: AnswerJudge;
}

const bareHost = (host: string): string => host.replace(/\.$/, "").replace(/^\[(.*)\]$/, "$1").toLowerCase();
const codedError = (code: string): NodeJS.ErrnoException => Object.assign(new Error(), { code });

export function checkedLookup({ host, lookup, judge = allowReachable }: CheckedHost): LookupFunction {
  const expectedHost = bareHost(host);
  return (hostname, options, callback) => {
    const fail = (error: NodeJS.ErrnoException) => callback(error, options.all ? [] : "", 0);
    if (bareHost(hostname) !== expectedHost) return fail(codedError("ADDRESS_UNCHECKED_HOST"));

    void hostLocality(host, { lookup }).then((answer) => {
      const addresses = answer.status === "unresolved"
        ? []
        : answer.addresses.map(({ address }) => ({ address, family: isIP(address) }));
      const verdict = judge(answer);
      if (answer.status === "unresolved") throw codedError(answer.code);
      if (!verdict.ok) throw codedError(verdict.code);
      if (!addresses.length) throw codedError("address_unresolved");
      if (addresses.some(({ family }) => !family)) throw codedError("address_invalid");
      return addresses;
    }).then((addresses) => process.nextTick(() => {
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    }), (error: NodeJS.ErrnoException) => process.nextTick(fail, error));
  };
}

export function checkedAgent(o: CheckedHost & { tls: boolean; keepAlive?: boolean }): HttpAgent | HttpsAgent {
  const host = bareHost(o.host);
  const literal = isIP(host) !== 0;
  const lookup = checkedLookup(o);
  const options = { keepAlive: o.keepAlive };
  const agent = o.tls ? new HttpsAgent({ ...options, servername: literal ? "" : host, rejectUnauthorized: true }) : new HttpAgent(options);
  const connect = agent.createConnection.bind(agent);

  agent.createConnection = (request, oncreate) => {
    if (bareHost(request.host ?? "") !== host || request.socketPath) throw codedError("ADDRESS_UNCHECKED_HOST");
    const connection = {
      ...request, host, path: undefined, socket: undefined, family: 0, lookup, autoSelectFamily: true,
      ...(agent instanceof HttpsAgent ? { rejectUnauthorized: true } : {}),
    };
    if (!literal) return connect(connection);

    // Node skips lookup for literals, so check the address before creating the socket.
    if (oncreate) {
      lookup(host, { all: false }, (error, address) => {
        if (error) return (oncreate as (error: Error) => void)(error);
        let socket;
        try {
          socket = connect({ ...connection, host: address as string })!;
        } catch (failure) {
          return (oncreate as (error: Error) => void)(failure as Error);
        }
        oncreate(null, socket);
      });
    }
    return undefined;
  };
  return agent;
}
