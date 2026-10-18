import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_ITEMS,
  SYSTEM_PROMPT,
  buildHeaders,
  buildMessages,
  buildRequestBody,
  buildUserPrompt,
  callLlm,
  configIssue,
  extractJsonObject,
  isConfigured,
  maskSecret,
  normalizeBaseUrl,
  parseDecomposition,
  previewRequest,
} from "../app/core/ai.js";

/* ------------------------------------------------------------------ 脚手架 */

const good = {
  enabled: true,
  baseUrl: "http://127.0.0.1:8931/v1",
  model: "mock-mini",
  apiKey: "sk-SECRET-0123456789",
  timeoutMs: 20000,
};

function nodeInput(extra = {}) {
  return {
    treeTitle: "学会 RAG",
    pathTitles: ["学会 RAG", "检索"],
    title: "怎么评估检索质量",
    note: "不知道从哪测起",
    existingChildTitles: ["标注 gold 数据"],
    ...extra,
  };
}

function openAiReply(content) {
  return { id: "x", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content } }] };
}

function responseOf(body, { status = 200, statusText = "OK" } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function recorder(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return typeof reply === "function" ? reply(url, init) : reply;
  };
  return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ 配置判定 */

test("configIssue：每种不可用状态都给得出原因，可用时给 null", () => {
  assert.equal(configIssue({ ...good, enabled: false }), "disabled");
  assert.equal(configIssue({ ...good, baseUrl: "" }), "missing_or_invalid_baseUrl");
  assert.equal(configIssue({ ...good, baseUrl: "javascript:alert(1)//" }), "missing_or_invalid_baseUrl");
  assert.equal(configIssue({ ...good, baseUrl: "不是地址" }), "missing_or_invalid_baseUrl");
  assert.equal(configIssue({ ...good, model: "  " }), "missing_model");
  assert.equal(configIssue(good), null);
  assert.equal(isConfigured(good), true);
  assert.equal(isConfigured(undefined), false);
});

test("normalizeBaseUrl：补齐 /v1、容忍尾斜杠、拒绝非 http(s)", () => {
  assert.equal(normalizeBaseUrl("http://h:1/v1"), "http://h:1/v1");
  assert.equal(normalizeBaseUrl("http://h:1/v1/"), "http://h:1/v1");
  assert.equal(normalizeBaseUrl("http://h:1"), "http://h:1/v1");
  assert.equal(normalizeBaseUrl("http://h:1/openai"), "http://h:1/openai/v1");
  assert.equal(normalizeBaseUrl("https://h/v1/chat/completions"), "https://h/v1/chat/completions");
  assert.equal(normalizeBaseUrl("file:///c:/x"), null);
  assert.equal(normalizeBaseUrl(""), null);
});

/* ------------------------------------------------------------------ Prompt */

test("buildUserPrompt：带上学过的路径、已有子问题与硬 schema", () => {
  const prompt = buildUserPrompt(nodeInput());
  assert.ok(prompt.includes("学习目标：学会 RAG"));
  assert.ok(prompt.includes("当前所处路径：学会 RAG › 检索"));
  assert.ok(prompt.includes("要拆解的问题：怎么评估检索质量"));
  assert.ok(prompt.includes("补充说明：不知道从哪测起"));
  assert.ok(prompt.includes("已经拆出来的子问题（不要重复）：标注 gold 数据"));
  assert.ok(prompt.includes('{"subproblems":[{"title":"字符串","hint":"字符串"}]}'));
  assert.equal(prompt.includes("sk-SECRET"), false, "prompt 里绝不能出现 key");
});

test("buildMessages：system 定调、user 带上下文；request body 是 OpenAI 兼容形状", () => {
  const messages = buildMessages(nodeInput());
  assert.deepEqual(messages.map((m) => m.role), ["system", "user"]);
  assert.equal(messages[0].content, SYSTEM_PROMPT);
  const body = buildRequestBody(good, nodeInput());
  assert.equal(body.model, "mock-mini");
  assert.equal(body.response_format.type, "json_object");
  assert.ok(body.temperature <= 1);
  assert.ok(body.max_tokens > 0);
  assert.deepEqual(body.messages, messages);
});

test("请求头：有 key 才发 Authorization；预览里 key 一律打码", () => {
  assert.equal(buildHeaders(good).Authorization, `Bearer ${good.apiKey}`);
  assert.equal("Authorization" in buildHeaders({ ...good, apiKey: "" }), false);
  const preview = previewRequest(good, nodeInput());
  assert.equal(preview.url, "http://127.0.0.1:8931/v1/chat/completions");
  assert.equal(preview.headers.Authorization.includes("sk-SECRET-0123456789"), false);
  assert.match(preview.headers.Authorization, /sk-S…6789/);
  assert.equal(JSON.stringify(preview).includes("sk-SECRET-0123456789"), false, "预览不能漏出完整 key");
  assert.equal(maskSecret("short"), "*****");
});

/* ------------------------------------------------------------------ JSON 抽取与解析 */

test("extractJsonObject：围栏、散文、字符串里的花括号都不骗人", () => {
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('好的，这是结果：\n{"a":{"b":[1,2]}}\n希望有用'), '{"a":{"b":[1,2]}}');
  assert.equal(extractJsonObject('{"note":"里面有 } 和 { 两个字符"}'), '{"note":"里面有 } 和 { 两个字符"}');
  assert.equal(extractJsonObject('{"broken": '), null);
  assert.equal(extractJsonObject("完全不是 JSON"), null);
});

