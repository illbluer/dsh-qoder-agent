// dsh-qoder-agent — bring Qoder CN desktop app models into the agent runtime.
//
// Architecture (mirrors dsh-workbuddy-bridge):
//   1. loopback shim  — an OpenAI-compatible HTTP endpoint on 127.0.0.1:0
//   2. pi-ai adapter — wraps the shim as a provider DSH understands
//   3. registration   — ctx.llm.registerAdapter(["qoder-agent"], adapter)
//
// The upstream credential comes from the Qoder CN app's own sign-in state
// (decrypted via DPAPI), and every request's Authorization header is produced
// by the embedded qoder-auth wasm. No CLI subprocess, no separate OAuth.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createProvider } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { resolveRetryPolicy } from "@deepseek-ai/dsh-llm";
import { PiAiAdapter } from "@deepseek-ai/dsh-llm-pi-ai";
import { invalidateContext, prepareInfer, QoderStreamParser } from "./client.js";
import { readAuth } from "./credential.js";

const PROVIDER_ID = "qoder-agent";
const DISPLAY_NAME = "Qoder CN";

// --- static model catalog (chat scene, from /api/v2/model/list) ------------
// Live fetch is possible but the roster is stable; a static list keeps startup
// fast and works offline. key -> { name, contextWindow, maxTokens, reasoning }
const MODELS = [
  { key: "auto", name: "Auto", contextWindow: 200000, maxTokens: 32768, reasoning: true, price: 0.5 },
  { key: "fast", name: "Fast", contextWindow: 200000, maxTokens: 32768, reasoning: true, price: 0.8 },
  { key: "qmodel_38max", name: "Qwen3.8-Max", contextWindow: 180000, maxTokens: 32768, reasoning: true, price: 0.5 },
  { key: "qfmodel", name: "Qwen3.8-Flash", contextWindow: 180000, maxTokens: 32768, reasoning: true, price: 0 },
  { key: "dmodel", name: "DeepSeek-V4-Pro", contextWindow: 96000, maxTokens: 32768, reasoning: true, price: 0.5 },
  { key: "dfmodel", name: "DeepSeek-Flash", contextWindow: 180000, maxTokens: 32768, reasoning: false, price: 0.1 },
  { key: "gmodel", name: "GLM-5.3", contextWindow: 180000, maxTokens: 32768, reasoning: true, price: 0.8 },
  { key: "gfmodel", name: "GLM-5.3-Flash", contextWindow: 1000000, maxTokens: 32768, reasoning: true, price: 0.1 },
  { key: "kmodel_latest", name: "Kimi-K3.1-Pro", contextWindow: 180000, maxTokens: 32768, reasoning: false, price: 1 },
  { key: "kmodel", name: "Kimi-K2.8-Preview", contextWindow: 180000, maxTokens: 32768, reasoning: true, price: 0.8 },
  { key: "mmodel", name: "MiniMax-M3.1-Flash", contextWindow: 180000, maxTokens: 32768, reasoning: false, price: 0.1 },
];

// The display suffix shows the billing multiplier so the user can see cost.
const RATE_SEPARATOR = " · ";
function displayName(m) {
  const suffix = m.price === 0 ? "免费" : `x${m.price}`;
  return `${m.name}${RATE_SEPARATOR}${suffix}`;
}

// --- inert auth + no-cost, same as workbuddy --------------------------------
const INERT_AUTH = {
  credentials: {
    async read() {},
    async list() { return []; },
    async modify() { throw new Error("dsh-qoder-agent: no pi-ai credential lifecycle"); },
    async delete() {},
  },
  authContext: {
    async env() {},
    async fileExists() { return false; },
  },
};
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

