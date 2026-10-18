/**
 * verify_mvp.py 用到的 Node 侧探针。每个子命令输出一行 JSON，异常退出码非 0。
 * 用法：node scripts/verify/probes.mjs <perf|http|degrade|roundtrip|xss> [参数...]
 */

import { addChild, createTree, signatureOf } from "../../app/core/tree.js";
import { layoutTree, renderTreeSvg } from "../../app/core/render.js";
import { callLlm, previewRequest } from "../../app/core/ai.js";
import {
  createMemoryBackend,
  buildExport,
  loadLibrary,
  mergeLibrary,
  parseExport,
  saveLibrary,
  emptyLibrary,
} from "../../app/core/storage.js";
import { sampleTrees } from "../../app/core/sample.js";

function seeded(seed) {
  let state = seed;
  return {
    rand: () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    },
    now: () => "2026-09-23T00:00:00.000Z",
  };
}

function bigTree(total, seed = 1) {
  const ctx = seeded(seed);
  const tree = createTree({ title: "压测树" }, ctx);
  const frontier = [tree.root];
  let made = 1;
  let round = 0;
  while (made < total) {
    const parent = frontier.shift();
    if (!parent) break;
    const width = round === 0 ? 4 : 3;
    for (let i = 0; i < width && made < total; i += 1) {
      const child = addChild(tree, parent.id, { title: `第 ${round} 层的问题 ${made}` }, ctx);
      frontier.push(child);
      made += 1;
    }
    frontier.push(parent);
    round += 1;
  }
  return tree;
}

/* ------------------------------------------------------------------ perf */

function probePerf() {
  const out = {};
  for (const size of [200, 500]) {
    const tree = bigTree(size, size);
    const started = performance.now();
    const layout = layoutTree(tree);
    const laidOut = performance.now();
    const svg = renderTreeSvg(layout, { selectedId: layout.nodes[0].id, matches: new Set() });
    const rendered = performance.now();
    out[`layout${size}`] = Math.round((laidOut - started) * 100) / 100;
    out[`render${size}`] = Math.round((rendered - laidOut) * 100) / 100;
    out[`nodes${size}`] = layout.nodes.length;
    out[`bytes${size}`] = svg.length;
    if (layout.nodes.length !== size) throw new Error(`${size} 节点树只布局出 ${layout.nodes.length} 个`);
  }
  return out;
}

/* ------------------------------------------------------------------ 真 HTTP 往返 */

async function probeHttp(baseUrl, expect, timeoutMs) {
  const ctx = seeded(3);
  const tree = sampleTrees(ctx)[0];
  const target = tree.root.children[1];
  const config = {
    enabled: true,
    baseUrl,
    model: "probe-model",
    apiKey: "sk-probe-123456",
    timeoutMs: Number(timeoutMs ?? 8000),
  };
  const args = {
    config,
    treeTitle: tree.title,
    pathTitles: [tree.title, target.title],
    title: target.title,
    note: target.note ?? "",
    existingChildTitles: target.children.map((child) => child.title),
    fetchImpl: (url, init) => fetch(url, init),
  };
  const started = performance.now();
  const result = await callLlm(args);
  const ms = Math.round(performance.now() - started);

  if (expect && expect !== "ok") {
    if (result.ok) throw new Error(`期望失败（${expect}），却成功了：${JSON.stringify(result.items)}`);
    if (result.error.code !== expect) {
      throw new Error(`期望错误码 ${expect}，实际 ${result.error.code}：${result.error.message}`);
    }
    return { ms, expected: expect, code: result.error.code, message: result.error.message };
  }
  if (!result.ok) throw new Error(`真 HTTP 调用失败：${result.error.code} ${result.error.message}`);
  if (result.items.length < 3) throw new Error(`只解析出 ${result.items.length} 条`);

  // 让假服务自己报告收到了什么，避免"客户端自以为发了"。
  const echo = await (await fetch(new URL("/last", baseUrl).href)).json();
  const last = echo.last ?? {};
  return {
    ms,
    items: result.items.length,
    firstTitle: result.items[0].title,
    authorizationSeen: last.authorization ?? null,
    responseFormatSeen: last.response_format ?? null,
    modelSeen: last.model ?? null,
    promptHasPath: String(last.prompt ?? "").includes("当前所处路径"),
    promptLeaksKey: String(last.prompt ?? "").includes("sk-probe-123456"),
  };
}

/* ------------------------------------------------------------------ AI 未配置降级 */

async function probeDegrade() {
  let called = 0;
  const fetchImpl = async () => {
    called += 1;
    throw new Error("不该发请求");
  };
  const cases = {
    disabled: { enabled: false, baseUrl: "http://127.0.0.1:1/v1", model: "m", apiKey: "" },
    noUrl: { enabled: true, baseUrl: "", model: "m", apiKey: "" },
    noModel: { enabled: true, baseUrl: "http://127.0.0.1:1/v1", model: "", apiKey: "" },
  };
  const out = {};
  for (const [name, config] of Object.entries(cases)) {
    const result = await callLlm({ config, treeTitle: "T", pathTitles: [], title: "问题", fetchImpl });
    out[name] = { ok: result.ok, code: result.error?.code ?? null, message: result.error?.message ?? "" };
  }
  const empty = emptyLibrary({ now: () => "2026-09-23T00:00:00.000Z" });
  const preview = previewRequest(empty.settings.llm, { treeTitle: "T", pathTitles: [], title: "x" });
  return { ...out, fetchCalls: called, previewUrl: preview.url, previewHasKeyField: "Authorization" in preview.headers };
}

