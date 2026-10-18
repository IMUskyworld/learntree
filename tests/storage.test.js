import { test } from "node:test";
import assert from "node:assert/strict";

import { addChild, createTree, signatureOf } from "../app/core/tree.js";
import { sampleTrees } from "../app/core/sample.js";
import {
  APP_ID,
  LIBRARY_KEY,
  SCHEMA_VERSION,
  buildExport,
  browserBackend,
  createMemoryBackend,
  defaultSettings,
  emptyLibrary,
  exportFilename,
  loadLibrary,
  mergeLibrary,
  normalizeLibrary,
  parseExport,
  saveLibrary,
  stripSecrets,
  validateLibrary,
} from "../app/core/storage.js";

function ctx(seed = 21) {
  let state = seed;
  return {
    rand: () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    },
    now: () => "2026-09-23T00:00:00.000Z",
  };
}

function libraryWithTrees(count = 2) {
  const context = ctx();
  const trees = sampleTrees(context).slice(0, count);
  return {
    schemaVersion: SCHEMA_VERSION,
    trees,
    activeTreeId: trees[0].id,
    settings: {
      llm: { enabled: true, baseUrl: "http://127.0.0.1:8931/v1", model: "mock", apiKey: "sk-LIVE-abcdef123456", timeoutMs: 5000 },
      ui: { showAiBadge: false },
    },
    createdAt: "2026-09-23T00:00:00.000Z",
  };
}

/* ------------------------------------------------------------------ 往返 */

test("空库形状：零棵树、AI 默认关闭、没有 key", () => {
  const lib = emptyLibrary(ctx());
  assert.deepEqual(lib.trees, []);
  assert.equal(lib.activeTreeId, null);
  assert.equal(lib.settings.llm.enabled, false, "默认必须不发任何网络请求");
  assert.equal(lib.settings.llm.apiKey, "");
  assert.deepEqual(validateLibrary(lib), { ok: true, errors: [] });
  assert.deepEqual(defaultSettings().llm, { enabled: false, baseUrl: "", model: "", apiKey: "", timeoutMs: 20000 });
});

test("saveLibrary → loadLibrary：树、状态、折叠、设置逐项保真", () => {
  const backend = createMemoryBackend();
  const source = libraryWithTrees(3);
  assert.equal(saveLibrary(source, backend).ok, true);
  assert.ok(backend.data.has(LIBRARY_KEY), "必须落在约定的键上");
  const loaded = loadLibrary(backend, ctx());
  assert.equal(loaded.ok, true);
  assert.equal(loaded.library.trees.length, 3);
  assert.equal(loaded.library.activeTreeId, source.activeTreeId);
  assert.equal(loaded.library.settings.llm.apiKey, "sk-LIVE-abcdef123456", "本地读写要带 key（导出才剥）");
  assert.equal(loaded.library.settings.ui.showAiBadge, false);
  assert.deepEqual(
    loaded.library.trees.map((tree) => signatureOf(tree)),
    source.trees.map((tree) => signatureOf(tree)),
  );
});

test("loadLibrary：第一次没有数据时给空库并标记 created", () => {
  const result = loadLibrary(createMemoryBackend(), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
  assert.deepEqual(result.library.trees, []);
});

/* ------------------------------------------------------------------ 坏数据必须被拒绝且不覆盖 */

test("loadLibrary：JSON 语法坏了 → 报错、给空库、且绝不回写覆盖原文", () => {
  const backend = createMemoryBackend({ [LIBRARY_KEY]: "{ this is not json" });
  const before = backend.getItem(LIBRARY_KEY);
  const result = loadLibrary(backend, ctx());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "corrupt_json");
  assert.equal(result.preserved, true);
  assert.deepEqual(result.library.trees, [], "界面还能开工，但不能假装数据没坏");
  assert.equal(backend.getItem(LIBRARY_KEY), before, "原内容必须一动不动");
});

