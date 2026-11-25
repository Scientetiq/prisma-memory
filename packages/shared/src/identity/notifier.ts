import { enqueueMail, sendMail, smtpConfig, type MailMessage, type SmtpConfig } from "../smtp.ts";
import type { IdentitySettings, Notifier } from "./ports.ts";

interface QueuedTest {
  via: "queue";
  queue: Parameters<typeof enqueueMail>[0];
  instanceId: string;
  mail: MailMessage;
  createdBy: string;
}

interface DirectTest {
  via: "direct";
  config: SmtpConfig;
  mail: MailMessage;
}

interface SendTest {
  (request: QueuedTest): ReturnType<typeof enqueueMail>;
  (request: DirectTest): ReturnType<typeof sendMail>;
}

type Send = (...args: Parameters<typeof enqueueMail>) => Promise<{ id: string | null; created: boolean }>;

export type MailNotifier = Notifier<Send, SendTest>;

function createNotifier(id: "smtp" | "none", enqueue: typeof enqueueMail, deliver: typeof sendMail): MailNotifier {
  function sendTest(request: QueuedTest): ReturnType<typeof enqueueMail>;
  function sendTest(request: DirectTest): ReturnType<typeof sendMail>;
  function sendTest(request: QueuedTest | DirectTest) {
    if (request.via === "direct") return deliver(request.config, request.mail);
    return enqueue(request.queue, request.instanceId, { ...request.mail, kind: "test", createdBy: request.createdBy });
  }

  const canDeliver = id === "smtp";
  return { id, send: canDeliver ? enqueue : async () => ({ id: null, created: false }), canDeliver, sendTest };
}

export function createSmtpNotifier(send = enqueueMail, deliver = sendMail): MailNotifier {
  return createNotifier("smtp", send, deliver);
}

export function createNoneNotifier(send = enqueueMail, deliver = sendMail): MailNotifier {
  return createNotifier("none", send, deliver);
}

export const smtpNotifier = createSmtpNotifier();
export const noneNotifier = createNoneNotifier();
const defaultAdapters = { smtp: smtpNotifier, none: noneNotifier };

export function notifierFor(settings: IdentitySettings, adapters = defaultAdapters): MailNotifier {
  return smtpConfig(settings).enabled ? adapters.smtp : adapters.none;
}
