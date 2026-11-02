// Upstream protocol client for dsh-qoder-agent.
//
// Builds an authenticated request via the embedded qoder-auth wasm
// (QoderContext.prepareInferRequest) and streams the response, stripping the
// outer SSE envelope so the DSH shim sees standard OpenAI chunks.
import { readAuth, readUmid } from "./credential.js";

const GATEWAY = "gateway.qoder.com.cn";
const CLI_VERSION = "1.1.81";

let wasmPromise;
async function loadWasm() {
  if (!wasmPromise) wasmPromise = import("./qoder-auth-wasm.mjs");
  return wasmPromise;
}

let contextPromise;
async function getContext() {
  if (!contextPromise) {
    contextPromise = (async () => {
      const [{ N9i }, auth, umid] = await Promise.all([
        loadWasm(),
        readAuth(),
        Promise.resolve(readUmid()),
      ]);
      const QoderContext = N9i.QoderContext;
      const rt = JSON.parse(
        N9i.generate_runtime_auth_fields(
          JSON.stringify({
            uid: auth.user.id,
            security_oauth_token: auth.token,
            organization_id: "",
            organization_tags: [],
            data_policy_agreed: false,
          }),
        ),
      );
      const userInfo = JSON.stringify({
        uid: auth.user.id,
        encrypt_user_info: rt.encrypt_user_info,
        key: rt.key,
        organization_id: "",
        organization_tags: [],
        data_policy_agreed: false,
      });
      const ctx = new QoderContext(
        umid.machineToken,
        CLI_VERSION,
        userInfo,
        JSON.stringify({
          client_type: "qoder_cli",
          business_product: "qoder_cli",
          business_type: "qoder_cli",
          scene: "assistant",
        }),
      );
      return { N9i, ctx };
    })();
  }
  return contextPromise;
}

/** Reset the cached context (e.g. after the user re-signs in). */
export function invalidateContext() {
  contextPromise = undefined;
}

function absoluteUrl(u) {
  const s = String(u ?? "");
  return /^https?:\/\//i.test(s) ? s : "https://" + s.replace(/^\/+/, "");
}

/** The wasm hands back a js_sys Map; normalise it to a plain object. */
function headerObject(h) {
  const out = {};
  if (!h) return out;
  try {
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) out[String(k)] = String(v);
      if (Object.keys(out).length) return out;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof h.forEach === "function") {
      h.forEach((v, k) => {
        out[String(k)] = String(v);
      });
      if (Object.keys(out).length) return out;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof h.toJSON === "function") {
      const j = h.toJSON();
      for (const k of Object.keys(j)) out[k] = String(j[k]);
      return out;
    }
  } catch {
    /* fall through */
  }
  for (const k of Object.keys(h)) out[k] = String(h[k]);
  return out;
}

/**
 * Prepare an inference request. Returns { url, headers, body, modelKey }.
 * @param {object} chatBody  OpenAI-style chat completion body
 * @param {string} modelKey  Qoder model key (e.g. "auto")
 */
export async function prepareInfer(chatBody, modelKey) {
  const { ctx } = await getContext();
  const body = typeof chatBody === "string" ? chatBody : JSON.stringify(chatBody);
  const r = ctx.prepareInferRequest(GATEWAY, body, modelKey, "system");
  try {
    return {
      url: absoluteUrl(r.url),
      headers: headerObject(r.headers),
      body: r.body,
      modelKey,
    };
  } finally {
    try {
      r.free();
    } catch {
      /* ignore */
    }
  }
}

/** Prepare a plain API request (e.g. model list), auth mode. */
export async function prepareApi(path, method = "GET") {
  const { ctx } = await getContext();
  const r = ctx.prepareRequest(GATEWAY, path, method, "auth", undefined, undefined);
  try {
    return { url: absoluteUrl(r.url), headers: headerObject(r.headers) };
  } finally {
    try {
      r.free();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Parse one raw SSE stream into OpenAI chunk objects. The upstream wraps every
 * real chunk in:
 *   data:{"headers":{...},"body":"<escaped OpenAI chunk json>","statusCodeValue":200}
 * so we peel that envelope and re-emit the inner chunk.
 *
 * Note: the outer HTTP status is always 200 — real errors (e.g. 403
 * "Signature invalid") hide inside the envelope's statusCodeValue/body.
 */
export class QoderStreamParser {
  constructor() {
    this.content = "";
    this.reasoning = "";
    this.finishReason = null;
    this.usage = null;
    this.toolCalls = [];
    this.errors = [];
  }

  /** Feed one SSE text line; returns an inner OpenAI chunk object or null. */
  feed(line) {
    const t = line.trim();
    if (!t.startsWith("data:")) return null;
    const p = t.slice(5).trim();
    if (!p || p === "[DONE]") return null;
    let wrapper;
    try {
      wrapper = JSON.parse(p);
    } catch {
      return null;
    }
    if (!wrapper || !wrapper.body) return null;

    let obj;
    try {
      obj = JSON.parse(wrapper.body);
    } catch {
      obj = { raw: wrapper.body };
    }

    const status = wrapper.statusCodeValue;
    if (typeof status === "number" && status >= 400) {
      this.errors.push({ status, ...obj });
      return { error: { status, ...obj } };
    }
    if (obj && typeof obj.code === "string" && obj.code !== "200") {
      this.errors.push(obj);
      return { error: obj };
    }

    if (Array.isArray(obj.choices) && obj.choices.length) {
      const ch = obj.choices[0];
      const d = ch.delta || {};
      if (typeof d.content === "string") this.content += d.content;
      if (typeof d.reasoning_content === "string") this.reasoning += d.reasoning_content;
      if (Array.isArray(d.tool_calls)) this.toolCalls.push(...d.tool_calls);
      if (ch.finish_reason) this.finishReason = ch.finish_reason;
      if (obj.usage) this.usage = obj.usage;
      return obj;
    }
    // Some upstreams send a trailing choices:[] frame that only carries usage.
    if (obj && obj.usage) {
      this.usage = obj.usage;
      return { usage: obj.usage };
    }
    return null;
  }
}