function toPiModel(m, baseUrl) {
  // pi-ai reads `reasoning` as a boolean and the per-level wire spellings from
  // a *sibling* `thinkingLevelMap`; nesting the map inside `reasoning` left
  // `model.thinkingLevelMap` undefined, so every level (including the ones the
  // upstream has no spelling for) looked supported.
  const reasoning = m.reasoning
    ? {
        reasoning: true,
        thinkingLevelMap: {
          off: "off",
          minimal: null,
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: null,
        },
      }
    : { reasoning: false };
  return {
    id: m.key,
    // The billing multiplier is part of the visible name so the picker shows
    // what a turn costs (Qwen3.8-Flash is free, Kimi-K3.1-Pro is 1x).
    name: displayName(m),
    api: "openai-completions",
    provider: PROVIDER_ID,
    baseUrl,
    input: ["text"],
    ...reasoning,
    cost: NO_COST,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    compat: { maxTokensField: "max_tokens" },
  };
}

const REQUEST_IMAGE_BUDGETS = {
  maxRequestImageBytes: 20971520,
  requestImagePixelBudget: 4194304,
  requestImageMaxBytes: 1048576,
};

function createQoderAdapter(shim) {
  const buildModels = () => {
    const baseUrl = `${shim.baseUrl()}/v1`;
    return MODELS.map((m) => toPiModel(m, baseUrl));
  };
  const provider = {
    ...createProvider({
      id: PROVIDER_ID,
      name: DISPLAY_NAME,
      auth: {
        apiKey: {
          name: "Qoder CN device token",
          async resolve({ credential }) {
            const apiKey = credential?.key;
            return apiKey === undefined || apiKey.length === 0
              ? undefined
              : { auth: { apiKey }, source: "Qoder" };
          },
        },
      },
      models: buildModels(),
      api: openAICompletionsApi(),
    }),
    getModels: () => buildModels(),
  };
  const profile = {
    provider: PROVIDER_ID,
    displayName: DISPLAY_NAME,
    streamIdleTimeoutMs: 300000,
    retryPolicy: resolveRetryPolicy(undefined, "dsh-qoder-agent retryPolicy"),
    configuredMaxTokens: new Map(),
    modelErrors: new Map(),
    ...REQUEST_IMAGE_BUDGETS,
    piProvider: provider,
  };
  // profiles is rebuilt per call because the shim's baseUrl is only known once
  // the loopback server is listening; PiAiAdapter takes a getter for exactly
  // that reason.
  const profiles = () => new Map([[PROVIDER_ID, profile]]);
  return {
    adapter: new PiAiAdapter({
      profiles,
      auth: INERT_AUTH,
      resolveApiKey: async () => shim.token(),
    }),
  };
}

