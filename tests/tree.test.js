import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addChild,
  appendChildren,
  cloneTree,
  countDescendants,
  countNodes,
  createNode,
  createTree,
  findInconsistencies,
  findNode,
  findParent,
  isCollapsed,
  leafCount,
  moveNode,
  parseTree,
  pathTitles,
  pathTo,
  progressOf,
  removeNode,
  serializeTree,
  setNote,
  setStatus,
  setTitle,
  setTreeTitle,
  subtreeProgress,
  toggleCollapsed,
  truncate,
  validateTree,
  SCHEMA_VERSION,
} from "../app/core/tree.js";
import { primarySampleTree, sampleTrees } from "../app/core/sample.js";

/* ------------------------------------------------------------------ 测试脚手架 */

function ctx(seed = 7) {
  let state = seed;
  return {
    rand: () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    },
    now: () => "2026-09-23T00:00:00.000Z",
  };
}

/**
 * 一棵用来做各种断言的树：
 * root
 *  ├─ A(done)
 *  │   ├─ A1(done)
 *  │   └─ A2(todo)
 *  ├─ B(doing)
 *  │   └─ B1(done)
 *  └─ C(todo)
 */
function fixture() {
  const context = ctx();
  const tree = createTree({ title: "学 RAG" }, context);
  const a = addChild(tree, tree.root.id, { title: "A", status: "done" }, context);
  const a1 = addChild(tree, a.id, { title: "A1", status: "done" }, context);
  const a2 = addChild(tree, a.id, { title: "A2" }, context);
  const b = addChild(tree, tree.root.id, { title: "B", status: "doing" }, context);
  const b1 = addChild(tree, b.id, { title: "B1", status: "done" }, context);
  const c = addChild(tree, tree.root.id, { title: "C" }, context);
  return { tree, context, a, a1, a2, b, b1, c };
}

/* ------------------------------------------------------------------ 构造 */

test("createTree：根节点标题继承树名，schemaVersion 与时间戳齐全", () => {
  const tree = createTree({ title: "  学  RAG  " }, ctx());
  assert.equal(tree.schemaVersion, SCHEMA_VERSION);
  assert.equal(tree.title, "学 RAG", "标题里的连续空白应被压平");
  assert.equal(tree.root.title, "学 RAG");
  assert.equal(tree.root.children.length, 0);
  assert.deepEqual(tree.collapsed, []);
  assert.equal(tree.createdAt, "2026-09-23T00:00:00.000Z");
  assert.equal(tree.updatedAt, tree.createdAt);
  assert.match(tree.id, /^t_[a-z0-9]{6}$/);
});

test("createTree：可显式给出根的子树与备注", () => {
  const tree = createTree(
    {
      title: "T",
      root: { note: "目标说明", children: [{ title: "子", status: "done" }] },
    },
    ctx(),
  );
  assert.equal(tree.root.note, "目标说明");
  assert.equal(tree.root.children.length, 1);
  assert.equal(tree.root.children[0].status, "done");
});

test("createNode：拒绝空标题、非法状态、非法来源", () => {
  assert.throws(() => createNode({ title: "   " }), /标题不能为空/);
  assert.throws(() => createNode({ title: "ok", status: "finished" }), /非法状态/);
  assert.throws(() => createNode({ title: "ok", source: "gpt" }), /非法来源/);
});

test("createNode：title 超长截到 200 字，未知字段被丢弃", () => {
  const node = createNode({ title: "x".repeat(300), bogus: 1 });
  assert.equal(node.title.length, 200);
  assert.equal("bogus" in node, false);
  assert.deepEqual(Object.keys(node).sort(), ["children", "hint", "id", "note", "source", "status", "title"]);
});

test("同一 ctx 下 id 稳定可复现，不同 ctx 之间不碰撞", () => {
  const one = createTree({ title: "T" }, ctx(11));
  const two = createTree({ title: "T" }, ctx(11));
  assert.equal(one.root.id, two.root.id);
  const three = createTree({ title: "T" }, ctx(99));
  assert.notEqual(one.root.id, three.root.id);
});

/* ------------------------------------------------------------------ 增删改查 */

