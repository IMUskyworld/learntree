import { test } from "node:test";
import assert from "node:assert/strict";

import { addChild, createTree, findNode } from "../app/core/tree.js";
import { primarySampleTree } from "../app/core/sample.js";
import {
  LAYOUT_DEFAULTS,
  escapeXml,
  layoutTree,
  outlineRows,
  renderTreeSvg,
  wrapTitle,
} from "../app/core/render.js";

/* ------------------------------------------------------------------ 脚手架 */

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
 * root
 *  ├─ A ─ A1, A2
 *  └─ B ─ B1
 */
function fixture() {
  const context = ctx();
  const tree = createTree({ title: "根问题" }, context);
  const a = addChild(tree, tree.root.id, { title: "A" }, context);
  const a1 = addChild(tree, a.id, { title: "A1" }, context);
  const a2 = addChild(tree, a.id, { title: "A2" }, context);
  const b = addChild(tree, tree.root.id, { title: "B" }, context);
  const b1 = addChild(tree, b.id, { title: "B1" }, context);
  return { tree, context, a, a1, a2, b, b1 };
}

function rows(layout) {
  return new Map(layout.nodes.map((node) => [node.id, node]));
}

function blockOf(svg, id) {
  const anchor = svg.indexOf(`data-id="${id}"`);
  assert.notEqual(anchor, -1, `SVG 里找不到节点 ${id}`);
  const start = svg.lastIndexOf("<g ", anchor);
  const end = svg.indexOf("\n  </g>", anchor);
  return svg.slice(start, end === -1 ? svg.length : end);
}

const STEP_Y = LAYOUT_DEFAULTS.nodeHeight + LAYOUT_DEFAULTS.gapY;
const STEP_X = LAYOUT_DEFAULTS.nodeWidth + LAYOUT_DEFAULTS.gapX;

/* ------------------------------------------------------------------ 布局几何 */

test("layoutTree：x 随深度线性递增，步长 = 节点宽 + 水平间距", () => {
  const { tree, a, a1 } = fixture();
  const layout = layoutTree(tree);
  const map = rows(layout);
  assert.equal(map.get(tree.root.id).x, LAYOUT_DEFAULTS.padding);
  assert.equal(map.get(a.id).x - map.get(tree.root.id).x, STEP_X);
  assert.equal(map.get(a1.id).x - map.get(a.id).x, STEP_X);
  assert.equal(map.get(a1.id).depth, 2);
});

test("layoutTree：叶子按前序各占一行，父节点落在首末子节点的中点", () => {
  const { tree, a, b, a1, a2, b1 } = fixture();
  const map = rows(layoutTree(tree));
  assert.equal(map.get(a1.id).y, LAYOUT_DEFAULTS.padding, "第一个叶子贴着上边距");
  assert.equal(map.get(a2.id).y - map.get(a1.id).y, STEP_Y);
  assert.equal(map.get(b1.id).y - map.get(a2.id).y, STEP_Y, "跨父节点也保持连续行槽");
  assert.equal(map.get(a.id).y, (map.get(a1.id).y + map.get(a2.id).y) / 2);
  assert.equal(map.get(b.id).y, map.get(b1.id).y, "独子节点的父与子同高");
  assert.equal(
    map.get(tree.root.id).y,
    (map.get(a.id).y + map.get(b.id).y) / 2,
    "父节点居中于其子节点（递归定义）",
  );
});

test("layoutTree：画布尺寸包住所有节点盒", () => {
  const layout = layoutTree(fixture().tree);
  for (const node of layout.nodes) {
    assert.ok(node.x + node.width <= layout.width, `${node.title} 横向溢出`);
    assert.ok(node.y + node.height <= layout.height, `${node.title} 纵向溢出`);
  }
  const sample = layoutTree(primarySampleTree(ctx(2)));
  assert.ok(sample.width > layout.width, "示例树更深，画布应更宽");
  assert.ok(sample.height > layout.height, "示例树叶子更多，画布应更高");
});

