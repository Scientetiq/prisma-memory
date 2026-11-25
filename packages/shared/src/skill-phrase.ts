import { SKILL_BUNDLE } from "./skill-bundle.ts";

/** Skill routes without a key (gateway and edge) for a skill name: core, archive, manifest and its signature. */
export function skillRoutePaths(name: string): { md: string; zip: string; manifest: string; sig: string } {
  return { md: `/api/v1/skill/${name}/SKILL.md`, zip: `/api/v1/skill/${name}.zip`, manifest: `/api/v1/skill/${name}/manifest.json`, sig: `/api/v1/skill/${name}/manifest.json.sig` };
}
export const SKILL_ARCHIVE_PATH = skillRoutePaths(SKILL_BUNDLE.name).zip;
export const SKILL_MANIFEST_PATH = skillRoutePaths(SKILL_BUNDLE.name).manifest;

export type SkillProgram = "claude_code" | "codex" | "cursor";
export type SkillShell = "posix" | "powershell";

export const SKILL_FOLDERS: Record<SkillProgram, { title: string; posix: string; powershell: string }> = {
  claude_code: { title: "Claude Code", posix: "~/.claude/skills", powershell: "%USERPROFILE%\\.claude\\skills" },
  codex: { title: "Codex", posix: "~/.agents/skills", powershell: "%USERPROFILE%\\.agents\\skills" },
  cursor: { title: "Cursor", posix: "~/.cursor/skills", powershell: "%USERPROFILE%\\.cursor\\skills" },
};

export function skillProgramOf(kind: string | null | undefined): SkillProgram | null {
  return kind === "claude_code" || kind === "codex" || kind === "cursor" ? kind : null;
}

const SAFE_URL_RE = /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
export function validSkillBase(url: string): boolean {
  return SAFE_URL_RE.test(url);
}

export function skillUrlInsecure(url: string): boolean {
  const m = /^(https?):\/\/([^/:]+)/.exec(url);
  if (!m) return true;
  return m[1] !== "https" && m[2] !== "localhost" && !/^127\./.test(m[2]!);
}

export function skillArchiveUrlFromBase(base: string | null | undefined, name: string = SKILL_BUNDLE.name): string | null {
  const b = String(base ?? "").trim().replace(/\/+$/, "");
  if (!b) return null;
  const url = `${b}${skillRoutePaths(name).zip}`;
  return validSkillBase(url) ? url : null;
}

const SHA_RE = /^[0-9a-f]{64}$/;

export function parseSkillManifest(data: unknown): { version: string; sha: string } | null {
  if (!data || typeof data !== "object") return null;
  const d = data as { version?: unknown; archive?: { digest?: unknown } | null };
  if (typeof d.version !== "string" || !/^\d+\.\d+\.\d+$/.test(d.version)) return null;
  const digest = d.archive && typeof d.archive === "object" ? d.archive.digest : undefined;
  const m = typeof digest === "string" ? /^sha256:([0-9a-f]{64})$/.exec(digest) : null;
  return m ? { version: d.version, sha: m[1]! } : null;
}

/** Skill name as the description allows it: it goes into shell commands and folder names. */
const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

function checked(url: string, sha: string | undefined, name: string): void {
  if (!NAME_RE.test(name)) throw new Error("skill-install: skill name is not of the form a-z0-9-");
  if (!validSkillBase(url)) throw new Error("skill-install: invalid archive address format");
  if (sha !== undefined && !SHA_RE.test(sha)) throw new Error("skill-install: archive checksum is not SHA-256");
}

function quote(value: string, shell: SkillShell): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid line break in connection parameters");
  return shell === "powershell" ? "'" + value.replaceAll("'", "''") + "'" : "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

