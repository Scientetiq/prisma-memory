import { execFile, fork, type ChildProcess } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { chmod, mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { deserialize } from "node:v8";
import { isFailureCode, isPacket, type ParserFailureCode, type ParserInput, type ParserJob, type ParseRequest } from "./protocol.ts";

export interface ParserPoolOptions {
  size: number;
  parser: keyof typeof PARSER_MODULES;
  deadlineMs: number;
  heapMb: number;
  semiSpaceMb: number;
  startTimeoutMs: number;
  maxResultBytes: number;
  parentExecArgv?: readonly string[];
  maxRssMb?: number;
  rssPollMs?: number;
  cpuSeconds?: number;
  findPrlimit?: () => string | undefined;
}

export interface ParserPoolTestOptions extends Omit<ParserPoolOptions, "parser"> {
  parser: string;
  testEnv?: Record<string, string>;
}

class ParserPoolError extends Error {
  constructor(readonly code: ParserFailureCode) {
    super();
  }
}

type Outcome = { code: "ok"; result: unknown } | { code: ParserFailureCode };

interface QueuedJob {
  id: number;
  job: ParserJob;
  resolve: (result: unknown) => void;
  reject: (error: ParserPoolError) => void;
}

interface Reply {
  receive: (packet: unknown) => void;
  fail: (code: ParserFailureCode) => void;
}

interface Child {
  process: ChildProcess;
  exited: Promise<void>;
  failure?: ParserFailureCode;
  reply?: Reply;
}

interface Slot {
  used: boolean;
  child?: Child;
  active?: Promise<void>;
}

const childEntry = new URL("./child.ts", import.meta.url);
const PARSER_MODULES = Object.freeze({} satisfies Record<string, URL>);
const systemPath = "/usr/bin:/bin";
const maxTimerMs = 2 ** 31 - 1;
const liveChildren = new Set<ChildProcess>();
const execFileAsync = promisify(execFile);

export function parseRssMb(text: string, source: "proc" | "ps"): number | undefined {
  const match = source === "proc"
    ? /^VmRSS:[ \t]+(\d+)[ \t]+kB[ \t]*\r?$/m.exec(text)
    : /^(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const rssKb = Number(match[1]);
  return Number.isSafeInteger(rssKb) ? rssKb / 1024 : undefined;
}

async function readRssMb(pid: number, signal: AbortSignal): Promise<number | undefined> {
  try {
    if (process.platform === "linux") {
      return parseRssMb(await readFile(`/proc/${pid}/status`, { encoding: "utf8", signal }), "proc");
    }
    const { stdout } = await execFileAsync("/bin/ps", ["-o", "rss=", "-p", String(pid)], { signal, maxBuffer: 1024, env: {} });
    return parseRssMb(stdout, "ps");
  } catch {
    return undefined;
  }
}

function watchRss(pid: number, maxRssMb: number, rssPollMs: number, onLimit: () => void): () => void {
  const controller = new AbortController();
  let timer = setTimeout(poll, rssPollMs).unref();

  async function poll(): Promise<void> {
    const rssMb = await readRssMb(pid, controller.signal);
    if (controller.signal.aborted) return;
    if (rssMb !== undefined && rssMb > maxRssMb) {
      onLimit();
      return;
    }
    timer = setTimeout(poll, rssPollMs).unref();
  }

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}

function findPrlimit(): string | undefined {
  for (const directory of systemPath.split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const path = join(directory, "prlimit");
    try {
      accessSync(path, constants.X_OK);
      if (statSync(path).isFile()) return path;
    } catch {
      // Try the next PATH entry.
    }
  }
}

function killGroup(subprocess: ChildProcess): void {
  const pid = subprocess.pid;
  if (pid !== undefined && process.platform !== "win32") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
    }
  }
  subprocess.kill("SIGKILL");
}

function killChildrenOnExit(): void {
  for (const child of liveChildren) killGroup(child);
}

function stop(child: Child, code: ParserFailureCode): void {
  if (child.failure) return;
  child.failure = code;
  killGroup(child.process);
  child.reply?.fail(code);
}

function waitForPacket(child: Child, expiresAt: number, timeoutCode: ParserFailureCode, request?: ParseRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (child.failure) {
      reject(new ParserPoolError(child.failure));
      return;
    }

    let sendFailed = false;
    const expire = () => stop(child, sendFailed ? "parser_failed" : timeoutCode);
    const timer = setTimeout(expire, Math.ceil(expiresAt - performance.now())).unref();
    const clear = () => {
      clearTimeout(timer);
      child.reply = undefined;
    };

    child.reply = {
      receive(packet) {
        if (performance.now() >= expiresAt) {
          expire();
          return;
        }
        clear();
        resolve(packet);
      },
      fail(code) {
        clear();
        reject(new ParserPoolError(code));
      },
    };

    if (request) {
      try {
        child.process.send(request, (error) => {
          // A closing IPC channel can fail before Node reports the child's exit signal.
          if (error) sendFailed = true;
        });
      } catch {
        stop(child, "parser_failed");
      }
    }
  });
}

