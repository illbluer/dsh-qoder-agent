// Credential layer for dsh-qoder-agent.
//
// Reads the Qoder CN desktop app's own sign-in (auth.v1.dat, encrypted with
// Chromium safeStorage / DPAPI) and the device fingerprint (umid-cache.json),
// then decrypts them in-process. This mirrors dsh-workbuddy-bridge's
// "read the app's own login state, read-only" approach.
import { createDecipheriv } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Candidate data directories. CN app is "com.qodercn.app.stable".
const APP_DATA_DIRS = [process.env.APPDATA, process.env.LOCALAPPDATA]
  .filter((p) => typeof p === "string" && p.length > 0)
  .map((p) => join(p, "com.qodercn.app.stable"));
// .qoder-cn home dir (device fingerprint).
const QODER_HOME = join(homedir(), ".qoder-cn");

function firstExisting(paths) {
  for (const p of paths) if (existsSync(p)) return p;
  return undefined;
}

// --- DPAPI safeStorage AES key --------------------------------------------
// The "Local State" file (Chromium profile) holds os_crypt.encrypted_key:
// base64 of "DPAPI" (5 bytes) + a DPAPI blob. Unprotecting that blob yields
// the 32-byte AES key used for safeStorage "v10" payloads. We shell out to
// PowerShell because DPAPI (System.Security.Cryptography.ProtectedData) has no
// Node built-in on Windows.
function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

async function dpapiUnprotectKey(localStatePath) {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$j = Get-Content -Raw -LiteralPath ${psQuote(localStatePath)} | ConvertFrom-Json
$blob = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
if ($blob.Length -le 5) { throw 'os_crypt.encrypted_key is too short' }
$dpapi = New-Object byte[] ($blob.Length - 5)
[Array]::Copy($blob, 5, $dpapi, 0, $dpapi.Length)
$key = [System.Security.Cryptography.ProtectedData]::Unprotect($dpapi, $null, 'CurrentUser')
[Console]::OutputEncoding = [Text.Encoding]::UTF8
[Console]::Out.Write([Convert]::ToBase64String($key))
`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", ps],
    { windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" },
  );
  const b64 = stdout.trim();
  if (!b64) throw new Error("dsh-qoder-agent: DPAPI unprotect returned no key");
  const key = Buffer.from(b64, "base64");
  if (key.length !== 32) throw new Error(`dsh-qoder-agent: DPAPI key has ${key.length} bytes, expected 32`);
  return key;
}

// --- AES-GCM decrypt of a v10 safeStorage payload --------------------------
// Layout: "v10" (3 bytes) + nonce (12) + ciphertext + tag (16), no AAD.
// createDecipheriv is synchronous; the GCM tag is verified on final(), so a
// wrong key surfaces here as a clear error instead of garbage JSON later.
function decryptV10(buf, key) {
  if (buf.length < 3 + 12 + 16) {
    throw new Error(`dsh-qoder-agent: credential file too short (${buf.length} bytes)`);
  }
  const prefix = buf.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") {
    // v11 / v20 payloads use app-bound encryption that DPAPI cannot unwrap.
    throw new Error(
      `dsh-qoder-agent: unsupported safeStorage prefix ${JSON.stringify(prefix)} — only v10 is supported`,
    );
  }
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// --- Public API -------------------------------------------------------------
// Both caches below are invalidation-aware on purpose: the desktop app rewrites
// its auth file whenever the token is refreshed or the user signs in again, and
// a permanently cached copy would keep this plugin on an expired token until the
// host process restarted.
let cachedKey; // { path, mtimeMs, key }
let cachedAuth; // { stamp, doc }

async function resolveKey(force = false) {
  const localState = firstExisting(APP_DATA_DIRS.map((d) => join(d, "Local State")));
  if (!localState) {
    throw new Error("dsh-qoder-agent: Qoder CN Local State not found — is the app installed?");
  }
  const { mtimeMs, size } = statSync(localState);
  const stamp = `${size}:${mtimeMs}`;
  if (!force && cachedKey?.path === localState && cachedKey?.stamp === stamp) return cachedKey.key;
  const key = await dpapiUnprotectKey(localState);
  cachedKey = { path: localState, stamp, key };
  return key;
}

/** Drop every cached secret so the next call re-reads and re-decrypts. */
export function invalidateCredentials() {
  cachedAuth = undefined;
  cachedKey = undefined;
}

function authPathOrThrow() {
  const authPath = firstExisting(APP_DATA_DIRS.map((d) => join(d, "auth.v1.dat")));
  if (!authPath) throw new Error("dsh-qoder-agent: auth.v1.dat not found — sign in to Qoder CN first");
  return authPath;
}

function decryptAuthFile(authPath, key) {
  const buf = readFileSync(authPath);
  const text = decryptV10(buf, key);
  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error("dsh-qoder-agent: auth.v1.dat did not decrypt to JSON (wrong DPAPI user or corrupted file)");
  }
  if (!doc || typeof doc.token !== "string" || doc.token.length === 0) {
    throw new Error("dsh-qoder-agent: auth.v1.dat has no token — sign in to Qoder CN again");
  }
  if (!doc.user || typeof doc.user.id !== "string" || doc.user.id.length === 0) {
    throw new Error("dsh-qoder-agent: auth.v1.dat has no user id — sign in to Qoder CN again");
  }
  return doc;
}

/**
 * Cheap identity of the current credential state: changes whenever the app
 * rewrites the auth file. Callers that cache anything derived from the token
 * (the wasm auth context) compare stamps instead of holding an expired token
 * until the host restarts.
 */
export function authStamp() {
  try {
    const authPath = authPathOrThrow();
    const { mtimeMs, size } = statSync(authPath);
    return `${authPath}:${size}:${mtimeMs}`;
  } catch {
    return undefined;
  }
}

/**
 * Decrypt and return the Qoder CN auth document (token, refreshToken, user).
 * Re-reads automatically whenever the app rewrites the file, and once more on
 * a decryption failure (the DPAPI key can rotate with a Windows profile change).
 */
export async function readAuth(options = {}) {
  const force = options.force === true;
  const authPath = authPathOrThrow();
  const { mtimeMs, size } = statSync(authPath);
  const stamp = `${authPath}:${size}:${mtimeMs}`;
  if (!force && cachedAuth?.stamp === stamp) return cachedAuth.doc;

  let doc;
  try {
    doc = decryptAuthFile(authPath, await resolveKey(force));
  } catch {
    // A stale key (or a half-written file) is worth exactly one retry: both
    // caches are dropped first so the retry cannot reuse the bad state. If the
    // retry fails too, surface *its* error — that one describes the state the
    // file is actually in now.
    invalidateCredentials();
    doc = decryptAuthFile(authPath, await resolveKey(true));
  }
  cachedAuth = { stamp, doc };
  return doc;
}

/** Read the device fingerprint (machineToken) from umid-cache.json. */export function readUmid() {
  const p = join(QODER_HOME, "umid-cache.json");
  if (!existsSync(p)) throw new Error("dsh-qoder-agent: umid-cache.json not found");
  let doc;
  try {
    doc = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    throw new Error("dsh-qoder-agent: umid-cache.json is not valid JSON");
  }
  const info = doc?.info;
  if (!info || typeof info.machineToken !== "string" || info.machineToken.length === 0) {
    throw new Error("dsh-qoder-agent: machineToken missing from umid-cache.json");
  }
  return info;
}

export { resolveKey };