export function skillPhrase(url: string, sha?: string, program?: SkillProgram | null, name: string = SKILL_BUNDLE.name): string {
  checked(url, sha, name);
  const f = SKILL_FOLDERS;
  const where = program
    ? `Move it to the personal skills folder for ${f[program].title}: ${f[program].posix} (on Windows — ${f[program].powershell}); `
    : "Move it to the personal skills folder for your program — "
      + `${f.claude_code.title}: ${f.claude_code.posix}, ${f.codex.title}: ${f.codex.posix}, ${f.cursor.title}: ${f.cursor.posix} (on Windows — the same folders in %USERPROFILE%); `;
  const plain = skillUrlInsecure(url) ? "Unencrypted address (http): tell me before downloading and wait for a separate “yes”. " : "";
  return `Install the memory skill from ${url}. ${plain}Download the archive as a file — curl -fsSL or Invoke-WebRequest -OutFile; do not open the link as a page `
    + "and do not disable certificate verification (-k, --insecure, -SkipCertificateCheck)"
    + (sha ? `. Verify SHA-256 for the archive: ${sha}. If the checksum does not match or there is a certificate error, stop and tell me. ` : "; if there is a certificate error, stop and tell me. ")
    + `Extract it to a temporary folder. It should contain a folder named ${name} with a SKILL.md file. ` + where
    + `remove the old ${name} only after this check. If ${name} is in another personal skills folder, update that copy too; `
    + "leave copies in project skills folders (.claude/skills, .agents/skills, .cursor/skills in the repository) unchanged. Tell me where they are and update them only after a separate “yes”. "
    + "Tell me the metadata.version from the new SKILL.md. If your program does not support skills, tell me. You still receive the rules from the memory server.";
}

const homeDir = (program: SkillProgram) => SKILL_FOLDERS[program].posix.replace(/^~\//, "");

export function skillCommand(program: SkillProgram, shell: SkillShell, url: string, sha?: string, name: string = SKILL_BUNDLE.name): string {
  checked(url, sha, name);
  const q = (v: string) => quote(v, shell);
  const rel = homeDir(program);
  if (shell === "posix") {
    return [
      "( set -e",
      `  d="$HOME/${rel}"; mkdir -p "$d"`,
      `  t="$(mktemp -d "$d/.${name}.XXXXXX")"; trap 'rm -rf "$t"' EXIT`,
      `  curl -fsSL ${q(url)} -o "$t/s.zip"`,
      ...(sha ? [
        `  if [ -n "$(command -v sha256sum)" ]; then h="$(sha256sum "$t/s.zip")"; else h="$(shasum -a 256 "$t/s.zip")"; fi`,
        `  test "\${h%% *}" = ${q(sha)} || { echo 'Checksum mismatch — installation stopped'; exit 1; }`,
      ] : []),
      `  unzip -q "$t/s.zip" -d "$t/x"`,
      `  test -f "$t/x/${name}/SKILL.md" || { echo 'Archive missing ${name}/SKILL.md — installation stopped'; exit 1; }`,
      `  rm -rf "$d/${name}"; mv "$t/x/${name}" "$d/"`,
      `  echo "Memory skill installed: $d/${name}"`,
      ")",
    ].join("\n");
  }
  const winRel = rel.replace(/\//g, "\\");
  return [
    "& { $ErrorActionPreference = 'Stop'",
    `  $d = Join-Path $env:USERPROFILE ${q(winRel)}; New-Item -ItemType Directory -Force -Path $d | Out-Null`,
    `  $t = Join-Path $d ('.${name}-' + [guid]::NewGuid()); New-Item -ItemType Directory -Path $t | Out-Null`,
    "  try {",
    `    Invoke-WebRequest -UseBasicParsing -Uri ${q(url)} -OutFile "$t\\s.zip"`,
    ...(sha ? [`    if ((Get-FileHash -Algorithm SHA256 "$t\\s.zip").Hash -ne ${q(sha)}) { throw 'Checksum mismatch — installation stopped' }`] : []),
    `    Expand-Archive -LiteralPath "$t\\s.zip" -DestinationPath "$t\\x"`,
    `    if (-not (Test-Path "$t\\x\\${name}\\SKILL.md")) { throw 'Archive missing ${name}\\SKILL.md — installation stopped' }`,
    `    $old = Join-Path $d '${name}'; if (Test-Path $old) { Remove-Item -Recurse -Force $old }`,
    `    Move-Item "$t\\x\\${name}" $d; "Memory skill installed: $old"`,
    "  } finally { Remove-Item -Recurse -Force $t -ErrorAction SilentlyContinue }",
    "}",
  ].join("\n");
}