export function createParserPool(options: ParserPoolOptions) {
  const { parser } = options;
  if (typeof parser !== "string" || !Object.hasOwn(PARSER_MODULES, parser)) {
    throw new ParserPoolError("parser_failed");
  }
  return startParserPool(fileURLToPath(PARSER_MODULES[parser]), options);
}

/**
 * Tests only: no file under packages/<package>/src imports this entry
 * (pinned by a unit test).
 */
export function createParserPoolForTests(options: ParserPoolTestOptions) {
  const { parser } = options;
  if (!isAbsolute(parser)) throw new ParserPoolError("parser_failed");
  return startParserPool(parser, options, options.testEnv);
}

function startParserPool(parser: string, options: Omit<ParserPoolOptions, "parser">, testEnv: Record<string, string> = {}) {
  const { size, deadlineMs, heapMb, semiSpaceMb, startTimeoutMs, maxResultBytes } = options;
  const { maxRssMb, rssPollMs = 100, cpuSeconds } = options;
  const positiveIntegers = [size, deadlineMs, heapMb, semiSpaceMb, startTimeoutMs, rssPollMs];
  if (cpuSeconds !== undefined) positiveIntegers.push(cpuSeconds);
  if (!positiveIntegers.every((value) => Number.isSafeInteger(value) && value > 0)
      || deadlineMs > maxTimerMs || startTimeoutMs > maxTimerMs || rssPollMs > maxTimerMs
      || (maxRssMb !== undefined && (!Number.isFinite(maxRssMb) || maxRssMb <= 0))
      || !Number.isSafeInteger(maxResultBytes) || maxResultBytes < 0) {
    throw new ParserPoolError("parser_failed");
  }

  const env: NodeJS.ProcessEnv = { ...testEnv, PATH: systemPath, NODE_ENV: "production" };
  delete env.NODE_OPTIONS;
  const execArgv = ["--import", "tsx", `--max-old-space-size=${heapMb}`, `--max-semi-space-size=${semiSpaceMb}`];
  // Allow source maps without inheriting options that open an inspector, load code or override the limits.
  if ((options.parentExecArgv ?? process.execArgv).includes("--enable-source-maps")) execArgv.push("--enable-source-maps");
  const prlimit = cpuSeconds !== undefined && process.platform === "linux"
    ? (options.findPrlimit ?? findPrlimit)()
    : undefined;
  // prlimit sets both CPU limits and execs Node in the same process, preserving its IPC file descriptor.
  const childExecArgv = prlimit ? [`--cpu=${cpuSeconds}`, "--", process.execPath, ...execArgv] : execArgv;

  const slots: Slot[] = Array.from({ length: size }, () => ({ used: false }));
  const queue: QueuedJob[] = [];
  const outcomes = { ok: 0, resource_limit: 0, malformed_document: 0, parser_failed: 0 };
  let started = 0;
  let replaced = 0;
  let rssKills = 0;
  let oomScoreAdjustFailures = 0;
  let cpuLimitSkipped = 0;
  let nextId = 0;
  let tempPath: string | undefined;
  let directory: Promise<string> | undefined;
  let closed = false;
  let closing: Promise<void> | undefined;

  function launch(slot: Slot): Child {
    const subprocess = fork(childEntry, [parser, String(maxResultBytes)], {
      env,
      detached: process.platform !== "win32",
      execPath: prlimit ?? process.execPath,
      execArgv: childExecArgv,
      serialization: "advanced",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });

    let finishExit!: () => void;
    const exited = new Promise<void>((resolve) => { finishExit = resolve; });
    const child: Child = { process: subprocess, exited };
    slot.child = child;
    if (subprocess.pid !== undefined) {
      started++;
      if (cpuSeconds !== undefined && !prlimit) cpuLimitSkipped++;
      if (slot.used) replaced++;
      slot.used = true;
    }

    if (liveChildren.size === 0) process.once("exit", killChildrenOnExit);
    liveChildren.add(subprocess);
    subprocess.on("message", (packet: unknown) => {
      if (child.reply) child.reply.receive(packet);
      else stop(child, "parser_failed");
    });
    subprocess.on("error", () => stop(child, "parser_failed"));
    subprocess.once("close", (_code, signal) => {
      child.failure ??= signal ? "resource_limit" : "parser_failed";
      child.reply?.fail(child.failure);
      slot.child = undefined;
      liveChildren.delete(subprocess);
      if (liveChildren.size === 0) process.removeListener("exit", killChildrenOnExit);
      killGroup(subprocess);
      finishExit();
    });
    subprocess.unref();
    subprocess.channel?.unref();
    return child;
  }

  function tempDirectory(): Promise<string> {
    directory ??= mkdtemp(join(tmpdir(), "prisma-parser-")).then(async (path) => {
      tempPath = path;
      await chmod(path, 0o700);
      return path;
    });
    return directory;
  }

  async function retire(slot: Slot, code: ParserFailureCode): Promise<void> {
    const child = slot.child;
    if (child) {
      stop(child, code);
      await child.exited;
    }
  }

  async function serve(slot: Slot, entry: QueuedJob): Promise<Outcome> {
    let temporaryFile: string | undefined;
    let outcome: Outcome;
    try {
      if (prlimit && slot.child) await retire(slot, "parser_failed");
      else if (slot.child?.failure) await slot.child.exited;
      if (closed) throw new ParserPoolError("parser_failed");
      let child = slot.child;
      if (!child) {
        const expiresAt = performance.now() + startTimeoutMs;
        child = launch(slot);
        const ready = await waitForPacket(child, expiresAt, "parser_failed");
        if (!isPacket(ready) || ready.type !== "ready") throw new ParserPoolError("parser_failed");
        if (ready.oomScoreAdjusted === false) oomScoreAdjustFailures++;
      }

      const { kind, file, limits, bytes } = entry.job;
      const input: ParserInput = { kind };
      if (limits !== undefined) input.limits = limits;
      if (file !== undefined) input.file = file;
      if (bytes !== undefined) {
        if (file !== undefined) throw new ParserPoolError("parser_failed");
        temporaryFile = join(await tempDirectory(), String(entry.id));
        const handle = await open(temporaryFile, "wx", 0o600);
        try {
          await handle.chmod(0o600);
          await handle.writeFile(bytes);
        } finally {
          await handle.close();
        }
        input.file = temporaryFile;
      }

      if (closed) throw new ParserPoolError("parser_failed");
      const pid = child.process.pid;
      const stopWatching = pid !== undefined && maxRssMb !== undefined
        ? watchRss(pid, maxRssMb, rssPollMs, () => {
          if (child.failure) return;
          rssKills++;
          stop(child, "resource_limit");
        })
        : undefined;
      let packet: unknown;
      try {
        packet = await waitForPacket(child, performance.now() + deadlineMs, "resource_limit", {
          type: "parse", id: entry.id, job: input,
        });
      } finally {
        stopWatching?.();
      }

      if (!isPacket(packet) || packet.id !== entry.id) throw new ParserPoolError("parser_failed");
      if (packet.type === "failure" && isFailureCode(packet.code)) {
        outcome = { code: packet.code };
      } else if (packet.type === "result" && Buffer.isBuffer(packet.data)) {
        outcome = packet.data.byteLength <= maxResultBytes
          ? { code: "ok", result: deserialize(packet.data) }
          : { code: "resource_limit" };
      } else {
        outcome = { code: "parser_failed" };
      }
    } catch (error) {
      outcome = { code: error instanceof ParserPoolError ? error.code : "parser_failed" };
    }

    if (outcome.code !== "ok" && outcome.code !== "malformed_document") await retire(slot, outcome.code);
    if (temporaryFile) {
      try {
        await rm(temporaryFile, { force: true });
      } catch {
        await retire(slot, "parser_failed");
        return { code: "parser_failed" };
      }
    }
    return outcome;
  }

  function settle(entry: QueuedJob, outcome: Outcome): void {
    outcomes[outcome.code]++;
    if (outcome.code === "ok") entry.resolve(outcome.result);
    else entry.reject(new ParserPoolError(outcome.code));
  }

  function pump(): void {
    if (closed) return;
    for (const slot of slots) {
      if (slot.active) continue;
      const entry = queue.shift();
      if (!entry) break;
      slot.active = serve(slot, entry).then((outcome) => {
        slot.active = undefined;
        settle(entry, outcome);
        pump();
      });
    }
  }

  function run(job: ParserJob): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry = { id: ++nextId, job, resolve, reject };
      if (closed) {
        settle(entry, { code: "parser_failed" });
        return;
      }
      queue.push(entry);
      pump();
    });
  }

  function stats() {
    const reportOomFailures = maxRssMb !== undefined || cpuSeconds !== undefined || oomScoreAdjustFailures !== 0;
    return {
      started,
      replaced,
      outcomes: { ...outcomes },
      busy: slots.filter((slot) => slot.active).length,
      waiting: queue.length,
      ...(maxRssMb !== undefined ? { rssKills } : {}),
      ...(reportOomFailures ? { oomScoreAdjustFailures } : {}),
      ...(cpuSeconds !== undefined ? { cpuLimitSkipped } : {}),
    };
  }

  async function shutdown(): Promise<void> {
    closed = true;
    for (const entry of queue.splice(0)) settle(entry, { code: "parser_failed" });
    await Promise.all(slots.flatMap((slot) => [retire(slot, "parser_failed"), slot.active]));
    if (tempPath) {
      try {
        await rm(tempPath, { recursive: true, force: true });
      } catch {
        throw new ParserPoolError("parser_failed");
      }
    }
  }

  function close(): Promise<void> {
    return closing ??= shutdown();
  }

  return { run, stats, close };
}
