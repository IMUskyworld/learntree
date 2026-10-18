/**
 * learntree · AI 分解（只做一件事：把一个节点拆成若干子问题）
 * 规格见 DEVELOPMENT.md §9。这里的函数都不碰 DOM，fetch 由调用方注入。
 */

import { MAX_TITLE } from "./tree.js";

export const DEFAULT_TIMEOUT_MS = 20000;
export const MAX_ITEMS = 8;
export const ITEM_KEYS = Object.freeze(["subproblems", "children", "items"]);

export const SYSTEM_PROMPT = [
  "你是一个学习规划助手，帮助用户把一个大问题拆成可以继续追问的小问题。",
  "只输出 JSON，不要解释、不要客套、不要 Markdown 围栏。",
  "输出的每一条都必须能作为一个独立的学习任务被判断「是否已经搞懂」。",
].join("\n");

export const ERROR_CODES = Object.freeze([
  "not_configured",
  "network",
  "timeout",
  "http_status",
  "invalid_response",
  "invalid_json",
  "empty_result",
]);

/* ------------------------------------------------------------------ 配置 */

export function normalizeBaseUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  url.search = "";
  let path = url.pathname.replace(/\/+$/, "");
  if (path.endsWith("/chat/completions")) return url.origin + path;
  if (!path.endsWith("/v1")) path = `${path}/v1`;
  url.pathname = path;
  return url.origin + url.pathname;
}

/** 规范化成 chat/completions 端点：允许用户填 .../v1 或 .../v1/chat/completions。 */
export function completionsUrl(value) {
  const base = normalizeBaseUrl(value);
  if (!base) return null;
  return base.endsWith("/chat/completions") ? base : `${base}/chat/completions`;
}

/** AI 是否可用；不可用时给出原因，供界面把按钮置灰并解释。 */
export function configIssue(config) {
  if (!config || config.enabled !== true) return "disabled";
  if (!normalizeBaseUrl(config.baseUrl)) return "missing_or_invalid_baseUrl";
  if (!String(config.model ?? "").trim()) return "missing_model";
  return null;
}

export function isConfigured(config) {
  return configIssue(config) === null;
}

/* ------------------------------------------------------------------ Prompt */

export function buildUserPrompt(input) {
  const path = (input.pathTitles ?? []).filter(Boolean);
  const existing = (input.existingChildTitles ?? []).filter(Boolean);
  const lines = [
    `学习目标：${input.treeTitle ?? "（未命名）"}`,
    `当前所处路径：${path.length ? path.join(" › ") : "（根）"}`,
    `要拆解的问题：${input.title ?? ""}`,
  ];
  if (input.note) lines.push(`补充说明：${input.note}`);
  if (existing.length) lines.push(`已经拆出来的子问题（不要重复）：${existing.join("、")}`);
  lines.push(
    "",
    "请给出 3-6 个更具体、可以逐个动手解决的子问题。要求：",
    "1. 每条 title 不超过 40 字，是问句或可验证的任务句；",
    "2. 按建议的学习顺序排列，前置知识在前；",
    "3. 不要重复「要拆解的问题」本身，也不要重复已列出的子问题；",
    "4. hint 是一句话的入手提示，没有就留空字符串。",
    "",
    "严格按这个 schema 输出，不要添加别的键：",
    '{"subproblems":[{"title":"字符串","hint":"字符串"}]}',
  );
  return lines.join("\n");
}

export function buildMessages(input) {
  return [
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildUserPrompt(input) },
  ];
}

export function buildRequestBody(config, input) {
  return {
    model: String(config.model ?? "").trim(),
    messages: buildMessages(input),
    temperature: 0.4,
    max_tokens: 900,
    response_format: { type: "json_object" },
  };
}

/**
 * 设置页「看看将要发什么」用：把 payload 摊开给人看，key 一律打码。
 */
export function previewRequest(config, input) {
  const url = completionsUrl(config.baseUrl);
  const body = buildRequestBody(config, input);
  return {
    method: "POST",
    url,
    headers: redactedHeaders(config),
    body,
    bytes: JSON.stringify(body).length,
  };
}

export function redactedHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  if (config?.apiKey) headers.Authorization = `Bearer ${maskSecret(config.apiKey)}`;
  return headers;
}

export function maskSecret(value) {
  const raw = String(value ?? "");
  if (raw.length <= 8) return "*".repeat(raw.length);
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/* ------------------------------------------------------------------ 解析 */

/** 从散文/围栏里抠出第一个配平的 JSON 对象；括号在字符串内不参与计数。 */
export function extractJsonObject(text) {
  const raw = String(text ?? "");
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : raw;
  const start = body.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i += 1) {
    const char = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return body.slice(start, i + 1);
    }
  }
  return null;
}

