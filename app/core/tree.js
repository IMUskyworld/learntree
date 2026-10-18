/**
 * learntree · 问题树模型（纯函数，不碰 DOM）
 * 规格见 DEVELOPMENT.md §8。
 */

export const SCHEMA_VERSION = 1;
export const STATUSES = Object.freeze(["todo", "doing", "done"]);
export const SOURCES = Object.freeze(["user", "ai"]);

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const ID_LENGTH = 6;
export const MAX_TITLE = 200;

/* ------------------------------------------------------------------ 标识与时间 */

function defaultRandom() {
  const buf = new Uint32Array(1);
  globalThis.crypto?.getRandomValues?.(buf);
  const value = buf[0];
  return Number.isFinite(value) ? value / 0x1_0000_0000 : Math.random();
}

export function makeId(prefix, rand = defaultRandom) {
  let out = "";
  for (let i = 0; i < ID_LENGTH; i += 1) {
    out += ID_ALPHABET[Math.floor(rand() * ID_ALPHABET.length) % ID_ALPHABET.length];
  }
  return `${prefix}_${out}`;
}

export function makeNow() {
  return () => new Date().toISOString();
}

function stamp(tree) {
  tree.updatedAt = makeNow()();
  return tree;
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE);
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

/* ------------------------------------------------------------------ 构造 */

export function isNode(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      typeof value.id === "string" &&
      typeof value.title === "string" &&
      Array.isArray(value.children),
  );
}

function isTreeShape(value) {
  return Boolean(value && typeof value === "object" && isNode(value.root) && value.schemaVersion !== undefined);
}

export function createNode(input = {}, ctx = {}) {
  const title = cleanTitle(input.title);
  if (!title) throw new Error("节点标题不能为空");
  const status = input.status ?? "todo";
  if (!STATUSES.includes(status)) throw new Error(`非法状态: ${status}`);
  const source = input.source ?? "user";
  if (!SOURCES.includes(source)) throw new Error(`非法来源: ${source}`);
  const children = Array.isArray(input.children)
    ? input.children.map((child) => (isNode(child) ? cloneNode(child) : createNode(child, ctx)))
    : [];
  return {
    id: input.id ?? makeId("n", ctx.rand),
    title,
    note: text(input.note),
    status,
    source,
    hint: text(input.hint),
    children,
  };
}

export function createTree(input = {}, ctx = {}) {
  const title = cleanTitle(input.title);
  if (!title) throw new Error("树标题不能为空");
  const now = ctx.now ?? makeNow();
  const rootInput = input.root && typeof input.root === "object" ? input.root : {};
  const root = createNode(
    {
      title: cleanTitle(rootInput.title) || title,
      note: rootInput.note,
      status: rootInput.status,
      source: rootInput.source,
      hint: rootInput.hint,
      id: rootInput.id,
      children: rootInput.children ?? [],
    },
    ctx,
  );
  const created = input.createdAt ?? now();
  return {
    schemaVersion: SCHEMA_VERSION,
    id: input.id ?? makeId("t", ctx.rand),
    title,
    createdAt: created,
    updatedAt: input.updatedAt ?? created,
    root,
    collapsed: normalizeCollapsed(input.collapsed),
  };
}

function normalizeCollapsed(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === "string"))];
}

/* ------------------------------------------------------------------ 查询 */

/** 前序深度优先。传入 Tree 或 Node 都可以。 */
export function* iterateNodes(input) {
  const root = isTreeShape(input) ? input.root : input;
  const stack = [root];
  while (stack.length) {
    const current = stack.pop();
    yield current;
    for (let i = current.children.length - 1; i >= 0; i -= 1) stack.push(current.children[i]);
  }
}

/** 前序遍历，回调收到 (node, parent, ancestors)；回调返回 true 立即停止。 */
export function visit(input, callback) {
  const root = isTreeShape(input) ? input.root : input;
  const step = (node, parent, ancestors) => {
    if (callback(node, parent, ancestors) === true) return true;
    const next = [...ancestors, node];
    for (const child of node.children) {
      if (step(child, node, next)) return true;
    }
    return false;
  };
  step(root, null, []);
}

export function findNode(tree, id) {
  if (!tree || typeof id !== "string") return null;
  let hit = null;
  visit(tree, (node) => {
    if (node.id !== id) return false;
    hit = node;
    return true;
  });
  return hit;
}

export function findParent(tree, id) {
  if (!tree || typeof id !== "string") return null;
  let hit = null;
  visit(tree, (node, parent) => {
    if (node.id !== id) return false;
    hit = parent;
    return true;
  });
  return hit;
}

/** 从根到该节点（含）的数组；找不到返回 []。 */
export function pathTo(tree, id) {
  if (!tree || typeof id !== "string") return [];
  let hit = null;
  visit(tree, (node, parent, ancestors) => {
    if (node.id !== id) return false;
    hit = [...ancestors, node];
    return true;
  });
  return hit ?? [];
}