test("addChild / findNode / findParent / pathTo / pathTitles 一致", () => {
  const { tree, a, a2 } = fixture();
  assert.equal(findNode(tree, a2.id).title, "A2");
  assert.equal(findParent(tree, a2.id).id, a.id);
  assert.equal(findParent(tree, tree.root.id), null);
  assert.deepEqual(
    pathTo(tree, a2.id).map((node) => node.title),
    ["学 RAG", "A", "A2"],
  );
  assert.deepEqual(pathTitles(tree, a2.id), ["学 RAG", "A"], "pathTitles 默认不含自身");
  assert.deepEqual(pathTitles(tree, a2.id, true), ["学 RAG", "A", "A2"]);
  assert.equal(findNode(tree, "n_不存在"), null);
  assert.deepEqual(pathTo(tree, "n_不存在"), []);
});

test("addChild：找不到父节点要抛错，而不是静默挂到根上", () => {
  const { tree } = fixture();
  assert.throws(() => addChild(tree, "n_ghost", { title: "X" }), /找不到父节点/);
  assert.equal(countNodes(tree), 7);
});

test("appendChildren：默认标成 AI 来源，可显式覆盖", () => {
  const { tree, context, c } = fixture();
  const created = appendChildren(tree, c.id, [{ title: "一" }, { title: "二", source: "user" }], context);
  assert.equal(created.length, 2);
  assert.equal(findNode(tree, created[0].id).source, "ai");
  assert.equal(findNode(tree, created[1].id).source, "user");
});

test("removeNode：返回被删子树规模，删除后整条支线消失", () => {
  const { tree, a, a1, a2 } = fixture();
  const { removed, count } = removeNode(tree, a.id);
  assert.equal(removed.title, "A");
  assert.equal(count, 3, "A + A1 + A2");
  assert.equal(findNode(tree, a.id), null);
  assert.equal(findNode(tree, a1.id), null);
  assert.equal(findNode(tree, a2.id), null);
  assert.equal(countNodes(tree), 4);
});

test("removeNode：根节点不可删，未知 id 抛错", () => {
  const { tree } = fixture();
  assert.throws(() => removeNode(tree, tree.root.id), /不能删除根节点/);
  assert.throws(() => removeNode(tree, "n_ghost"), /找不到节点/);
  assert.equal(countNodes(tree), 7, "失败的删除不能改动树");
});

test("setStatus / setTitle / setNote / setTreeTitle 会推进 updatedAt 并校验入参", () => {
  const { tree, c } = fixture();
  tree.updatedAt = "2000-01-01T00:00:00.000Z";
  setStatus(tree, c.id, "done");
  assert.notEqual(tree.updatedAt, "2000-01-01T00:00:00.000Z", "变更必须刷新 updatedAt");
  assert.equal(findNode(tree, c.id).status, "done");
  assert.throws(() => setStatus(tree, c.id, "wip"), /非法状态/);
  setTitle(tree, c.id, "  改过的标题  ");
  assert.equal(findNode(tree, c.id).title, "改过的标题");
  assert.throws(() => setTitle(tree, c.id, "  "), /标题不能为空/);
  setNote(tree, c.id, " 备注 ");
  assert.equal(findNode(tree, c.id).note, "备注");
  setTreeTitle(tree, "新树名");
  assert.equal(tree.title, "新树名");
  assert.equal(tree.root.title, "学 RAG", "改树名不该连带改根节点标题");
});

test("moveNode：换父节点后路径正确，同层顺序保持插入序", () => {
  const { tree, a, b, a2 } = fixture();
  moveNode(tree, a2.id, b.id);
  assert.equal(findParent(tree, a2.id).id, b.id);
  assert.deepEqual(
    pathTo(tree, a2.id).map((node) => node.title),
    ["学 RAG", "B", "A2"],
  );
  assert.equal(a.children.length, 1);
});

test("moveNode：禁止移进自己的子树 / 移到自己 / 移动根 / 未知目标", () => {
  const { tree, a, a1, b } = fixture();
  assert.throws(() => moveNode(tree, a.id, a1.id), /自己的子树/);
  assert.throws(() => moveNode(tree, a.id, a.id), /自己下面/);
  assert.throws(() => moveNode(tree, tree.root.id, b.id), /根节点/);
  assert.throws(() => moveNode(tree, a.id, "n_ghost"), /找不到新父节点/);
  assert.equal(findParent(tree, a1.id).id, a.id, "失败的移动不能改结构");
  assert.equal(countNodes(tree), 7);
});

test("折叠：toggle 双态，isCollapsed 与数组一致，重复 id 不进去", () => {
  const { tree, a } = fixture();
  assert.equal(toggleCollapsed(tree, a.id), true);
  assert.equal(isCollapsed(tree, a.id), true);
  assert.deepEqual(tree.collapsed, [a.id]);
  assert.equal(toggleCollapsed(tree, a.id), false);
  assert.deepEqual(tree.collapsed, []);
  const seeded = createTree({ title: "T", collapsed: ["x", "x", 1, "y"] }, ctx());
  assert.deepEqual(seeded.collapsed, ["x", "y"], "构造时去重并丢弃非字符串");
});