test("layoutTree：除根外每个可见节点恰好一条入边，连线只引用可见节点", () => {
  const layout = layoutTree(fixture().tree);
  const ids = new Set(layout.nodes.map((node) => node.id));
  const incoming = new Map();
  for (const link of layout.links) {
    assert.ok(ids.has(link.fromId) && ids.has(link.toId), "连线不能指向未渲染节点");
    assert.match(link.d, /^M [\d.-]+ [\d.-]+ H [\d.-]+ V [\d.-]+ H [\d.-]+$/, "正交折线");
    incoming.set(link.toId, (incoming.get(link.toId) ?? 0) + 1);
  }
  assert.equal(layout.links.length, layout.nodes.length - 1);
  for (const node of layout.nodes) {
    assert.equal(incoming.get(node.id) ?? 0, node.parentId ? 1 : 0, node.title);
  }
});

test("layoutTree：折叠的子树不参与布局，父节点记下 hiddenCount", () => {
  const { tree, a, a1, a2 } = fixture();
  const before = layoutTree(tree);
  assert.equal(before.nodes.length, 6);
  tree.collapsed = [a.id];
  const after = layoutTree(tree);
  const map = rows(after);
  assert.equal(after.nodes.length, 4);
  assert.equal(map.has(a1.id), false);
  assert.equal(map.has(a2.id), false);
  assert.equal(map.get(a.id).collapsed, true);
  assert.equal(map.get(a.id).hiddenCount, 2);
  assert.equal(after.hiddenCount, 2);
  assert.equal(after.links.length, 3, "A1/A2 的入边消失，A 的出边本来就没有");
});

test("layoutTree：折叠根节点时只剩根自己", () => {
  const { tree } = fixture();
  tree.collapsed = [tree.root.id];
  const layout = layoutTree(tree);
  assert.equal(layout.nodes.length, 1);
  assert.equal(layout.links.length, 0);
  assert.equal(layout.hiddenCount, 5);
});

test("layoutTree：单节点树的画布与进度", () => {
  const lone = createTree({ title: "只有一个问题" }, ctx());
  const layout = layoutTree(lone);
  assert.equal(layout.nodes.length, 1);
  assert.deepEqual(layout.nodes[0].progress, { done: 0, total: 1, ratio: 0 });
  assert.equal(layout.height, LAYOUT_DEFAULTS.padding * 2 + LAYOUT_DEFAULTS.nodeHeight);
});

test("layoutTree：自定义间距会反映到几何上", () => {
  const { tree, a } = fixture();
  const layout = layoutTree(tree, { nodeWidth: 100, gapX: 10, gapY: 0, nodeHeight: 20, padding: 0 });
  const map = rows(layout);
  assert.equal(map.get(a.id).x, 110);
  assert.equal(map.get(a.id).width, 100);
  assert.equal(map.get(a.id).y, 10, "A 落在 A1(0) 与 A2(20) 的中点");
  assert.equal(map.get(tree.root.id).y, 25, "根落在 A(10) 与 B(40) 的中点");
});

test("layoutTree：标记 done 但子树未完成 → inconsistent 角标", () => {
  const { tree, a, a2 } = fixture();
  findNode(tree, a.id).status = "done";
  const map = rows(layoutTree(tree));
  assert.equal(map.get(a.id).inconsistent, true);
  assert.equal(map.get(a2.id).inconsistent, false);
  assert.equal(map.get(tree.root.id).inconsistent, false);
});

/* ------------------------------------------------------------------ 转义与折行 */

test("escapeXml：& < > 双引号 单引号 全覆盖", () => {
  assert.equal(escapeXml(`<a href="x">&'`), `&lt;a href=&quot;x&quot;&gt;&amp;&apos;`);
  assert.equal(escapeXml("普通中文 emoji 🌟"), "普通中文 emoji 🌟");
  assert.equal(escapeXml(null), "");
  assert.equal(escapeXml(123), "123");
});

test("wrapTitle：按码点折行，不劈开 emoji 代理对，超出以省略号收尾", () => {
  assert.deepEqual(wrapTitle("很短", { titleChars: 5, titleLines: 2 }), {
    lines: ["很短"],
    overflow: false,
    total: 2,
  });
  const long = wrapTitle("一二三四五六七八九", { titleChars: 4, titleLines: 2 });
  assert.equal(long.lines.length, 2);
  assert.equal(long.lines[1].endsWith("…"), true);
  assert.equal(long.overflow, true);
  const emoji = wrapTitle("🌟🌟🌟🌟🌟", { titleChars: 2, titleLines: 3 });
  for (const line of emoji.lines) {
    assert.equal(line.includes("\ufffd"), false, "不能出现半个代理对");
  }
  assert.equal(wrapTitle("", { titleChars: 3 }).lines.length, 0);
});