export function pathTitles(tree, id, inclusive = false) {
  const trail = pathTo(tree, id);
  const list = inclusive ? trail : trail.slice(0, -1);
  return list.map((node) => node.title);
}

export function isDescendant(node, maybeAncestorId) {
  for (const child of iterateNodes(node)) {
    if (child.id === maybeAncestorId) return true;
  }
  return false;
}

export function countDescendants(node) {
  let total = 0;
  for (const _ of iterateNodes(node)) total += 1;
  return total - 1;
}

export function countNodes(tree) {
  let total = 0;
  for (const _ of iterateNodes(tree)) total += 1;
  return total;
}

export function leafCount(node) {
  if (!node.children.length) return 1;
  let total = 0;
  for (const child of node.children) total += leafCount(child);
  return total;
}

/* ------------------------------------------------------------------ 进度（按叶子口径，§8.4） */

export function subtreeProgress(node) {
  let done = 0;
  let total = 0;
  visit(node, (current) => {
    if (!current.children.length) {
      total += 1;
      if (current.status === "done") done += 1;
    }
    return false;
  });
  return { done, total, ratio: total === 0 ? 0 : done / total };
}

export function progressOf(tree) {
  return subtreeProgress(isTreeShape(tree) ? tree.root : tree);
}

/** 中间节点标了 done，但它的叶子还没全 done —— 只报告，不改写用户数据。 */
export function findInconsistencies(tree) {
  const out = [];
  visit(tree, (node) => {
    if (node.status !== "done" || !node.children.length) return false;
    let pending = 0;
    visit(node, (child) => {
      if (child !== node && child.status !== "done") pending += 1;
      return false;
    });
    if (pending) out.push({ id: node.id, title: node.title, pendingCount: pending });
    return false;
  });
  return out;
}

/* ------------------------------------------------------------------ 变更（原地，§12 全量重绘） */

export function addChild(tree, parentId, input, ctx = {}) {
  const parent = findNode(tree, parentId);
  if (!parent) throw new Error(`找不到父节点: ${parentId}`);
  const node = createNode(input, ctx);
  parent.children.push(node);
  stamp(tree);
  return node;
}

export function appendChildren(tree, parentId, items, ctx = {}) {
  const created = [];
  for (const item of items ?? []) {
    created.push(addChild(tree, parentId, { ...item, source: item.source ?? "ai" }, ctx));
  }
  stamp(tree);
  return created;
}

export function removeNode(tree, nodeId) {
  if (nodeId === tree.root.id) throw new Error("不能删除根节点");
  const parent = findParent(tree, nodeId);
  if (!parent) throw new Error(`找不到节点: ${nodeId}`);
  const index = parent.children.findIndex((child) => child.id === nodeId);
  const [removed] = parent.children.splice(index, 1);
  stamp(tree);
  return { removed, count: countDescendants(removed) + 1 };
}

export function setStatus(tree, nodeId, status) {
  const node = findNode(tree, nodeId);
  if (!node) throw new Error(`找不到节点: ${nodeId}`);
  if (!STATUSES.includes(status)) throw new Error(`非法状态: ${status}`);
  node.status = status;
  return stamp(tree);
}

export function setTitle(tree, nodeId, title) {
  const node = findNode(tree, nodeId);
  if (!node) throw new Error(`找不到节点: ${nodeId}`);
  const cleaned = cleanTitle(title);
  if (!cleaned) throw new Error("节点标题不能为空");
  node.title = cleaned;
  return stamp(tree);
}

export function setNote(tree, nodeId, note) {
  const node = findNode(tree, nodeId);
  if (!node) throw new Error(`找不到节点: ${nodeId}`);
  node.note = typeof note === "string" ? note.trim() : "";
  return stamp(tree);
}

export function setTreeTitle(tree, title) {
  const cleaned = cleanTitle(title);
  if (!cleaned) throw new Error("树标题不能为空");
  tree.title = cleaned;
  return stamp(tree);
}

/** 禁止移到自己下面、移进自己的子树、移动根节点。 */
export function moveNode(tree, nodeId, newParentId) {
  if (nodeId === tree.root.id) throw new Error("不能移动根节点");
  if (nodeId === newParentId) throw new Error("不能把节点移动到自己下面");
  const node = findNode(tree, nodeId);
  const oldParent = findParent(tree, nodeId);
  const newParent = findNode(tree, newParentId);
  if (!node || !oldParent) throw new Error(`找不到节点: ${nodeId}`);
  if (!newParent) throw new Error(`找不到新父节点: ${newParentId}`);
  if (isDescendant(node, newParentId)) throw new Error("不能把节点移动到自己的子树下");
  oldParent.children.splice(
    oldParent.children.findIndex((child) => child.id === nodeId),
    1,
  );
  newParent.children.push(node);
  stamp(tree);
  return node;
}