function squash(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function keyOf(title) {
  return title.toLowerCase().replace(/[\s\-_/\\|。，,、·:：;；！？!?（）()\[\]{}“”‘’"'`~]/g, "");
}

/**
 * 严格的解析：任何一步说不通都返回结构化错误。
 * 关键约束（§22-5）：解析出 0 条 ≠ 成功，绝不能把"没结果"当成"不需要拆"。
 */
export function parseDecomposition(text, options = {}) {
  const maxItems = options.maxItems ?? MAX_ITEMS;
  const existing = (options.existingTitles ?? []).map(squash).filter(Boolean);
  const existingKeys = new Set(existing.map(keyOf));
  const jsonText = extractJsonObject(text);
  if (!jsonText) {
    return { ok: false, error: { code: "invalid_json", message: "回复里找不到 JSON 对象", raw: clip(text) } };
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (cause) {
    return {
      ok: false,
      error: { code: "invalid_json", message: `JSON 解析失败：${cause.message}`, raw: clip(jsonText) },
    };
  }
  const key = ITEM_KEYS.find((name) => Array.isArray(parsed?.[name]));
  if (!key) {
    return {
      ok: false,
      error: {
        code: "invalid_json",
        message: `JSON 里缺少数组字段，期望其中之一：${ITEM_KEYS.join(" / ")}`,
        raw: clip(jsonText),
      },
    };
  }
  const seen = new Set();
  const items = [];
  let dropped = 0;
  for (const entry of parsed[key]) {
    const title = squash(typeof entry === "string" ? entry : entry?.title ?? entry?.name);
    const hint = squash(typeof entry === "object" ? entry?.hint ?? entry?.description : "");
    const dedupeKey = keyOf(title);
    if (!title || !dedupeKey || seen.has(dedupeKey) || existingKeys.has(dedupeKey)) {
      dropped += 1;
      continue;
    }
    seen.add(dedupeKey);
    items.push({ title: title.slice(0, MAX_TITLE), hint: hint.slice(0, 200) });
  }
  if (!items.length) {
    return {
      ok: false,
      error: {
        code: "empty_result",
        message: "模型没有给出任何可用的子问题（可能与已有子问题完全重复）",
        raw: clip(jsonText),
      },
    };
  }
  const truncated = items.length > maxItems;
  return {
    ok: true,
    items: truncated ? items.slice(0, maxItems) : items,
    meta: { truncated, dropped, sourceKey: key, total: items.length },
  };
}

function clip(value, max = 600) {
  const raw = String(value ?? "");
  return raw.length > max ? `${raw.slice(0, max)}…` : raw;
}

/* ------------------------------------------------------------------ 调用 */

export function buildHeaders(config) {
  const headers = { "Content-Type": "application/json" };
  const apiKey = String(config?.apiKey ?? "").trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

/**
 * 唯一的外部副作用出口。
 * fetchImpl 由调用方注入：浏览器传 window.fetch，测试传假实现，verify_mvp 用 Node 的真 fetch。
 */
export async function callLlm(input) {
  const { config, fetchImpl } = input;
  // 设置页把超时存在 llm.timeoutMs 里，调用方也可以临时覆盖 —— 两处都要认。
  const configured = Number(config?.timeoutMs);
  const timeoutMs = input.timeoutMs ?? (Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_TIMEOUT_MS);
  const issue = configIssue(config);
  if (issue) {
    return {
      ok: false,
      items: [],
      error: {
        code: "not_configured",
        message: notConfiguredMessage(issue),
        reason: issue,
      },
    };
  }
  const url = completionsUrl(config.baseUrl);
  const body = buildRequestBody(config, input);
  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
  let response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      headers: buildHeaders(config),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    if (timer) clearTimeout(timer);
    const aborted = cause?.name === "AbortError";
    return {
      ok: false,
      items: [],
      error: {
        code: aborted ? "timeout" : "network",
        message: aborted
          ? `请求超过 ${timeoutMs}ms 未返回（本地网络或 CORS 代理没起？）`
          : `请求发不出去：${cause?.message ?? cause}`,
      },
    };
  }
  if (timer) clearTimeout(timer);

  let text = "";
  try {
    text = await response.text();
  } catch (cause) {
    return { ok: false, items: [], error: { code: "network", message: `读取响应失败：${cause}` } };
  }
  if (!response.ok) {
    return {
      ok: false,
      items: [],
      error: {
        code: "http_status",
        message: `服务返回 HTTP ${response.status}`,
        status: response.status,
        raw: clip(text),
      },
    };
  }
  const content = pickContent(text);
  if (content === null) {
    return {
      ok: false,
      items: [],
      error: { code: "invalid_response", message: "响应不是 OpenAI 风格的 choices[0].message.content", raw: clip(text) },
    };
  }
  const result = parseDecomposition(content, { existingTitles: input.existingChildTitles, maxItems: input.maxItems });
  if (!result.ok) return { ok: false, items: [], error: { ...result.error, content: clip(content) } };
  return { ok: true, items: result.items, meta: result.meta, raw: content };
}

function notConfiguredMessage(reason) {
  if (reason === "disabled") return "AI 未启用：到「设置」里打开开关，或不用 AI 手动拆。";
  if (reason === "missing_or_invalid_baseUrl") return "还没填服务地址：设置里需要一个 http(s) 的 OpenAI 兼容地址。";
  return "还没填模型名。";
}

/** 兼容 content 是字符串 / 内容块数组 / 直接给 parsed 对象的服务。 */
function pickContent(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  const message = payload?.choices?.[0]?.message ?? payload?.choices?.[0]?.delta;
  if (!message) return null;
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) {
    return message.content.map((part) => part?.text ?? "").join("");
  }
  if (message.parsed && typeof message.parsed === "object") return JSON.stringify(message.parsed);
  return null;
}