/* ------------------------------------------------------------------ SVG 字符串 */

test("renderTreeSvg：每个节点都带 data-id / data-status / data-depth / data-source", () => {
  const { tree, a } = fixture();
  const layout = layoutTree(tree);
  const svg = renderTreeSvg(layout, {});
  for (const node of layout.nodes) {
    assert.ok(svg.includes(`data-id="${node.id}"`), node.title);
    assert.ok(svg.includes(`data-status="${node.status}"`), node.title);
  }
  assert.match(svg, /^<svg class="lt-svg" xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.ok(svg.includes(`data-id="${a.id}" data-status="todo" data-depth="1" data-source="user"`));
});

test("renderTreeSvg：用户标题里的 HTML 不会变成真元素（XSS 静态防线）", () => {
  const context = ctx();
  const tree = createTree({ title: "标题攻击" }, context);
  const evil = addChild(tree, tree.root.id, { title: `<img src=x onerror=alert(1)>` }, context);
  const quotes = addChild(tree, tree.root.id, { title: `a & "b" <c> 'd'` }, context);
  const close = addChild(tree, tree.root.id, { title: `</text></g><script>alert(2)</script>` }, context);
  const svg = renderTreeSvg(layoutTree(tree), {});
  assert.equal(svg.includes("<img"), false);
  assert.equal(svg.includes("<script"), false);
  assert.ok(svg.includes("&lt;img src=x onerror=alert(1)&gt;"), "转义后要能在图上原样读出");
  assert.ok(svg.includes("a &amp; &quot;b&quot; &lt;c&gt; &apos;d&apos;"));
  assert.ok(blockOf(svg, quotes.id).includes("&quot;"));
  assert.ok(blockOf(svg, evil.id).includes("&lt;img src=x o"), "折行后仍是可读的转义文本");
  assert.ok(blockOf(svg, close.id).includes("&lt;/text&gt;&lt;/g&gt;&lt;"));
  assert.deepEqual(unexpectedTags(svg), [], "输出里只允许出现渲染器自己写的标签");
  assert.equal((svg.match(/<g[\s>]/g) ?? []).length, (svg.match(/<\/g>/g) ?? []).length, "标签必须配平");
});

/** 列出所有不是渲染器自己产出的标签 —— 用户数据一旦能"逃出"转义，这里就会亮。 */
function unexpectedTags(svg) {
  const allowed = new Set(["svg", "g", "rect", "path", "text", "title"]);
  const out = [];
  for (const tag of svg.match(/<[^>]*>/g) ?? []) {
    const name = tag.slice(1).replace(/^\//, "").match(/^[A-Za-z][\w:-]*/);
    if (!name || !allowed.has(name[0])) out.push(tag);
  }
  return out;
}

test("renderTreeSvg：hint / note 里的尖括号同样被转义", () => {
  const context = ctx();
  const tree = createTree({ title: "T" }, context);
  const withHint = addChild(tree, tree.root.id, { title: "带提示", hint: "<b>粗</b>" }, context);
  const withNote = addChild(tree, tree.root.id, { title: "带备注" }, context);
  findNode(tree, withNote.id).note = "<svg onload=1>";
  const svg = renderTreeSvg(layoutTree(tree), {});
  assert.equal(svg.includes("<b>"), false);
  assert.equal(svg.match(/<svg/g).length, 1, "只能有一个根 <svg>，标题里的 <svg 必须被转义");
  assert.ok(blockOf(svg, withHint.id).includes("&lt;b&gt;粗&lt;/b&gt;"));
  assert.ok(blockOf(svg, withNote.id).includes("&lt;svg onload=1&gt;"));
});

test("renderTreeSvg：选中态与搜索命中态只落在 class 上", () => {
  const { tree, a, b } = fixture();
  const layout = layoutTree(tree);
  const svg = renderTreeSvg(layout, { selectedId: a.id, matches: new Set([b.id]) });
  assert.ok(blockOf(svg, a.id).includes("lt-selected"), "选中态只落在 class 上");
  assert.ok(blockOf(svg, b.id).includes("lt-match"));
  assert.ok(!blockOf(svg, b.id).includes("lt-selected"));
  const plain = renderTreeSvg(layout, {});
  assert.equal(plain.includes("lt-selected"), false);
  assert.equal(plain.includes("lt-match"), false);
});

test("renderTreeSvg：状态用非颜色符号区分，AI 节点带标记", () => {
  const context = ctx();
  const tree = createTree({ title: "T" }, context);
  const done = addChild(tree, tree.root.id, { title: "完成", status: "done" }, context);
  const doing = addChild(tree, tree.root.id, { title: "进行中", status: "doing" }, context);
  const ai = addChild(tree, tree.root.id, { title: "AI 的", source: "ai" }, context);
  const svg = renderTreeSvg(layoutTree(tree), {});
  assert.ok(blockOf(svg, done.id).includes(">✓<"), "done 用 ✓ 表意，不只靠颜色");
  assert.ok(blockOf(svg, doing.id).includes(">◐<"));
  assert.ok(blockOf(svg, ai.id).includes(">AI<"));
  assert.ok(blockOf(svg, tree.root.id).includes(">○<"));
});

test("renderTreeSvg：有子节点才有折叠开关；折叠后开关变 + 并显示 +N", () => {
  const { tree, a, b } = fixture();
  const open = renderTreeSvg(layoutTree(tree), {});
  assert.equal((open.match(/class="lt-toggle"[\s>]/g) ?? []).length, 3, "根、A、B 三个节点有孩子");
  assert.ok(blockOf(open, a.id).includes(">−<"));
  assert.equal(blockOf(open, tree.root.id).includes("+"), false, "未折叠时不该出现 +N");
  tree.collapsed = [a.id];
  const closed = renderTreeSvg(layoutTree(tree), {});
  assert.match(blockOf(closed, a.id), /\+2/);
  assert.ok(blockOf(closed, a.id).includes(">+<"));
  assert.equal(blockOf(closed, b.id).includes("+"), false);
});

test("renderTreeSvg：中间节点显示子树进度，叶子不显示", () => {
  const { tree, a, a1 } = fixture();
  const svg = renderTreeSvg(layoutTree(tree), {});
  assert.ok(blockOf(svg, a.id).includes(">0/2<"), "A 底下两个叶子都没完成");
  assert.equal(blockOf(svg, a1.id).includes("lt-meta"), false, "叶子没有聚合进度可言");
});

test("renderTreeSvg：同一棵树两次渲染逐字节一致", () => {
  const layout = layoutTree(primarySampleTree(ctx(4)));
  assert.equal(renderTreeSvg(layout, {}), renderTreeSvg(layout, {}));
});

test("renderTreeSvg：渲染出的节点数与布局一致", () => {
  const tree = primarySampleTree(ctx(4));
  const layout = layoutTree(tree);
  const svg = renderTreeSvg(layout, {});
  assert.equal((svg.match(/class="lt-node /g) ?? []).length, layout.nodes.length);
  assert.ok(layout.nodes.length >= 10, "示例树要够大才测得出批量渲染");
});

/* ------------------------------------------------------------------ 大纲 */

test("outlineRows：前序展开、深度递增、折叠处停止下钻", () => {
  const { tree, a } = fixture();
  assert.deepEqual(
    outlineRows(tree).map((row) => `${".".repeat(row.depth)}${row.title}`),
    ["根问题", ".A", "..A1", "..A2", ".B", "..B1"],
  );
  tree.collapsed = [a.id];
  assert.deepEqual(
    outlineRows(tree).map((row) => row.title),
    ["根问题", "A", "B", "B1"],
  );
});

test("outlineRows：携带状态、来源与子树进度", () => {
  const { tree, a } = fixture();
  const map = new Map(outlineRows(tree).map((row) => [row.id, row]));
  assert.deepEqual(map.get(a.id).progress, { done: 0, total: 2, ratio: 0 });
  assert.equal(map.get(a.id).hasChildren, true);
  assert.equal(map.get(tree.root.id).depth, 0);
  assert.equal(map.get(tree.root.id).source, "user");
  assert.equal(map.get(a.id).collapsed, false);
});

test("大纲与 SVG 对折叠的判断一致", () => {
  const { tree, a } = fixture();
  tree.collapsed = [a.id];
  const layoutIds = layoutTree(tree).nodes.map((node) => node.id);
  const outlineIds = outlineRows(tree).map((row) => row.id);
  assert.deepEqual(outlineIds, layoutIds);
});