test("loadLibrary：结构不合法（status 非法 / trees 不是数组 / 树 id 重复）", () => {
  const cases = [
    { schemaVersion: 1, trees: "nope", activeTreeId: null, settings: defaultSettings() },
    {
      schemaVersion: 1,
      trees: [{ schemaVersion: 1, id: "t_a", title: "T", root: { id: "n_r", title: "r", status: "wip", children: [] }, collapsed: [] }],
      activeTreeId: "t_a",
      settings: defaultSettings(),
    },
    {
      schemaVersion: 1,
      trees: [
        { schemaVersion: 1, id: "t_same", title: "甲", root: { id: "n_1", title: "r", status: "todo", children: [] }, collapsed: [] },
        { schemaVersion: 1, id: "t_same", title: "乙", root: { id: "n_2", title: "r", status: "todo", children: [] }, collapsed: [] },
      ],
      activeTreeId: null,
      settings: defaultSettings(),
    },
    { schemaVersion: 1, trees: [], activeTreeId: 42, settings: defaultSettings() },
    { schemaVersion: 1, trees: [], activeTreeId: null, settings: { llm: { apiKey: 7 } } },
  ];
  for (const value of cases) {
    const backend = createMemoryBackend({ [LIBRARY_KEY]: JSON.stringify(value) });
    const result = loadLibrary(backend, ctx());
    assert.equal(result.ok, false, JSON.stringify(value).slice(0, 60));
    assert.equal(result.error.code, "invalid_library");
    assert.ok(result.errors.length > 0 && result.errors.every((error) => error.path));
    assert.equal(backend.getItem(LIBRARY_KEY), JSON.stringify(value), "坏数据不能被顺手清掉");
  }
});

test("loadLibrary：来自更新版本的库 → too_new，且不当空库悄悄开工", () => {
  const future = { ...libraryWithTrees(1), schemaVersion: SCHEMA_VERSION + 1 };
  const backend = createMemoryBackend({ [LIBRARY_KEY]: JSON.stringify(future) });
  const result = loadLibrary(backend, ctx());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "too_new");
  assert.match(result.error.message, /升级/);
});

test("loadLibrary：读 / 写后端本身抛异常时的降级", () => {
  const broken = {
    getItem: () => {
      throw new Error("SecurityError");
    },
    setItem: () => true,
    removeItem: () => true,
  };
  const result = loadLibrary(broken, ctx());
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "unreadable");
  assert.match(result.error.message, /SecurityError/);
  assert.equal(loadLibrary(null, ctx()).error.code, "no_backend");
});

test("saveLibrary：不合法的库拒写；配额爆了给可操作的提示", () => {
  const backend = createMemoryBackend();
  const bad = { ...libraryWithTrees(1), trees: [{ id: "t_x" }] };
  const before = backend.data.size;
  const result = saveLibrary(bad, backend);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "invalid_library");
  assert.equal(backend.data.size, before, "拒写就是什么都不写");

  const quota = createMemoryBackend();
  quota.setItem = () => {
    const err = new Error("exceeded the quota");
    err.name = "QuotaExceededError";
    throw err;
  };
  const saved = saveLibrary(libraryWithTrees(1), quota);
  assert.equal(saved.ok, false);
  assert.equal(saved.error.code, "quota_exceeded");
  assert.match(saved.error.message, /导出备份/);
});

test("browserBackend：探不到写能力的存储一律当没有", () => {
  assert.equal(browserBackend(null), null);
  assert.equal(
    browserBackend({
      getItem: () => null,
      setItem: () => {
        throw new Error("disabled");
      },
      removeItem: () => null,
    }),
    null,
  );
  const ok = { getItem: () => null, setItem: () => null, removeItem: () => null };
  assert.equal(typeof browserBackend(ok).setItem, "function");
});

/* ------------------------------------------------------------------ 导出 / 导入 */

test("buildExport：自描述头齐全，默认剥掉 apiKey", () => {
  const source = libraryWithTrees(3);
  const { text, filename, carriesSecret } = buildExport(source, { now: "2026-09-23T08:00:00.000Z" });
  assert.equal(carriesSecret, false);
  assert.equal(filename, "learntree-export-2026-09-23.json");
  assert.equal(exportFilename("2026-01-02T00:00:00.000Z"), "learntree-export-2026-01-02.json");
  assert.equal(exportFilename(new Date(2026, 0, 2, 23, 59)), "learntree-export-2026-01-02.json");
  const payload = JSON.parse(text);
  assert.deepEqual(
    { app: payload.app, schemaVersion: payload.schemaVersion, exportedAt: payload.exportedAt, treeCount: payload.treeCount },
    { app: APP_ID, schemaVersion: SCHEMA_VERSION, exportedAt: "2026-09-23T08:00:00.000Z", treeCount: 3 },
  );
  assert.equal(text.includes("sk-LIVE-abcdef123456"), false, "默认导出绝不能带 key");
  assert.equal(payload.library.settings.llm.baseUrl, "http://127.0.0.1:8931/v1", "地址和模型要留着，换机才好接");
});