const threeItems = {
  subproblems: [
    { title: "标注一批 gold 数据", hint: "先 30 条就够" },
    { title: "Recall@k 怎么算" },
    { title: "nDCG 与 MRR 的差别", hint: "" },
  ],
};

test("parseDecomposition：干净 JSON 直接成 3 条", () => {
  const result = parseDecomposition(JSON.stringify(threeItems));
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  assert.deepEqual(result.items[0], { title: "标注一批 gold 数据", hint: "先 30 条就够" });
  assert.equal(result.items[1].hint, "", "缺 hint 要补空串而不是 undefined");
  assert.equal(result.meta.truncated, false);
});

test("parseDecomposition：围栏与前后散文都能吃到", () => {
  const clean = JSON.stringify(threeItems);
  for (const dirty of [
    `\`\`\`json\n${clean}\n\`\`\``,
    `当然可以！以下是结果：\n${clean}\n还需要我解释吗？`,
    `\`\`\`\n${clean}\n\`\`\``,
  ]) {
    const result = parseDecomposition(dirty);
    assert.equal(result.ok, true, dirty.slice(0, 24));
    assert.equal(result.items.length, 3);
  }
});

test("parseDecomposition：subproblems / children / items 三种键名都认，并记下用了哪个", () => {
  for (const key of ["subproblems", "children", "items"]) {
    const result = parseDecomposition(JSON.stringify({ [key]: [{ title: `用 ${key} 传的` }] }));
    assert.equal(result.ok, true, key);
    assert.equal(result.meta.sourceKey, key);
    assert.equal(result.items[0].title, `用 ${key} 传的`);
  }
});

test("parseDecomposition：纯字符串数组也收（有些模型会省掉对象）", () => {
  const result = parseDecomposition(JSON.stringify({ subproblems: ["甲", "乙"] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.items, [
    { title: "甲", hint: "" },
    { title: "乙", hint: "" },
  ]);
});

test("parseDecomposition：JSON 坏掉 / 缺数组 → 结构化错误且带上原文", () => {
  const broken = parseDecomposition('{"subproblems": [ {title:');
  assert.equal(broken.ok, false);
  assert.equal(broken.error.code, "invalid_json");
  assert.ok(broken.error.raw.length > 0);

  const noArray = parseDecomposition(JSON.stringify({ answer: "我不会拆" }));
  assert.equal(noArray.ok, false);
  assert.match(noArray.error.message, /subproblems/);

  const notJson = parseDecomposition("抱歉，我需要更多信息。");
  assert.equal(notJson.ok, false);
  assert.equal(notJson.error.code, "invalid_json");
});

test("parseDecomposition：与已有子问题去重（大小写/空白/标点无关），全撞了就报 empty_result", () => {
  const result = parseDecomposition(
    JSON.stringify({
      subproblems: [
        { title: "标注 gold 数据" },
        { title: "  标注 gold 数据  " },
        { title: "标注-gold-数据！" },
      ],
    }),
    { existingTitles: ["标注 Gold 数据"] },
  );
  assert.equal(result.ok, false, "全是重复项时不能算成功");
  assert.equal(result.error.code, "empty_result");

  const partial = parseDecomposition(
    JSON.stringify({
      subproblems: [{ title: "标注 gold 数据" }, { title: "新的子问题" }],
    }),
    { existingTitles: ["标注 gold 数据"] },
  );
  assert.equal(partial.ok, true);
  assert.deepEqual(
    partial.items.map((item) => item.title),
    ["新的子问题"],
  );
  assert.equal(partial.meta.dropped, 1);
});

test("parseDecomposition：超过上限要截断并显式标 truncated，而不是偷偷少给", () => {
  const many = { subproblems: Array.from({ length: 14 }, (_, i) => ({ title: `子问题 ${i + 1}` })) };
  const result = parseDecomposition(JSON.stringify(many));
  assert.equal(result.ok, true);
  assert.equal(result.items.length, MAX_ITEMS);
  assert.equal(result.meta.truncated, true);
  assert.equal(result.meta.total, 14);
  const custom = parseDecomposition(JSON.stringify(many), { maxItems: 3 });
  assert.equal(custom.items.length, 3);
});

test("parseDecomposition：title 里的换行压成空格、超长截断，hint 也限长", () => {
  const result = parseDecomposition(
    JSON.stringify({ subproblems: [{ title: "第一行\n第二行\t带制表", hint: "x".repeat(400) }] }),
  );
  assert.equal(result.items[0].title, "第一行 第二行 带制表");
  assert.equal(result.items[0].hint.length, 200);
});

/* ------------------------------------------------------------------ callLlm */

test("callLlm：未启用时一个请求都不发，错误码是 not_configured", async () => {
  const { fetchImpl, calls } = recorder(responseOf(openAiReply("{}")));
  for (const config of [{ ...good, enabled: false }, { ...good, baseUrl: "" }, undefined]) {
    const result = await callLlm({ config, ...nodeInput(), fetchImpl });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "not_configured");
    assert.ok(result.error.message.length > 0, "要能告诉用户下一步做什么");
  }
  assert.deepEqual(calls, [], "禁用状态下不能有任何网络副作用");
});

test("callLlm：真走一次请求，URL / 头 / body 都对，回复被解析成子问题", async () => {
  const { fetchImpl, calls } = recorder(responseOf(openAiReply(JSON.stringify(threeItems))));
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 3);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://127.0.0.1:8931/v1/chat/completions");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${good.apiKey}`);
  assert.equal(calls[0].init.headers["Content-Type"], "application/json");
  assert.equal(calls[0].body.model, "mock-mini");
  assert.equal(calls[0].body.response_format.type, "json_object");
  assert.equal(calls[0].body.messages[1].content.includes("怎么评估检索质量"), true);
  assert.equal(typeof calls[0].init.signal, "object", "必须带 AbortSignal 以便超时");
});

