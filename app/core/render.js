/**
 * learntree · 树布局与 SVG 渲染（纯函数，不碰 DOM）
 * layoutTree() → 几何；renderTreeSvg() → 字符串。规格见 DEVELOPMENT.md §10。
 */

import { countDescendants, findInconsistencies, subtreeProgress, truncate } from "./tree.js";

export const LAYOUT_DEFAULTS = Object.freeze({
  nodeWidth: 244,
  nodeHeight: 54,
  gapX: 46,
  gapY: 14,
  padding: 20,
});

export const RENDER_DEFAULTS = Object.freeze({
  titleChars: 12,
  titleLines: 2,
});

const GLYPH = Object.freeze({ todo: "○", doing: "◐", done: "✓" });
const STATUS_CN = Object.freeze({ todo: "未开始", doing: "进行中", done: "已完成" });

/* ------------------------------------------------------------------ 转义 */

/**
 * SVG 字符串是本项目唯一的 innerHTML 出口，用户数据全靠这里兜住。
 * 少转义一个字符就是 XSS（§15 / §20-10）。
 */
const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };

export function escapeXml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ESCAPES[char]);
}

function f(value) {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------ 布局 */

/**
 * x = 深度，y = 行槽位；叶子按前序各占一行，父节点落在首末子节点的中点。
 * 折叠节点的整棵子树不参与布局，只在父节点上留 hiddenCount。
 */
export function layoutTree(tree, options = {}) {
  const opts = { ...LAYOUT_DEFAULTS, ...options };
  const collapsed = new Set(tree.collapsed ?? []);
  const nodes = [];
  const byId = new Map();
  let rowCursor = 0;

  const place = (node, depth, parentId) => {
    const isCollapsed = collapsed.has(node.id) && node.children.length > 0;
    const children = isCollapsed ? [] : node.children;
    const record = {
      id: node.id,
      title: node.title,
      note: node.note ?? "",
      hint: node.hint ?? "",
      status: node.status,
      source: node.source ?? "user",
      depth,
      parentId,
      x: opts.padding + depth * (opts.nodeWidth + opts.gapX),
      y: 0,
      width: opts.nodeWidth,
      height: opts.nodeHeight,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
      hiddenCount: isCollapsed ? countDescendants(node) : 0,
      progress: subtreeProgress(node),
      inconsistent: false,
    };
    // 先入列再排子节点：nodes 数组因此是前序，与 outlineRows 的顺序一致。
    nodes.push(record);
    byId.set(record.id, record);
    if (children.length === 0) {
      record.y = opts.padding + rowCursor * (opts.nodeHeight + opts.gapY);
      rowCursor += 1;
    } else {
      const ys = children.map((child) => place(child, depth + 1, node.id));
      record.y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    return record.y;
  };

  place(tree.root, 0, null);

  const marks = new Set(findInconsistencies(tree).map((item) => item.id));
  for (const record of nodes) record.inconsistent = marks.has(record.id);

  const links = [];
  for (const record of nodes) {
    if (!record.parentId) continue;
    const parent = byId.get(record.parentId);
    if (parent) links.push({ fromId: parent.id, toId: record.id, d: orthogonal(parent, record) });
  }

  const maxDepth = nodes.reduce((max, record) => Math.max(max, record.depth), 0);
  const rows = Math.max(rowCursor, 1);
  return {
    nodes,
    links,
    byId,
    width: opts.padding * 2 + (maxDepth + 1) * opts.nodeWidth + maxDepth * opts.gapX,
    height: opts.padding * 2 + rows * opts.nodeHeight + (rows - 1) * opts.gapY,
    options: opts,
    visibleCount: nodes.length,
    hiddenCount: nodes.reduce((sum, record) => sum + record.hiddenCount, 0),
  };
}

function orthogonal(parent, child) {
  const x1 = parent.x + parent.width;
  const y1 = parent.y + parent.height / 2;
  const x2 = child.x;
  const y2 = child.y + child.height / 2;
  const mid = x1 + (x2 - x1) / 2;
  return `M ${f(x1)} ${f(y1)} H ${f(mid)} V ${f(y2)} H ${f(x2)}`;
}

/* ------------------------------------------------------------------ 文本折行 */

/** 按码点折行，避免把 emoji 的代理对劈成两半。 */
export function wrapTitle(title, options = {}) {
  const budget = options.titleChars ?? RENDER_DEFAULTS.titleChars;
  const maxLines = options.titleLines ?? RENDER_DEFAULTS.titleLines;
  const chars = Array.from(String(title ?? ""));
  const lines = [];
  for (let i = 0; i < chars.length && lines.length < maxLines; i += budget) {
    lines.push(chars.slice(i, i + budget).join(""));
  }
  if (chars.length > budget * maxLines && lines.length) {
    const last = Array.from(lines[lines.length - 1]);
    lines[lines.length - 1] = `${last.slice(0, Math.max(0, budget - 1)).join("")}…`;
  }
  return { lines, overflow: chars.length > budget * maxLines, total: chars.length };
}

/* ------------------------------------------------------------------ SVG 字符串 */

export function renderTreeSvg(layout, state = {}, options = {}) {
  const opts = { ...RENDER_DEFAULTS, ...options };
  const selected = state.selectedId ?? null;
  const matches = state.matches instanceof Set ? state.matches : new Set(state.matches ?? []);
  const linkMarkup = layout.links
    .map(
      (link) =>
        `    <path class="lt-link" data-from="${escapeXml(link.fromId)}" data-to="${escapeXml(link.toId)}" d="${link.d}"/>`,
    )
    .join("\n");
  const nodeMarkup = layout.nodes
    .map((node) => renderNode(node, { selected, matches, opts }))
    .join("\n");
  return [
    `<svg class="lt-svg" xmlns="http://www.w3.org/2000/svg" role="img"`,
    `  aria-label="问题树，可见 ${layout.visibleCount} 个节点"`,
    `  width="${f(layout.width)}" height="${f(layout.height)}"`,
    `  viewBox="0 0 ${f(layout.width)} ${f(layout.height)}">`,
    `  <g class="lt-links">`,
    linkMarkup,
    `  </g>`,
    `  <g class="lt-nodes">`,
    nodeMarkup,
    `  </g>`,
    `</svg>`,
  ].join("\n");
}

function renderNode(node, ctx) {
  const { selected, matches, opts } = ctx;
  const classes = ["lt-node", `lt-is-${node.status}`];
  if (node.source === "ai") classes.push("lt-from-ai");
  if (node.collapsed) classes.push("lt-collapsed");
  if (node.inconsistent) classes.push("lt-inconsistent");
  if (selected === node.id) classes.push("lt-selected");
  if (matches.has(node.id)) classes.push("lt-match");

  // layoutTree 已把 padding 折进坐标，这里只消费，不再二次偏移。
  const { x, y } = node;
  const parts = [
    `  <g class="${classes.join(" ")}" data-id="${escapeXml(node.id)}" data-status="${escapeXml(node.status)}" data-depth="${node.depth}" data-source="${escapeXml(node.source)}" tabindex="0" role="button" aria-label="${escapeXml(ariaLabel(node))}">`,
    `    <rect class="lt-box" x="${f(x)}" y="${f(y)}" width="${f(node.width)}" height="${f(node.height)}" rx="10"/>`,
    `    <text class="lt-glyph" x="${f(x + 12)}" y="${f(y + 26)}">${GLYPH[node.status] ?? GLYPH.todo}</text>`,
  ];

  wrapTitle(node.title, opts).lines.forEach((line, index) => {
    parts.push(
      `    <text class="lt-title" x="${f(x + 30)}" y="${f(y + 22 + index * 15)}" xml:space="preserve">${escapeXml(line)}</text>`,
    );
  });

  const clue = node.hint || node.note;
  if (clue) {
    parts.push(
      `    <text class="lt-hint" x="${f(x + 30)}" y="${f(y + 45)}" xml:space="preserve">${escapeXml(truncate(clue, 17).text)}</text>`,
    );
  }

  if (node.source === "ai") {
    parts.push(
      `    <text class="lt-ai" x="${f(x + node.width - 30)}" y="${f(y + 14)}" text-anchor="end">AI</text>`,
    );
  }

  const meta = node.collapsed
    ? `+${node.hiddenCount}`
    : node.hasChildren
      ? `${node.progress.done}/${node.progress.total}`
      : "";
  if (meta) {
    parts.push(
      `    <text class="lt-meta" x="${f(x + node.width - 12)}" y="${f(y + node.height - 10)}" text-anchor="end">${escapeXml(meta)}</text>`,
    );
  }

  if (node.hasChildren) {
    parts.push(
      `    <g class="lt-toggle" data-toggle="${escapeXml(node.id)}" transform="translate(${f(x + node.width - 14)},${f(y + node.height / 2 - 7)})">`,
      `      <rect class="lt-toggle-bg" x="0" y="0" width="14" height="14" rx="4"/>`,
      `      <text class="lt-toggle-mark" x="7" y="11" text-anchor="middle">${node.collapsed ? "+" : "−"}</text>`,
      `    </g>`,
    );
  }

  if (node.inconsistent) {
    parts.push(
      `    <text class="lt-warn" x="${f(x + 12)}" y="${f(y + 45)}">!</text>`,
      `    <title>标记为已完成，但子问题还没全部完成</title>`,
    );
  }

  parts.push(`  </g>`);
  return parts.join("\n");
}

function ariaLabel(node) {
  const status = STATUS_CN[node.status] ?? node.status;
  const ai = node.source === "ai" ? "，AI 生成" : "";
  return `${node.title}，${status}${ai}`;
}

/**
 * 侧栏大纲用的扁平行；与 SVG 共用同一份折叠语义，避免两处各判一次。
 */
export function outlineRows(tree) {
  const collapsed = new Set(tree.collapsed ?? []);
  const rows = [];
  const walk = (node, depth) => {
    const isCollapsed = collapsed.has(node.id) && node.children.length > 0;
    rows.push({
      id: node.id,
      title: node.title,
      status: node.status,
      source: node.source ?? "user",
      depth,
      hasChildren: node.children.length > 0,
      collapsed: isCollapsed,
      hiddenCount: isCollapsed ? countDescendants(node) : 0,
      progress: subtreeProgress(node),
    });
    if (isCollapsed) return;
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree.root, 0);
  return rows;
}