test("导出文件名用本地日历日，不用 UTC（东八区凌晨导出的回归）", () => {
  const localMidnight = new Date(2026, 8, 23, 0, 30);
  const { filename, text } = buildExport(libraryWithTrees(1), { now: localMidnight.getTime() });
  assert.equal(filename, "learntree-export-2026-09-23.json");
  assert.ok(text.includes(localMidnight.toISOString()), "内容里的时间戳仍按 ISO/UTC 存");
});

test("buildExport：显式带 key 时 carriesSecret 必须为真（界面要警告）", () => {
  const { text, carriesSecret } = buildExport(libraryWithTrees(1), { includeSecrets: true, now: "2026-09-23T08:00:00.000Z" });
  assert.equal(carriesSecret, true);
  assert.ok(text.includes("sk-LIVE-abcdef123456"));
});

test("stripSecrets 不改原对象", () => {
  const source = libraryWithTrees(1);
  const stripped = stripSecrets(source);
  assert.equal(stripped.settings.llm.apiKey, "");
  assert.equal(source.settings.llm.apiKey, "sk-LIVE-abcdef123456");
});

test("parseExport：缺 app / 版本 / 时间戳 / library 一律拒绝，不猜", () => {
  const good = JSON.parse(buildExport(libraryWithTrees(2), { now: "2026-09-23T08:00:00.000Z" }).text);
  assert.equal(parseExport(JSON.stringify(good)).ok, true);

  const cases = [
    [{ ...good, app: "someone-else" }, "app"],
    [{ ...good, schemaVersion: 99 }, "schemaVersion"],
    [{ ...good, exportedAt: undefined }, "exportedAt"],
    [{ ...good, library: undefined }, "library"],
    [{ ...good, library: { ...good.library, trees: "nope" } }, "library.trees"],
  ];
  for (const [value, expectedPath] of cases) {
    const result = parseExport(JSON.stringify(value));
    assert.equal(result.ok, false, JSON.stringify(value).slice(0, 50));
    assert.ok(
      result.errors.some((error) => error.path === expectedPath),
      `期望 path=${expectedPath}，实际 ${JSON.stringify(result.errors)}`,
    );
  }
  assert.equal(parseExport("{{{").ok, false);
  assert.match(parseExport("").errors[0].message, /合法 JSON/);
});

test("parseExport：带 key 的文件要报告 carriesSecret，但仍能导入", () => {
  const text = buildExport(libraryWithTrees(1), { includeSecrets: true, now: "2026-09-23T08:00:00.000Z" }).text;
  const result = parseExport(text);
  assert.equal(result.ok, true);
  assert.equal(result.carriesSecret, true);
  assert.equal(result.meta.treeCount, 1);
});

test("导出 → 导入 → 与原始库内容等价（忽略时间戳与导出头）", () => {
  const source = libraryWithTrees(3);
  const { text } = buildExport(source, { now: "2026-09-23T08:00:00.000Z" });
  const back = parseExport(text);
  assert.equal(back.ok, true);
  assert.deepEqual(
    back.library.trees.map((tree) => signatureOf(tree)),
    source.trees.map((tree) => signatureOf(tree)),
  );
  assert.deepEqual(
    back.library.trees.map((tree) => tree.collapsed),
    source.trees.map((tree) => tree.collapsed),
  );
  assert.equal(back.library.settings.ui.showAiBadge, false);
});

/* ------------------------------------------------------------------ 合并 */

