// Next's internal hop: a Server Action that ends in redirect() renders the target with fetch() to this
// same server (next/dist/server/app-render/action-handler.js, createRedirectRenderResult: origin of initURL, i.e.
// http://localhost:<port>) and forwards the original request headers, x-memory-peer included. Overwriting it with that
// loopback socket made the panel send X-Memory-Client-Peer: 127.0.0.1, and the gateway revoked the fresh admin session as
// ip_changed (admin-plane/session.ts). So every request also gets x-memory-peer-proof: an HMAC over the stamp time and
// the stamped peer, under a random key that never leaves this process. A request from a loopback socket keeps the
// forwarded peer only if its proof verifies and is fresh; anything else (a peer or proof sent by the client, a proof on a
// non-loopback socket, an altered or stale proof) is replaced by the socket address, as before. The loopback address
// alone proves nothing: a reverse proxy on the same host connects from 127.0.0.1 too.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import { runWithRequestLocale } from "./request-locale.mjs";

export const PEER_HEADER = "x-memory-peer";
export const PEER_PROOF_HEADER = "x-memory-peer-proof";
/** How long the internal hop may take after the original request was stamped (it runs inside one Server Action). */
export const PEER_PROOF_TTL_MS = 120_000;

const G = globalThis;
// One key per process, even if the module is evaluated twice (NODE_OPTIONS --import and server.mjs by another URL).
const key = () => (G.__memoryClientPeerKey ??= randomBytes(32));
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|::1|::ffff:127(?:\.\d{1,3}){3})$/i;

const proofOf = (peer, at) => `${at}.${createHmac("sha256", key()).update(`${at}\n${peer}`).digest("base64url")}`;

/** The forwarded peer, if its proof was made by this process for exactly this peer and is still fresh; otherwise null. */
function provenPeer(headers, now) {
  const peer = headers[PEER_HEADER], proof = headers[PEER_PROOF_HEADER];
  if (typeof peer !== "string" || typeof proof !== "string" || peer.length > 64 || proof.length > 80) return null;
  const at = Number(proof.slice(0, Math.max(0, proof.indexOf("."))));
  if (!Number.isSafeInteger(at) || at <= 0 || at > now + 5_000 || now - at > PEER_PROOF_TTL_MS) return null;
  const want = Buffer.from(proofOf(peer, at)), got = Buffer.from(proof);
  return want.length === got.length && timingSafeEqual(want, got) ? peer : null;
}

/**
 * Stamp the browser's socket address on a request: x-memory-peer and its proof. On Next's internal hop (loopback socket,
 * valid proof of this process) the forwarded peer and proof are kept as they are; everything else gets the socket address.
 */
export function stampPeer(req, now = Date.now()) {
  if (!req || !req.headers) return;
  const sock = req.socket?.remoteAddress ?? "";
  if (LOOPBACK.test(sock) && provenPeer(req.headers, now) !== null) return;
  req.headers[PEER_HEADER] = sock;
  req.headers[PEER_PROOF_HEADER] = proofOf(sock, now);
}

if (!G.__memoryClientPeerPatched) {
  G.__memoryClientPeerPatched = true;
  const emit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emitWithPeer(event, ...args) {
    if (event !== "request") return emit.call(this, event, ...args);
    stampPeer(args[0]);
    // the request runs inside its interface-language scope (request-locale.mjs): pages, actions and routes read it
    return runWithRequestLocale(args[0], () => emit.call(this, event, ...args));
  };
}
G.__memoryClientPeer = true;