/* ------------------------------------------------------------------ 计数与进度（§8.4） */

test("leafCount / countNodes / countDescendants 各自口径", () => {
  const { tree, a, b } = fixture();
  assert.equal(countNodes(tree), 7);
  assert.equal(leafCount(tree.root), 4, "叶子 = A1 / A2 / B1 / C");
  assert.equal(leafCount(a), 2);
  assert.equal(leafCount(b), 1, "B 只有一个孩子 B1，所以整棵子树只有 1 个叶子");
  assert.equal(countDescendants(a), 2);
  assert.equal(countDescendants(b), 1);
});

test("progressOf 按叶子算：只有根时 total=1", () => {
  const lone = createTree({ title: "只有一个问题" }, ctx());
  assert.deepEqual(progressOf(lone), { done: 0, total: 1, ratio: 0 });
  setStatus(lone, lone.root.id, "done");
  assert.deepEqual(progressOf(lone), { done: 1, total: 1, ratio: 1 });
});

test("progressOf：中间节点 done 不虚增进度", () => {
  const { tree } = fixture();
  // 叶子：A1 done, A2 todo, B1 done, C todo → 2/4，A 自己的 done 不参与计数
  assert.deepEqual(progressOf(tree), { done: 2, total: 4, ratio: 0.5 });
});

test("findInconsistencies：父 done 而子未完成只报警，不改写数据", () => {
  const { tree, a, a2 } = fixture();
  const problems = findInconsistencies(tree);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].id, a.id);
  assert.equal(problems[0].title, "A");
  assert.equal(problems[0].pendingCount, 1, "A 的子树里只有 A2 未 done");
  assert.equal(findNode(tree, a.id).status, "done", "报告不该顺手改数据");
  setStatus(tree, a2.id, "done");
  assert.deepEqual(findInconsistencies(tree), []);
  assert.deepEqual(progressOf(tree), { done: 3, total: 4, ratio: 0.75 });
});

test("findInconsistencies：全 done 的树无警告", () => {
  const context = ctx();
  const tree = createTree({ title: "T" }, context);
  const parent = addChild(tree, tree.root.id, { title: "P" }, context);
  addChild(tree, parent.id, { title: "C", status: "done" }, context);
  setStatus(tree, parent.id, "done");
  assert.deepEqual(findInconsistencies(tree), []);
  assert.deepEqual(progressOf(tree), { done: 1, total: 1, ratio: 1 });
});

test("subtreeProgress 与 progressOf 口径一致", () => {
  const { tree, b } = fixture();
  assert.deepEqual(subtreeProgress(b), { done: 1, total: 1, ratio: 1 }, "B 只有一个叶子 B1");
  assert.deepEqual(subtreeProgress(findNode(tree, tree.root.id)), progressOf(tree));
});

/* ------------------------------------------------------------------ 序列化 / 校验（§8） */

test("serializeTree → parseTree 往返保持结构与内容", () => {
  const { tree, a, c } = fixture();
  toggleCollapsed(tree, a.id);
  setNote(tree, c.id, "备注");
  const text = serializeTree(tree);
  const back = parseTree(JSON.parse(text));
  assert.equal(back.ok, true);
  assert.equal(back.tree.collapsed[0], a.id);
  assert.equal(findNode(back.tree, c.id).note, "备注");
  assert.equal(progressOf(back.tree).total, 4);
});

test("validateTree 对每种非法输入给出带 path 的结构化错误", () => {
  const cases = [
    [{}, "schemaVersion"],
    [
      { schemaVersion: 2, id: "t_a", title: "T", root: { id: "n_r", title: "r", status: "todo", children: [] } },
      "schemaVersion",
    ],
    [{ schemaVersion: 1, id: "", title: "  ", root: null }, "id"],
    [{ schemaVersion: 1, id: "t_a", title: "T" }, "root"],
  ];
  for (const [value, expectedPath] of cases) {
    const result = validateTree(value);
    assert.equal(result.ok, false, JSON.stringify(value));
    assert.ok(
      result.errors.some((error) => error.path === expectedPath),
      `期望错误里含 path=${expectedPath}，实际：${JSON.stringify(result.errors)}`,
    );
    assert.ok(result.errors.every((error) => typeof error.path === "string" && error.message));
  }
  assert.deepEqual(validateTree(null), { ok: false, errors: [{ path: "", message: "树必须是对象" }] });
});