test("mergeLibrary(merge)：追加到当前库后面，树 id 冲突时重发并记录", () => {
  const context = ctx();
  const target = emptyLibrary(context);
  const [incoming] = sampleTrees(context);
  const clash = { ...incoming, id: incoming.id };
  const first = mergeLibrary(target, { ...clash, trees: [clash] }, { ctx: context });
  assert.equal(first.ok, true);
  assert.equal(first.report.added, 1);
  assert.equal(first.library.trees[0].id, clash.id, "空库里不需要改名");

  const second = mergeLibrary(first.library, { trees: [clash], settings: first.library.settings }, { ctx: context });
  assert.equal(second.ok, true);
  assert.equal(second.report.renamed.length, 1);
  assert.notEqual(second.report.renamed[0].to, clash.id);
  assert.equal(second.library.trees.length, 2);
  assert.equal(new Set(second.library.trees.map((tree) => tree.id)).size, 2);
  assert.deepEqual(validateLibrary(second.library), { ok: true, errors: [] });
});

test("mergeLibrary(replace)：整库换掉，但要报告被替换了几棵", () => {
  const context = ctx();
  const target = mergeLibrary(emptyLibrary(context), { trees: sampleTrees(context).slice(0, 2) }, { ctx: context }).library;
  const incoming = { trees: sampleTrees(context).slice(2, 3) };
  const result = mergeLibrary(target, incoming, { mode: "replace", ctx: context });
  assert.equal(result.ok, true);
  assert.equal(result.report.replaced, 2);
  assert.equal(result.library.trees.length, 1);
});

test("mergeLibrary：同一批导入里自相冲突的树 id 会被逐个重发，不会静默覆盖", () => {
  const context = ctx();
  const target = mergeLibrary(emptyLibrary(context), { trees: sampleTrees(context).slice(0, 1) }, { ctx: context }).library;
  const twin = { ...target.trees[0] };
  const result = mergeLibrary(target, { trees: [{ ...twin }, { ...twin }] }, { ctx: context });
  assert.equal(result.ok, true);
  assert.equal(result.report.renamed.length, 2, "两棵都跟已有树撞 id，都要重发");
  const ids = result.library.trees.map((tree) => tree.id);
  assert.equal(new Set(ids).size, 3, "重发之后必须互不相同");
});

test("mergeLibrary：合并结果若不合法就整批拒绝，原库不动", () => {
  const context = ctx();
  const target = mergeLibrary(emptyLibrary(context), { trees: sampleTrees(context).slice(0, 1) }, { ctx: context }).library;
  const brokenTree = JSON.parse(JSON.stringify(target.trees[0]));
  brokenTree.root.children = [{ id: "n_bad", title: "坏状态", status: "wip", children: [] }];
  const result = mergeLibrary(target, { trees: [brokenTree] }, { ctx: context });
  assert.equal(result.ok, false, "非法 status 必须拦下");
  assert.equal(result.library, target, "拒绝时不能留下半个库");
  assert.match(result.errors[0].message, /status 非法/);
});

test("normalizeLibrary：缺字段补默认，多余字段不带进内存", () => {
  const normalized = normalizeLibrary({
    schemaVersion: SCHEMA_VERSION,
    trees: [{ schemaVersion: 1, id: "t_a", title: "T", createdAt: "x", updatedAt: "y", collapsed: ["n_r", 3], root: { id: "n_r", title: "T", status: "todo", note: "", source: "user", hint: "", children: [] } }],
    activeTreeId: "t_a",
    settings: { llm: { baseUrl: "http://h/v1" } },
    junk: true,
  });
  assert.equal("junk" in normalized, false);
  assert.equal(normalized.settings.llm.enabled, false, "缺失项补默认");
  assert.equal(normalized.settings.llm.baseUrl, "http://h/v1");
  assert.deepEqual(normalized.trees[0].collapsed, ["n_r"]);
});

test("合并后仍能读写落盘", () => {
  const context = ctx();
  const backend = createMemoryBackend();
  const base = mergeLibrary(emptyLibrary(context), { trees: sampleTrees(context).slice(0, 2) }, { ctx: context }).library;
  assert.equal(saveLibrary(base, backend).ok, true);
  const more = mergeLibrary(
    loadLibrary(backend, context).library,
    { trees: sampleTrees(context).slice(2, 3) },
    { ctx: context },
  ).library;
  assert.equal(saveLibrary(more, backend).ok, true);
  const again = loadLibrary(backend, context);
  assert.equal(again.ok, true);
  assert.equal(again.library.trees.length, 3);
  const tree = again.library.trees[0];
  assert.ok(addChild(again.library.trees[0], tree.root.id, { title: "再挂一个" }, context));
});
