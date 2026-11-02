// Credential layer for dsh-qoder-agent.
//
// Reads the Qoder CN desktop app's own sign-in (auth.v1.dat, encrypted with
// Chromium safeStorage / DPAPI) and the device fingerprint (umid-cache.json),
// then decrypts them in-process. This mirrors dsh-workbuddy-bridge's
// "read the app's own login state, read-only" approach.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Candidate data directories. CN app is "com.qodercn.app.stable".
const APP_DATA_DIRS = [
  join(process.env.APPDATA ?? "", "com.qodercn.app.stable"),
  join(process.env.LOCALAPPDATA ?? "", "com.qodercn.app.stable"),
];
// .qoder-cn home dir (device fingerprint).
const QODER_HOME = join(homedir(), ".qoder-cn");

function firstExisting(paths) {
  for (const p of paths) if (existsSync(p)) return p;
  return undefined;
}

// --- DPAPI-safeStorage AES key --------------------------------------------
// The "Local State" file (Chromium profile) holds os_crypt.encrypted_key:
// base64 of "DPAPI" (5 bytes) + a DPAPI blob. Unprotecting that blob yields
// the 32-byte AES key used for safeStorage "v10" payloads. We shell out to
// PowerShell because DPAPI (System.Security.Cryptography.ProtectedData) has no
// Node built-in on Windows.
async function dpapiUnprotectKey(localStatePath) {
  const ps = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$j = Get-Content -Raw -LiteralPath ${JSON.stringify(localStatePath)} | ConvertFrom-Json
$blob = [Convert]::FromBase64String($j.os_crypt.encrypted_key)
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
  return Buffer.from(b64, "base64");
}

// --- AES-GCM decrypt of a v10 safeStorage payload --------------------------
// Layout: "v10" (3 bytes) + nonce (12) + ciphertext + tag (16), no AAD.
function decryptV10(buf, key) {
  if (buf.length < 3 + 12 + 16) throw new Error("dsh-qoder-agent: credential file too short");
  const nonce = buf.subarray(3, 15);
  const tag = buf.subarray(buf.length - 16);
  const ct = buf.subarray(15, buf.length - 16);
  // Node has no synchronous AES-GCM, so use the async crypto.
  return { nonce, tag, ct };
}

import { createDecipheriv } from "node:crypto";
async function gcmDecrypt(key, nonce, ct, tag) {
  const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  d.setAuthTag(tag);
  const out = Buffer.concat([d.update(ct), d.final()]);
  return out.toString("utf8");
}

// --- Public API -------------------------------------------------------------
let cachedAuth;
let cachedKey;

async function resolveKey() {
  if (cachedKey) return cachedKey;
  const localState = firstExisting(APP_DATA_DIRS.map((d) => join(d, "Local State")));
  if (!localState) throw new Error("dsh-qoder-agent: Qoder CN Local State not found — is the app installed?");
  cachedKey = await dpapiUnprotectKey(localState);
  return cachedKey;
}

/** Decrypt and return the Qoder CN auth document (token, refreshToken, user). */
export async function readAuth() {
  if (cachedAuth) return cachedAuth;
  const key = await resolveKey();
  const authPath = firstExisting(APP_DATA_DIRS.map((d) => join(d, "auth.v1.dat")));
  if (!authPath) throw new Error("dsh-qoder-agent: auth.v1.dat not found — sign in to Qoder CN first");
  const buf = readFileSync(authPath);
  const { nonce, tag, ct } = decryptV10(buf, key);
  const text = await gcmDecrypt(key, nonce, ct, tag);
  cachedAuth = JSON.parse(text);
  return cachedAuth;
}

/** Read the device fingerprint (machineToken) from umid-cache.json. */
export function readUmid() {
  const p = join(QODER_HOME, "umid-cache.json");
  if (!existsSync(p)) throw new Error("dsh-qoder-agent: umid-cache.json not found");
  const doc = JSON.parse(readFileSync(p, "utf8"));
  const token = doc?.info?.machineToken;
  if (!token) throw new Error("dsh-qoder-agent: machineToken missing from umid-cache.json");
  return doc.info;
}

export { resolveKey };