test("callLlm：没有 key 就不发 Authorization 头", async () => {
  const { fetchImpl, calls } = recorder(responseOf(openAiReply(JSON.stringify(threeItems))));
  await callLlm({ config: { ...good, apiKey: "" }, ...nodeInput(), fetchImpl });
  assert.equal("Authorization" in calls[0].init.headers, false);
});

test("callLlm：HTTP 非 2xx → http_status 并保留原文片段", async () => {
  const { fetchImpl } = recorder(
    responseOf('{"error":{"message":"Invalid API key"}}', { status: 401, statusText: "Unauthorized" }),
  );
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "http_status");
  assert.equal(result.error.status, 401);
  assert.match(result.error.raw, /Invalid API key/);
});

test("callLlm：响应不是 OpenAI 形状 → invalid_response", async () => {
  const cases = [{ result: "ok" }, { choices: [] }, "不是 JSON"];
  for (const body of cases) {
    const { fetchImpl } = recorder(responseOf(body));
    const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
    assert.equal(result.ok, false, JSON.stringify(body));
    assert.equal(result.error.code, "invalid_response");
  }
});

test("callLlm：内容块数组形态（部分服务的 content 是数组）也能解析", async () => {
  const { fetchImpl } = recorder(
    responseOf({ choices: [{ message: { role: "assistant", content: [{ text: '{"subproblems":[{"title":"甲"}]}' }] } }] }),
  );
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.items[0].title, "甲");
});

test("callLlm：网络抛错 → network，不抛出到调用方", async () => {
  const fetchImpl = async () => {
    throw new TypeError("Failed to fetch");
  };
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "network");
  assert.match(result.error.message, /Failed to fetch/);
});

test("callLlm：设置里的 timeoutMs 真的被用上（回归：曾经只认调用方传的值）", async () => {
  const hang = (url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    });
  const started = Date.now();
  const result = await callLlm({ config: { ...good, timeoutMs: 40 }, ...nodeInput(), fetchImpl: hang });
  assert.equal(result.error.code, "timeout");
  assert.ok(Date.now() - started < 2000, "不该等满默认的 20s");
  const override = await callLlm({ config: { ...good, timeoutMs: 60000 }, ...nodeInput(), fetchImpl: hang, timeoutMs: 40 });
  assert.equal(override.error.code, "timeout", "调用方显式传参优先于设置");
});

test("callLlm：超时 → timeout，且 signal 真的被 abort", async () => {
  const signals = [];
  const fetchImpl = (url, init) => {
    signals.push(init.signal);
    return new Promise((resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl, timeoutMs: 20 });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "timeout");
  assert.equal(signals.length, 1);
  assert.equal(signals[0].aborted, true);
});

test("callLlm：模型返回空数组也不能算成功（§22-5 三态判定）", async () => {
  const { fetchImpl } = recorder(responseOf(openAiReply(JSON.stringify({ subproblems: [] }))));
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "empty_result");
  assert.ok(result.raw || result.error.content, "要留下原文供排查");
});

test("callLlm：与已有子问题全撞 → 明确报错，不是静默返回空", async () => {
  const { fetchImpl } = recorder(
    responseOf(openAiReply(JSON.stringify({ subproblems: [{ title: "标注 gold 数据" }] }))),
  );
  const result = await callLlm({ config: good, ...nodeInput(), fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "empty_result");
});
