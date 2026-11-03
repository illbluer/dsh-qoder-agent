// Upstream protocol client for dsh-qoder-agent.
//
// Builds an authenticated request via the embedded qoder-auth wasm
// (QoderContext.prepareInferRequest) and streams the response, stripping the
// outer SSE envelope so the DSH shim sees standard OpenAI chunks.
import { authStamp, invalidateCredentials, readAuth, readUmid } from "./credential.js";

const GATEWAY = "gateway.qoder.com.cn";
const CLI_VERSION = "1.1.81";
// Matches the model roster in index.js. Kept here so the client can reject an
// unknown key before it costs an upstream round trip.
const DEFAULT_MODEL_SOURCE = "system";

let wasmPromise;
function loadWasm() {
  wasmPromise ??= import("./qoder-auth-wasm.mjs");
  return wasmPromise;
}

// The wasm QoderContext embeds the user's key material and is expensive to
// build, so it is cached. A *rejected* build must never be cached: an error
// such as "sign in to Qoder CN first" is frequently transient (the user signs
// in a minute later), and a poisoned promise would lock the plugin out until
// the host process restarted.
let contextPromise;
function buildContext() {
  return (async () => {
    const [{ N9i }, auth, umid] = await Promise.all([loadWasm(), readAuth(), Promise.resolve(readUmid())]);
    const QoderContext = N9i?.QoderContext;
    if (typeof QoderContext !== "function") {
      throw new Error("dsh-qoder-agent: qoder-auth wasm did not expose QoderContext");
    }
    const runtimeFields = JSON.parse(
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
    if (!runtimeFields || typeof runtimeFields.encrypt_user_info !== "string" || !runtimeFields.key) {
      throw new Error("dsh-qoder-agent: wasm did not return runtime auth fields");
    }
    const userInfo = JSON.stringify({
      uid: auth.user.id,
      encrypt_user_info: runtimeFields.encrypt_user_info,
      key: runtimeFields.key,
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
    return { N9i, ctx, stamp: authStamp() };
  })();
}

async function getContext() {
  if (contextPromise === undefined) {
    const pending = buildContext();
    contextPromise = pending;
    // Drop the cache if (and only if) this build fails, so the next call tries
    // again with fresh credentials.
    pending.catch(() => {
      if (contextPromise === pending) contextPromise = undefined;
    });
  }
  const built = await contextPromise;
  // The wasm context embeds the access token. If the desktop app has since
  // rewritten its auth file, keep serving the *old* context for the request
  // that is already in flight but rebuild for the next one: a token refresh
  // must not require a host restart, and must not invalidate a live stream.
  const stamp = authStamp();
  if (stamp !== undefined && built.stamp !== undefined && stamp !== built.stamp) {
    contextPromise = undefined;
  }
  return built;
}

/**
 * Drop the cached wasm context and the cached credentials. The next request
 * rebuilds both, which is what recovery looks like after the user signs in
 * again or the desktop app rotates the access token.
 */
export function invalidateContext() {
  contextPromise = undefined;
  invalidateCredentials();
}

function absoluteUrl(u) {
  const s = String(u ?? "");
  if (s === "") throw new Error("dsh-qoder-agent: wasm returned an empty request url");
  return /^https?:\/\//i.test(s) ? s : `https://${s.replace(/^\/+/, "")}`;
}

/** The wasm hands back a js_sys Map; normalise it to a plain object. */
function headerObject(h) {
  const out = {};
  if (!h) return out;
  const add = (k, v) => {
    if (v === undefined || v === null) return;
    out[String(k)] = String(v);
  };
  try {
    if (typeof h.entries === "function") {
      for (const [k, v] of h.entries()) add(k, v);
      if (Object.keys(out).length) return out;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof h.forEach === "function") {
      h.forEach((v, k) => add(k, v));
      if (Object.keys(out).length) return out;
    }
  } catch {
    /* fall through */
  }
  try {
    if (typeof h.toJSON === "function") {
      const j = h.toJSON();
      for (const k of Object.keys(j)) add(k, j[k]);
      return out;
    }
  } catch {
    /* fall through */
  }
  for (const k of Object.keys(h)) add(k, h[k]);
  return out;
}

/**
 * Prepare an inference request. Returns { url, headers, body, modelKey }.
 * @param {object|string} chatBody  OpenAI-style chat completion body
 * @param {string} modelKey  Qoder model key (e.g. "auto")
 */
export async function prepareInfer(chatBody, modelKey, modelSource = DEFAULT_MODEL_SOURCE) {
  const { ctx } = await getContext();
  const body = typeof chatBody === "string" ? chatBody : JSON.stringify(chatBody);
  const r = ctx.prepareInferRequest(GATEWAY, body, modelKey, modelSource);
  try {
    if (!r) throw new Error("dsh-qoder-agent: wasm prepareInferRequest returned nothing");
    return {
      url: absoluteUrl(r.url),
      headers: headerObject(r.headers),
      body: r.body,
      modelKey,
    };
  } finally {
    try {
      r?.free?.();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Peels the upstream envelope off one raw SSE stream:
 *   data:{"headers":{...},"body":"<escaped OpenAI chunk json>","statusCodeValue":200}
 * and exposes the inner OpenAI chunk. The outer HTTP status is always 200 —
 * real errors (e.g. 403 "Signature invalid") hide inside the envelope's
 * statusCodeValue/body, which is why every accessor below is total: a single
 * "null" payload must never be able to throw.
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
    if (typeof line !== "string") return null;
    const t = line.trim();
    if (!t.startsWith("data:")) return null;
    const p = t.slice(5).trim();
    if (p === "" || p === "[DONE]") return null;
    let wrapper;
    try {
      wrapper = JSON.parse(p);
    } catch {
      return null;
    }
    if (!wrapper || typeof wrapper !== "object") return null;
    if (typeof wrapper.body !== "string" || wrapper.body === "") return null;

    let obj = null;
    try {
      obj = JSON.parse(wrapper.body);
    } catch {
      obj = null;
    }

    const status = wrapper.statusCodeValue;
    if (typeof status === "number" && status >= 400) {
      const err = obj && typeof obj === "object" ? obj : { message: wrapper.body };
      this.errors.push({ status, ...err });
      return { error: { status, ...err } };
    }
    // Not an object at all (a bare "null"/"0"/string body): nothing to use.
    if (obj === null || typeof obj !== "object") return null;
    // `code` is a string on this upstream ("101" = signature invalid), so a
    // numeric-looking 200 must not be mistaken for a failure.
    if (typeof obj.code === "string" && obj.code !== "" && obj.code !== "200") {
      this.errors.push(obj);
      return { error: obj };
    }

    if (Array.isArray(obj.choices) && obj.choices.length > 0) {
      const ch = obj.choices[0] ?? {};
      const d = ch.delta ?? {};
      if (typeof d.content === "string") this.content += d.content;
      if (typeof d.reasoning_content === "string") this.reasoning += d.reasoning_content;
      // Tool-call arguments arrive as fragments: the same call id shows up in
      // several frames, so the fragments have to be concatenated by id or the
      // arguments are lost.
      if (Array.isArray(d.tool_calls)) this.#mergeToolCalls(d.tool_calls);
      if (typeof ch.finish_reason === "string" && ch.finish_reason !== "") this.finishReason = ch.finish_reason;
      if (obj.usage && typeof obj.usage === "object") this.usage = obj.usage;
      return obj;
    }
    // Some upstreams send a trailing choices:[] frame that only carries usage.
    if (obj.usage && typeof obj.usage === "object") {
      this.usage = obj.usage;
      return { usage: obj.usage };
    }
    return null;
  }

  #mergeToolCalls(deltas) {
    for (const tc of deltas) {
      if (!tc || typeof tc !== "object") continue;
      const id = typeof tc.id === "string" && tc.id !== "" ? tc.id : undefined;
      const index = typeof tc.index === "number" ? tc.index : undefined;
      const args = typeof tc.function?.arguments === "string" ? tc.function.arguments : undefined;
      let slot;
      if (id !== undefined) slot = this.toolCalls.find((c) => c.id === id);
      if (slot === undefined && index !== undefined) slot = this.toolCalls[index];
      if (slot === undefined) {
        slot = { id: id ?? `call_${this.toolCalls.length}`, type: tc.type ?? "function", function: { name: "", arguments: "" } };
        if (index !== undefined) this.toolCalls[index] = slot;
        else this.toolCalls.push(slot);
      }
      if (typeof tc.function?.name === "string" && slot.function.name === "") slot.function.name = tc.function.name;
      if (args !== undefined) slot.function.arguments += args;
    }
  }
}