// --- loopback shim -----------------------------------------------------------
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);
function hostnameOfHost(host) {
  let h = host.trim().toLowerCase();
  if (h.startsWith("[")) {
    const end = h.indexOf("]");
    return end === -1 ? h : h.slice(0, end + 1);
  }
  const colon = h.lastIndexOf(":");
  if (colon !== -1 && !h.slice(0, colon).includes(":") && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}
function hostIsLoopback(host) {
  if (host === undefined || host.trim() === "") return false;
  return LOOPBACK_HOSTS.has(hostnameOfHost(host));
}
function originIsLoopback(origin) {
  if (origin === undefined || origin.trim() === "") return true;
  try {
    const { hostname } = new URL(origin);
    return LOOPBACK_HOSTS.has(hostname) || hostname === "::1";
  } catch {
    return false;
  }
}
function isJsonContentType(req) {
  const t = req.headers["content-type"];
  return typeof t === "string" && t.trim().toLowerCase().startsWith("application/json");
}
function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}
function writeOpenAIError(res, status, kind, message) {
  writeJson(res, status, { error: { message, type: kind, code: kind } });
}
const REQUEST_BODY_LIMIT = 67108864;
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const done = (fn, value) => {
      if (settled) return;
      settled = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      fn(value);
    };
    function onData(chunk) {
      size += chunk.length;
      if (size > REQUEST_BODY_LIMIT) {
        // Answer with 413 instead of destroying the socket: the caller gets a
        // readable error, and the plugin is not left holding a half-read body.
        done(reject, new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    }
    function onEnd() {
      done(resolve, Buffer.concat(chunks));
    }
    function onError(error) {
      done(reject, error);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

function createQoderShim(options) {
  const logger = options.logger;
  const SHARED_SECRET = randomBytes(32).toString("base64url");
  function bearerOk(req) {
    const header = req.headers.authorization;
    if (typeof header !== "string") return false;
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match === null) return false;
    const a = Buffer.from(match[1]);
    const b = Buffer.from(SHARED_SECRET);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
  const server = createServer((req, res) => handle(req, res));
  const ready = new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  server.listen(0, "127.0.0.1");
  const baseUrl = () => {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("qoder shim has no listening address");
    return `http://127.0.0.1:${address.port}`;
  };

  async function handle(req, res) {
    try {
      if (!hostIsLoopback(req.headers.host)) {
        writeOpenAIError(res, 403, "host_not_allowed", "Host header must name the loopback interface");
        return;
      }
      if (!originIsLoopback(req.headers.origin)) {
        writeOpenAIError(res, 403, "origin_not_allowed", "Origin must be a loopback origin");
        return;
      }
      if (!bearerOk(req)) {
        writeOpenAIError(res, 401, "unauthorized", "missing or invalid Authorization bearer");
        return;
      }
      const url = req.url ?? "/";
      if (req.method === "GET" && (url === "/healthz" || url === "/healthz/")) {
        writeJson(res, 200, { ok: true });
        return;
      }
      if (req.method === "GET" && (url === "/v1/models" || url === "/v1/models/")) {
        writeJson(res, 200, {
          object: "list",
          data: MODELS.map((m) => ({ id: m.key, object: "model", created: 0, owned_by: "qodercn" })),
        });
        return;
      }
      if (req.method === "POST" && (url === "/v1/chat/completions" || url === "/v1/chat/completions/")) {
        await chatCompletions(req, res);
        return;
      }
      writeOpenAIError(res, 404, "not_found", `no such route: ${req.method} ${url}`);
    } catch (error) {
      // Nothing here may throw: this catch sits outside every await boundary
      // the request owns, and a throw would escape as an unhandled rejection.
      try {
        if (!res.headersSent && !res.destroyed) writeOpenAIError(res, 500, "internal", String(error));
        else if (!res.writableEnded) res.end();
      } catch {
        /* the socket is already gone */
      }
    }
  }

  async function chatCompletions(req, res) {
    if (!isJsonContentType(req)) {
      writeOpenAIError(res, 415, "unsupported_media_type", "Content-Type must be application/json");
      return;
    }
    // Confirm we have a credential before reading a potentially large body.
    try {
      await readAuth();
    } catch (error) {
      writeOpenAIError(res, 401, "not_signed_in", String(error));
      return;
    }
    let raw;
    try {
      raw = (await readBody(req)).toString("utf8");
    } catch (error) {
      writeOpenAIError(res, 413, "client", String(error));
      return;
    }
    let chatBody;
    try {
      chatBody = JSON.parse(raw);
    } catch {
      writeOpenAIError(res, 400, "client", "invalid JSON body");
      return;
    }
    // Resolve the requested model id back to a Qoder key. Model ids in the pi
    // catalog are the Qoder keys, but a client may still send the provider
    // qualified form ("qoder-agent/auto"); an unknown key would otherwise be
    // forwarded verbatim and rejected upstream as "Model not exist".
    const requested = typeof chatBody.model === "string" ? chatBody.model : "";
    const bare = requested.startsWith(`${PROVIDER_ID}/`) ? requested.slice(PROVIDER_ID.length + 1) : requested;
    const modelKey = MODELS.some((m) => m.key === bare) ? bare : "auto";
    // Force stream=true; the upstream rejects non-stream. Also rewrite the
    // `developer` role (pi-ai's convention) to `system` — the upstream fails
    // the whole request with "All models failed" when it sees `developer`.
    const upstreamBody = { ...chatBody, stream: true, stream_options: { include_usage: true } };
    if (Array.isArray(upstreamBody.messages)) {
      upstreamBody.messages = upstreamBody.messages.map((m) =>
        m && m.role === "developer" ? { ...m, role: "system" } : m,
      );
    }
    if (upstreamBody.stream_options && upstreamBody.stream_options.include_usage === undefined) {
      upstreamBody.stream_options.include_usage = true;
    }
    // The catalog advertises text-only models; forwarding image parts would be
    // rejected upstream with an opaque "Execution failed". Drop them and say so
    // in the error channel instead of guessing at a translation.
    if (Array.isArray(upstreamBody.messages)) {
      const wantsImages = upstreamBody.messages.some(
        (m) => m && Array.isArray(m.content) && m.content.some((p) => p && (p.type === "image_url" || p.type === "image")),
      );
      if (wantsImages) {
        writeOpenAIError(res, 400, "client", "dsh-qoder-agent: the Qoder CN chat scene accepts text only");
        return;
      }
    }

    let prepared;
    try {
      prepared = await prepareInfer(upstreamBody, modelKey);
    } catch (error) {
      writeOpenAIError(res, 502, "server", `upstream prepare failed: ${String(error)}`);
      return;
    }

    const controller = new AbortController();
    // Abort the upstream fetch only when the *client* goes away before we
    // finished answering. Binding this to req's "close" instead would be a
    // trap: an IncomingMessage emits "close" as soon as its body has been
    // read, so a request would abort itself the moment it started.
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    let upstreamResp;
    try {
      upstreamResp = await fetch(prepared.url, {
        method: "POST",
        headers: prepared.headers,
        body: prepared.body,
        signal: controller.signal,
      });
    } catch (error) {
      // An abort here means the caller hung up while we were waiting upstream;
      // there is nobody left to answer, and touching a destroyed response
      // throws.
      if (controller.signal.aborted) return;
      writeOpenAIError(res, 502, "server", `upstream request failed: ${String(error)}`);
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const decoder = new StringDecoder("utf8");
    const parser = new QoderStreamParser();
    let carry = "";
    // A write into a socket the client already closed does not throw (verified:
    // it returns false and flags res.destroyed), but it is pure noise, and
    // `res.writable` stays true after end(), so it is the wrong guard. Check the
    // two flags that actually mark a finished response.
    const canWrite = () => !res.writableEnded && !res.destroyed;
    const safeWrite = (chunk) => {
      if (!canWrite()) return;
      try {
        res.write(chunk);
      } catch {
        /* client went away */
      }
    };
    const finish = () => {
      if (!res.writableEnded) {
        try {
          res.end();
        } catch {
          /* already gone */
        }
      }
    };
    if (!upstreamResp.body) {
      safeWrite(
        `data: ${JSON.stringify({ error: { message: "upstream returned an empty body", type: "upstream_error", code: "upstream_error" } })}\n\n`,
      );
      safeWrite("data: [DONE]\n\n");
      finish();
      return;
    }
    const body = Readable.fromWeb(upstreamResp.body);
    body.on("data", (chunk) => {
      // A throwing listener here would take down the whole host process: the
      // stream event has no await boundary to catch it. Everything below is
      // therefore best-effort, and a malformed frame is skipped, never fatal.
      if (!canWrite()) return;
      let text;
      try {
        text = decoder.write(chunk);
      } catch {
        return;
      }
      carry += text;
      // Split on newlines; keep a trailing partial line in carry.
      let idx;
      while ((idx = carry.indexOf("\n")) !== -1) {
        const line = carry.slice(0, idx);
        carry = carry.slice(idx + 1);
        let inner;
        try {
          inner = parser.feed(line);
        } catch (error) {
          logger?.warn("dsh-qoder-agent: skipped malformed upstream frame", error);
          continue;
        }
        if (inner && inner.error) {
          // An upstream error frame: emit it as a final error chunk and stop.
          const err = inner.error;
          const code = err.code ?? "upstream_error";
          const msg = err.message ?? JSON.stringify(err);
          // A rejected signature almost always means the cached wasm context
          // was built from a token the app has since refreshed. Drop it so the
          // next request re-derives from the current auth file instead of
          // staying broken until the host restarts.
          if (/signature|unauthor|token|expired/i.test(String(msg))) invalidateContext();
          // Keep status digits out of the message text (dsh-llm-pi-ai AUTH regex).
          safeWrite(`data: ${JSON.stringify({ error: { message: msg, type: code, code } })}\n\n`);
          continue;
        }
        if (inner) {
          safeWrite(`data: ${JSON.stringify(inner)}\n\n`);
        }
      }
    });
    body.on("error", (error) => {
      logger?.warn("dsh-qoder-agent: upstream stream failed mid-flight", error);
      // Always terminate the child stream: the upstream's own "[DONE]" is
      // swallowed by the parser, so the caller only ever sees the one we write.
      safeWrite("data: [DONE]\n\n");
      finish();
    });
    body.on("end", () => {
      // A truncated upstream (no [DONE]) still has to terminate the child
      // stream, otherwise the caller waits for the idle timeout.
      safeWrite("data: [DONE]\n\n");
      finish();
    });
    // If the caller goes away, stop pulling from upstream instead of writing
    // into a dead socket.
    res.on("close", () => {
      body.destroy?.();
    });
  }

  return {
    ready,
    baseUrl,
    token: () => SHARED_SECRET,
    close: () => server.close(),
  };
}

// --- plugin entry ------------------------------------------------------------
// A host-plugin apply() that registers asynchronously owes the registry one
// notification: the loopback endpoint only knows its port after `listening`, so
// registration necessarily lands after the first client read. Without the
// emit the picker keeps the provider list it fetched at connect time and the
// group never appears until a full reload.
const STATUS_FILE = ".qoder-agent-status.json";
function writeStatus(patch) {
  try {
    const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
    const file = join(home, STATUS_FILE);
    let prior = {};
    try {
      prior = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    // `at` merges, so a stale failure would outlive the recovery it was
    // recorded for. A successful registration clears the previous error.
    const merged = { ...prior, ...patch, at: new Date().toISOString() };
    if (patch.registered === true) {
      delete merged.error;
      delete merged.stack;
    }
    writeFileSync(file, JSON.stringify(merged, null, 2));
  } catch {}
}

export function apply(ctx) {
  const shim = createQoderShim({ logger: ctx.logger });
  let release = () => {
    try {
      shim.close();
    } catch {}
  };
  // Register the disposal *before* anything can throw: if registration fails
  // halfway we still need the listening socket to be closed with the fiber.
  try {
    ctx.effect(() => () => release());
  } catch {
    /* no effect scope: the shim dies with the process anyway */
  }
  shim.ready
    .then(() => {
      const qoder = createQoderAdapter(shim);
      const releaseAdapter = ctx.llm.registerAdapter([PROVIDER_ID], qoder.adapter);
      release = () => {
        try {
          releaseAdapter();
        } catch {}
        try {
          shim.close();
        } catch {}
      };
      // Registration lands after the client's first provider read, so the
      // registry has to announce the change or the picker keeps its cache.
      try {
        ctx.emit?.("llm/adapters-updated");
      } catch (error) {
        ctx.logger?.warn?.("dsh-qoder-agent: could not emit llm/adapters-updated", error);
      }
      // Diagnostics must never be able to break the registration path.
      try {
        writeStatus({
          pid: process.pid,
          baseUrl: shim.baseUrl(),
          registered: true,
          providers: (ctx.llm.listProviders?.() ?? []).map((p) => ({ id: p.id, name: p.name })),
        });
        ctx.llm
          .listModels(PROVIDER_ID)
          .then((models) => writeStatus({ models: models.map((m) => m.id), modelCount: models.length }))
          .catch((error) => writeStatus({ modelsError: String(error) }));
      } catch (error) {
        ctx.logger?.warn?.("dsh-qoder-agent: status probe failed", error);
      }
    })
    .catch((error) => {
      writeStatus({ registered: false, error: String(error), stack: error?.stack });
      // This catch is the last line of defence of an async apply(): if logging
      // threw here the failure would surface as an unhandled rejection instead
      // of a readable line.
      try {
        ctx.logger.error("dsh-qoder-agent: loopback endpoint failed to start", error);
      } catch {}
    });
}

export const name = "dsh-qoder-agent";
/** The model registry that must exist before this plugin registers a route. */
export const inject = ["llm"];