/* ------------------------------------------------------------------ 导出/导入往返 */

function probeRoundtrip() {
  const ctx = seeded(9);
  const trees = sampleTrees(ctx);
  const library = {
    schemaVersion: 1,
    trees,
    activeTreeId: trees[0].id,
    settings: { llm: { enabled: true, baseUrl: "http://x/v1", model: "m", apiKey: "sk-live-abcdef0123456789", timeoutMs: 1000 }, ui: { showAiBadge: true } },
    createdAt: "2026-09-23T00:00:00.000Z",
  };
  const backend = createMemoryBackend();
  const saved = saveLibrary(library, backend);
  if (!saved.ok) throw new Error(`保存失败：${saved.error?.message}`);
  const loaded = loadLibrary(backend, {});
  if (!loaded.ok) throw new Error(`读取失败：${loaded.error?.message}`);

  const dump = buildExport(library, { now: "2026-09-23T10:00:00.000Z" });
  if (dump.text.includes("sk-live-abcdef0123456789")) throw new Error("默认导出漏出了密钥");
  const parsed = parseExport(dump.text);
  if (!parsed.ok) throw new Error(`导入被拒：${JSON.stringify(parsed.errors)}`);
  const merged = mergeLibrary(emptyLibrary({}), parsed.library, { ctx: seeded(11) });
  if (!merged.ok) throw new Error(`合并失败：${JSON.stringify(merged.errors)}`);

  const before = library.trees.map((tree) => signatureOf(tree));
  const after = merged.library.trees.map((tree) => signatureOf(tree));
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("导出导入后内容指纹不一致");
  }
  const foreign = parseExport(JSON.stringify({ app: "other", schemaVersion: 1, exportedAt: "x", library: { schemaVersion: 1, trees: [] } }));
  return {
    trees: before.length,
    nodes: trees.reduce((sum, tree) => sum + signatureOf(tree).split("\n").length, 0),
    collapsedPreserved: merged.library.trees[0].collapsed.length,
    keyInExport: dump.carriesSecret,
    keyRestoredOnImport: parsed.carriesSecret,
    activeKept: merged.library.activeTreeId === trees[0].id,
    rejectsForeignApp: !foreign.ok,
    bytes: dump.text.length,
  };
}

/* ------------------------------------------------------------------ XSS 输出面 */

async function probeXss(rootDir) {
  const { readFileSync } = await import("node:fs");
  const ctx = seeded(13);
  const tree = createTree({ title: `<svg onload=alert(3)>` }, ctx);
  const evil = addChild(tree, tree.root.id, { title: `<img src=x onerror=alert(1)>`, hint: `"onmouseover="alert(2)` }, ctx);
  addChild(tree, evil.id, { title: `</text><script>alert(4)</script>` }, ctx);
  addChild(tree, tree.root.id, { title: `'; drop table; --`, note: `<a href="javascript:alert(5)">x</a>` }, ctx);
  const svg = renderTreeSvg(layoutTree(tree), { selectedId: evil.id, matches: new Set([tree.root.id]) });
  const offenders = (svg.match(/<([a-zA-Z][\w:-]*)/g) ?? [])
    .map((tag) => tag.slice(1))
    .filter((name) => !["svg", "g", "rect", "path", "text", "title"].includes(name));
  const uiSource = readFileSync(new URL("../../app/ui/app.js", import.meta.url), "utf8");
  const innerHtmlLines = uiSource
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /\.innerHTML\s*=[^=]/.test(line));
  return {
    offenders,
    rawImg: svg.includes("<img"),
    rawScript: svg.includes("<script"),
    innerHtmlUses: innerHtmlLines.length,
    innerHtmlAnnotated: innerHtmlLines.filter((line) => line.includes("innerHTML-ok")).length,
    escapedVisible: svg.includes("&lt;img src=x o"),
  };
}

/* ------------------------------------------------------------------ 入口 */

const [name, ...rest] = process.argv.slice(2);
const runners = {
  perf: async () => probePerf(),
  http: async () => probeHttp(rest[0], rest[1], rest[2]),
  degrade: async () => probeDegrade(),
  roundtrip: async () => probeRoundtrip(),
  xss: async () => probeXss(rest[0]),
};

const runner = runners[name];
if (!runner) {
  console.error(`未知探针：${name}`);
  process.exit(2);
}
try {
  const payload = await runner();
  process.stdout.write(JSON.stringify({ ok: true, ...(payload ?? {}) }) + "\n");
} catch (cause) {
  process.stdout.write(JSON.stringify({ ok: false, error: `${cause?.message ?? cause}` }) + "\n");
  process.exit(1);
}