test("validateTree：非法 status、重复 id、children 非数组都能定位到 path", () => {
  const parsed = parseTree({
    schemaVersion: 1,
    id: "t_aaaaaa",
    title: "T",
    root: {
      id: "n_root",
      title: "root",
      status: "todo",
      children: [
        { id: "n_dup", title: "甲", status: "wip", children: [] },
        { id: "n_dup", title: "", status: "todo", children: [] },
        { id: "n_arr", title: "丙", status: "done", children: "nope" },
      ],
    },
    collapsed: [],
  });
  assert.equal(parsed.ok, false);
  const joined = parsed.errors.map((error) => `${error.path}:${error.message}`).join("\n");
  assert.match(joined, /root\.children\[0\].*status 非法/);
  assert.match(joined, /root\.children\[1\].*title 缺失/);
  assert.match(joined, /root\.children\[1\].*id 重复/);
  assert.match(joined, /root\.children\[2\].*children 必须是数组/);
});

test("parseTree 不抛异常，只做拒绝；未知字段被归一化丢弃", () => {
  const parsed = parseTree(validLike());
  assert.equal(parsed.ok, true);
  assert.equal("junk" in parsed.tree.root, false);
  assert.equal(parsed.tree.root.children[0].source, "user", "缺 source 时补默认");
  assert.equal(parsed.tree.root.children[0].hint, "");
});

test("parseTree 拒绝 schemaVersion 缺失（不猜版本）", () => {
  const value = validLike();
  delete value.schemaVersion;
  const parsed = parseTree(value);
  assert.equal(parsed.ok, false);
  assert.match(parsed.errors[0].message, /不支持的版本/);
});

function validLike() {
  return {
    schemaVersion: 1,
    id: "t_x1",
    title: "T",
    createdAt: "2026-09-23T00:00:00.000Z",
    updatedAt: "2026-09-23T00:00:00.000Z",
    collapsed: [],
    junk: "top",
    root: {
      id: "n_r",
      title: "T",
      status: "todo",
      junk: "node",
      children: [{ id: "n_c", title: "子问题", status: "done", children: [] }],
    },
  };
}

/* ------------------------------------------------------------------ 克隆与工具 */

test("cloneTree 是深拷贝：改副本不影响原树", () => {
  const { tree, a } = fixture();
  const copy = cloneTree(tree);
  removeNode(copy, a.id);
  assert.ok(findNode(tree, a.id), "原树必须还在");
  assert.notEqual(copy.root.children[0], tree.root.children[0]);
});

test("truncate：中英文混排统一按字符数，超出加省略号", () => {
  assert.deepEqual(truncate("短", 10), { text: "短", clipped: false });
  assert.deepEqual(truncate("一二三四五六七八九十", 5), { text: "一二三四…", clipped: true });
  assert.deepEqual(truncate(null, 3), { text: "", clipped: false });
});

/* ------------------------------------------------------------------ 示例数据 */

test("示例树：三棵都通过校验，且含 AI 节点 / 折叠 / 混合状态", () => {
  const trees = sampleTrees(ctx(3));
  assert.equal(trees.length, 3);
  for (const tree of trees) assert.equal(validateTree(tree).ok, true, tree.title);
  const [rag] = trees;
  const sources = collectSources(rag);
  assert.ok(sources.includes("ai"), "示例里要有 AI 生成的节点");
  assert.ok(sources.includes("user"), "示例里也要有手写的节点");
  assert.equal(rag.collapsed.length, 1, "示例里要有一处折叠，才看得出 +N 徽标");
  assert.ok(findNode(rag, rag.collapsed[0]), "collapsed 必须指向真实存在的节点 id");
  const progress = progressOf(rag);
  assert.ok(progress.ratio > 0 && progress.ratio < 1, `示例进度要真实存在：${progress.done}/${progress.total}`);
  assert.ok(progress.total >= 20, "示例树要有足够的叶子才像真笔记");
});

test("主示例树可反复生成且互不共享引用", () => {
  const context = ctx(5);
  const one = primarySampleTree(context);
  const two = primarySampleTree(context);
  assert.notEqual(one.root, two.root);
  assert.equal(one.root.children.length, two.root.children.length);
});

function collectSources(tree) {
  const out = [];
  const walk = (node) => {
    out.push(node.source);
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  return out;
}