export function toggleCollapsed(tree, nodeId) {
  const index = tree.collapsed.indexOf(nodeId);
  if (index >= 0) tree.collapsed.splice(index, 1);
  else tree.collapsed.push(nodeId);
  return tree.collapsed.includes(nodeId);
}

export function isCollapsed(tree, nodeId) {
  return tree.collapsed.includes(nodeId);
}

export function cloneNode(node) {
  return {
    id: node.id,
    title: node.title,
    note: node.note ?? "",
    status: node.status,
    source: node.source ?? "user",
    hint: node.hint ?? "",
    children: node.children.map(cloneNode),
  };
}

export function cloneTree(tree) {
  return {
    schemaVersion: tree.schemaVersion,
    id: tree.id,
    title: tree.title,
    createdAt: tree.createdAt,
    updatedAt: tree.updatedAt,
    root: cloneNode(tree.root),
    collapsed: [...tree.collapsed],
  };
}

/* ------------------------------------------------------------------ 校验与序列化（§8） */

export function validateNode(value, trail = "root", errors = [], seen = null) {
  const ledger = seen ?? new Set();
  if (!value || typeof value !== "object") {
    errors.push({ path: trail, message: "节点必须是对象" });
    return errors;
  }
  if (typeof value.id !== "string" || !value.id) errors.push({ path: trail, message: "id 缺失" });
  else if (ledger.has(value.id)) errors.push({ path: trail, message: `id 重复: ${value.id}` });
  else ledger.add(value.id);

  if (typeof value.title !== "string" || !value.title.trim()) {
    errors.push({ path: trail, message: "title 缺失或为空" });
  } else if (value.title.length > MAX_TITLE) {
    errors.push({ path: trail, message: `title 超过 ${MAX_TITLE} 字` });
  }
  if (!STATUSES.includes(value.status)) {
    errors.push({ path: trail, message: `status 非法: ${value.status}` });
  }
  if (value.source !== undefined && !SOURCES.includes(value.source)) {
    errors.push({ path: trail, message: `source 非法: ${value.source}` });
  }
  if (!Array.isArray(value.children)) {
    errors.push({ path: trail, message: "children 必须是数组" });
  } else {
    value.children.forEach((child, index) => {
      validateNode(child, `${trail}.children[${index}]`, errors, ledger);
    });
  }
  return errors;
}

export function validateTree(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { ok: false, errors: [{ path: "", message: "树必须是对象" }] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ path: "schemaVersion", message: `不支持的版本: ${value.schemaVersion}` });
  }
  if (typeof value.id !== "string" || !value.id) errors.push({ path: "id", message: "id 缺失" });
  if (typeof value.title !== "string" || !value.title.trim()) {
    errors.push({ path: "title", message: "title 缺失" });
  }
  if (!value.root) errors.push({ path: "root", message: "root 缺失" });
  else validateNode(value.root, "root", errors);
  if (value.collapsed !== undefined && !Array.isArray(value.collapsed)) {
    errors.push({ path: "collapsed", message: "collapsed 必须是数组" });
  }
  return { ok: errors.length === 0, errors };
}

/** 把外部 JSON 变成可安全使用的树：先校验，再归一化（丢弃未知字段、补默认值）。 */
export function parseTree(value) {
  const check = validateTree(value);
  if (!check.ok) return { ok: false, errors: check.errors };
  return { ok: true, tree: normalizeTree(value) };
}

export function normalizeNode(node) {
  return {
    id: node.id,
    title: node.title.trim(),
    note: typeof node.note === "string" ? node.note : "",
    status: node.status,
    source: node.source ?? "user",
    hint: typeof node.hint === "string" ? node.hint : "",
    children: node.children.map(normalizeNode),
  };
}

export function normalizeTree(tree) {
  return {
    schemaVersion: SCHEMA_VERSION,
    id: tree.id,
    title: tree.title.trim(),
    createdAt: tree.createdAt,
    updatedAt: tree.updatedAt,
    root: normalizeNode(tree.root),
    collapsed: normalizeCollapsed(tree.collapsed),
  };
}

export function serializeTree(tree) {
  return JSON.stringify(tree, null, 2);
}

export function truncate(value, max) {
  const src = String(value ?? "");
  if (src.length <= max) return { text: src, clipped: false };
  return { text: `${src.slice(0, Math.max(0, max - 1))}…`, clipped: true };
}

/** 结构与内容的指纹，用于"导入后与导出前等价"这类断言（忽略时间戳）。 */
export function signatureOf(tree) {
  const lines = [`${tree.id}|${tree.title}|${tree.collapsed.join(",")}`];
  const visitNode = (node, depth) => {
    lines.push(`${depth}|${node.title}|${node.note}|${node.status}|${node.source}|${node.hint}`);
    for (const child of node.children) visitNode(child, depth + 1);
  };
  visitNode(tree.root, 0);
  return lines.join("\n");
}
