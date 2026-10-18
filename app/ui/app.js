/**
 * learntree · 交互层（全项目唯一碰 DOM 的文件）
 * 只有一处 innerHTML：SVG 挂载点，字符串由 core/render.js 生成且已逐字段转义。
 */

import {
  MAX_TITLE,
  STATUSES,
  addChild,
  appendChildren,
  cloneTree,
  countDescendants,
  countNodes,
  createTree,
  findInconsistencies,
  findNode,
  findParent,
  moveNode,
  pathTitles,
  progressOf,
  removeNode,
  setNote,
  setStatus,
  setTitle,
  setTreeTitle,
  subtreeProgress,
  toggleCollapsed,
} from "../core/tree.js";
import { layoutTree, outlineRows, renderTreeSvg } from "../core/render.js";
import {
  buildExport,
  browserBackend,
  emptyLibrary,
  loadLibrary,
  mergeLibrary,
  parseExport,
  saveLibrary,
} from "../core/storage.js";
import { callLlm, configIssue, isConfigured, previewRequest } from "../core/ai.js";
import { primarySampleTree } from "../core/sample.js";

const STATUS_CN = { todo: "未开始", doing: "进行中", done: "已完成" };
const SAVE_DEBOUNCE_MS = 200;

/* ------------------------------------------------------------------ DOM 工具 */

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === false || value === null || value === undefined) continue;
    if (key === "class") node.className = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (key === "value" || key === "checked" || key === "disabled" || key === "selected") {
      node[key] = value;
    } else node.setAttribute(key, value === true ? "" : String(value));
  }
  add(node, children);
  return node;
}

function add(parent, children) {
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    parent.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return parent;
}

const $ = (id) => document.getElementById(id);

const els = {};

/* ------------------------------------------------------------------ 状态 */

const state = {
  library: null,
  backend: null,
  selectedId: null,
  query: "",
  matches: new Set(),
  undo: null,
  centerOn: null,
  saveTimer: null,
  storageWarning: null,
  busy: false,
};

function activeTree() {
  if (!state.library) return null;
  return state.library.trees.find((tree) => tree.id === state.library.activeTreeId) ?? null;
}

function selectedNode() {
  const tree = activeTree();
  if (!tree || !state.selectedId) return null;
  return findNode(tree, state.selectedId);
}

/* ------------------------------------------------------------------ 落盘 */

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveNow, SAVE_DEBOUNCE_MS);
}

function saveNow() {
  clearTimeout(state.saveTimer);
  const result = saveLibrary(state.library, state.backend);
  if (!result.ok) {
    state.storageWarning = result.error.message;
    status(result.error.message, "error");
  } else if (state.storageWarning) {
    state.storageWarning = null;
  }
  return result;
}

function status(message, kind = "") {
  els.statusMsg.textContent = message;
  els.statusMsg.dataset.kind = kind;
}

function toast(message, kind = "") {
  const item = h("div", { class: `toast toast-${kind || "info"}`, role: "status" }, message);
  els.toastRoot.append(item);
  setTimeout(() => item.classList.add("toast-out"), 3600);
  setTimeout(() => item.remove(), 4200);
}

/* ------------------------------------------------------------------ 快照与撤销 */

function snapshotFor(label) {
  state.undo = { label, library: structuredClone(state.library) };
}

function takeUndo() {
  const entry = state.undo;
  state.undo = null;
  if (!entry) return null;
  state.library = entry.library;
  const tree = activeTree();
  state.selectedId = tree?.root.id ?? null;
  render();
  saveNow();
  status(`已撤销：${entry.label}`);
  return entry;
}

/* ------------------------------------------------------------------ 渲染 */

function render() {
  const tree = activeTree();
  renderTreePicker();
  renderAiIndicator();
  els.emptyState.hidden = Boolean(tree);
  els.app?.classList?.toggle("has-tree", Boolean(tree));
  if (!tree) {
    els.canvas.replaceChildren();
    els.outline.replaceChildren();
    els.treeTitle.textContent = "";
    renderProgress(null, []);
    renderActions(null);
    return;
  }
  els.treeTitle.textContent = tree.title;
  const layout = layoutTree(tree);
  mountSvg(layout);
  renderOutline(tree);
  renderProgress(tree);
  renderActions(tree);
}

function mountSvg(layout) {
  const svg = renderTreeSvg(layout, { selectedId: state.selectedId, matches: state.matches });
  els.canvas.innerHTML = svg; // innerHTML-ok：全项目唯一的 innerHTML 赋值，内容已由 core/render.js 逐字段转义
  const selected = els.canvas.querySelector(`[data-id="${cssEscape(state.selectedId)}"]`);
  selected?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function cssEscape(value) {
  if (!value) return "";
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
}

function renderTreePicker() {
  const { trees, activeTreeId } = state.library;
  els.treeSelect.replaceChildren(
    ...trees.map((tree) =>
      h("option", { value: tree.id, selected: tree.id === activeTreeId }, `${tree.title}（${countNodes(tree)}）`),
    ),
  );
  els.treeSelect.disabled = trees.length === 0;
  const has = trees.length > 0;
  for (const button of [els.btnTreeRename, els.btnTreeDelete]) button.disabled = !has;
}

function renderAiIndicator() {
  const issue = configIssue(state.library.settings.llm);
  const label = issue === null ? "AI 可用" : issue === "disabled" ? "AI 未启用" : "AI 未配置";
  els.aiIndicator.textContent = label;
  els.aiIndicator.className = `pill ${issue === null ? "pill-on" : "pill-off"}`;
  els.aiIndicator.title =
    issue === null
      ? `将请求 ${previewRequest(state.library.settings.llm, { treeTitle: "x", pathTitles: [], title: "y" }).url}`
      : aiHint(issue);
}

function aiHint(issue) {
  if (issue === "disabled") return "AI 分解未启用：打开「设置 → AI 服务」勾选启用。不启用也能正常建树。";
  if (issue === "missing_or_invalid_baseUrl") return "还差一个 OpenAI 兼容的服务地址（设置里填）。";
  return "还差模型名（设置里填）。";
}

function renderProgress(tree) {
  const progress = progressOf(tree);
  els.progressText.textContent = `${progress.done} / ${progress.total} 个叶子问题已完成`;
  els.progressRatio.textContent = `${Math.round(progress.ratio * 100)}%`;
  els.progressFill.style.width = `${Math.round(progress.ratio * 100)}%`;
  const problems = findInconsistencies(tree);
  if (!problems.length) {
    els.consistencyNote.hidden = true;
    els.consistencyNote.replaceChildren();
    return;
  }
  els.consistencyNote.hidden = false;
  els.consistencyNote.replaceChildren(
    h("strong", {}, `${problems.length} 个节点标了「已完成」但子问题没做完`),
    " 进度按叶子算，所以这不会虚增进度；点开节点确认一下。",
    ...problems.slice(0, 6).map((problem) =>
      h(
        "button",
        {
          class: "linklike",
          type: "button",
          onclick: () => select(problem.id),
        },
        ` ${problem.title}`,
      ),
    ),
  );
}

function renderOutline(tree) {
  const rows = outlineRows(tree);
  const list = h("ul", { class: "outline-list" });
  for (const row of rows) {
    const marker = row.collapsed && row.hiddenCount ? `+${row.hiddenCount}` : "";
    const li = h(
      "li",
      {
        class: [
          "outline-row",
          `st-${row.status}`,
          row.id === state.selectedId ? "is-selected" : "",
          state.matches.has(row.id) ? "is-match" : "",
        ]
          .filter(Boolean)
          .join(" "),
        style: `--depth: ${row.depth}`,
        dataset: { id: row.id },
      },
      h("span", { class: "outline-glyph" }, { todo: "○", doing: "◐", done: "✓" }[row.status]),
      h("span", { class: "outline-title" }, row.title),
      row.source === "ai" ? h("span", { class: "outline-ai" }, "AI") : null,
      marker ? h("span", { class: "outline-hidden" }, marker) : null,
      row.hasChildren && row.progress.total > 0
        ? h("span", { class: "outline-count" }, `${row.progress.done}/${row.progress.total}`)
        : null,
    );
    li.addEventListener("click", () => select(row.id));
    li.addEventListener("dblclick", () => editTitle(row.id));
    list.append(li);
  }
  els.outline.replaceChildren(list);
}

function renderActions(tree) {
  const node = selectedNode();
  if (!node) {
    els.nodeActions.replaceChildren(h("span", { class: "muted" }, "选中一个节点后可操作（单击图或大纲）"));
    return;
  }
  const configured = isConfigured(state.library.settings.llm);
  const buttons = [
    h("span", { class: "action-title" }, node.title),
    h(
      "button",
      { class: "btn btn-primary", type: "button", onclick: () => addChildPrompt(node.id) },
      "+ 子问题",
    ),
    h(
      "button",
      {
        class: "btn",
        type: "button",
        disabled: !configured,
        title: configured ? "让 AI 给这个节点拆出若干子问题" : aiHint(configIssue(state.library.settings.llm)),
        onclick: () => decomposeWithAi(node.id),
      },
      "AI 分解",
    ),
  ];
  for (const value of STATUSES) {
    buttons.push(
      h(
        "button",
        {
          class: `btn btn-status st-${value} ${node.status === value ? "is-active" : ""}`,
          type: "button",
          onclick: () => {
            setStatus(tree, node.id, value);
            render();
            saveNow();
          },
        },
        STATUS_CN[value],
      ),
    );
  }
  buttons.push(
    h("button", { class: "btn", type: "button", onclick: () => editTitle(node.id) }, "改标题"),
    h("button", { class: "btn", type: "button", onclick: () => editNote(node.id) }, "备注"),
    h("button", { class: "btn", type: "button", onclick: () => moveNodePrompt(node.id) }, "换父节点"),
    h("button", { class: "btn btn-danger", type: "button", onclick: () => deleteNodePrompt(node.id) }, "删除"),
  );
  if (node.children.length) {
    const progress = subtreeProgress(node);
    buttons.push(
      h(
        "span",
        { class: "muted" },
        `子树 ${progress.done}/${progress.total} · 含 ${countDescendants(node)} 个后代`,
      ),
    );
  }
  els.nodeActions.replaceChildren(...buttons);
}

/* ------------------------------------------------------------------ 选择与折叠 */

function select(id, { center = true } = {}) {
  state.selectedId = id;
  state.centerOn = center ? id : null;
  render();
}

function toggle(id) {
  const tree = activeTree();
  if (!tree) return;
  toggleCollapsed(tree, id);
  render();
  saveNow();
}

/* ------------------------------------------------------------------ 编辑操作 */

async function addChildPrompt(parentId) {
  const value = await promptDialog({
    title: "新增子问题",
    label: "把它写成一个可以判断「懂了没有」的问题",
    placeholder: "例如：重叠率设多少、为什么",
    maxLength: MAX_TITLE,
  });
  if (!value) return;
  const tree = activeTree();
  const node = addChild(tree, parentId, { title: value }, {});
  tree.collapsed = tree.collapsed.filter((id) => id !== parentId);
  state.selectedId = node.id;
  render();
  saveNow();
}

async function editTitle(id) {
  const tree = activeTree();
  const node = findNode(tree, id);
  if (!node) return;
  const value = await promptDialog({
    title: "改标题",
    label: "节点标题",
    initial: node.title,
    maxLength: MAX_TITLE,
  });
  if (!value) return;
  setTitle(tree, id, value);
  render();
  saveNow();
}

async function editNote(id) {
  const tree = activeTree();
  const node = findNode(tree, id);
  if (!node) return;
  const value = await textDialog({ title: "备注", label: "想到什么写什么（纯文本）", initial: node.note });
  if (value === null) return;
  setNote(tree, id, value);
  render();
  saveNow();
}

async function deleteNodePrompt(id) {
  const tree = activeTree();
  const node = findNode(tree, id);
  if (!node) return;
  const descendants = countDescendants(node);
  const ok = await confirmDialog({
    title: "删除节点",
    lines: [
      `将删除「${node.title}」${descendants ? `以及它下面 ${descendants} 个后代节点` : ""}。`,
      "删除后可以在底部一次性撤销。",
    ],
    danger: true,
    okLabel: "删除",
  });
  if (!ok) return;
  snapshotFor("删除节点");
  const parent = findParent(tree, id);
  removeNode(tree, id);
  state.selectedId = parent?.id ?? tree.root.id;
  state.centerOn = state.selectedId;
  render();
  saveNow();
  renderUndoHint("已删除。", "撤销");
}

function renderUndoHint(message, label) {
  status(message);
  els.nodeActions.prepend(
    h(
      "button",
      {
        class: "btn btn-undo",
        type: "button",
        onclick: () => {
          if (takeUndo()) toast("已撤销");
        },
      },
      label,
    ),
  );
}

async function moveNodePrompt(id) {
  const tree = activeTree();
  const choices = [];
  const walk = (node, depth) => {
    if (node.id === id) return; // 整棵被移动的子树都不能当自己的新爹
    choices.push({ id: node.id, label: `${"　".repeat(depth)}${node.title}` });
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(tree.root, 0);
  const picked = await pickDialog({
    title: "换父节点",
    label: "把节点挂到哪里？（自己的子树已排除）",
    choices: choices.map((choice) => ({ value: choice.id, label: choice.label })),
  });
  if (!picked) return;
  moveNode(tree, id, picked);
  if (tree.collapsed.includes(picked)) toggleCollapsed(tree, picked);
  render();
  saveNow();
}

/* ------------------------------------------------------------------ 树级操作 */

async function newTree() {
  const title = await promptDialog({ title: "新建问题树", label: "你想搞明白什么？", placeholder: "学会 RAG" });
  if (!title) return;
  const tree = createTree({ title, root: { note: "" } }, {});
  state.library.trees.push(tree);
  state.library.activeTreeId = tree.id;
  state.selectedId = tree.root.id;
  state.centerOn = tree.root.id;
  render();
  saveNow();
  toast(`已新建「${title}」`);
}

async function renameTree() {
  const tree = activeTree();
  if (!tree) return;
  const title = await promptDialog({ title: "重命名", label: "树名", initial: tree.title });
  if (!title) return;
  setTreeTitle(tree, title);
  render();
  saveNow();
}

async function deleteTree() {
  const tree = activeTree();
  if (!tree) return;
  const ok = await confirmDialog({
    title: "删除整棵树",
    lines: [`将删除「${tree.title}」及其 ${countNodes(tree)} 个节点。`, "建议先导出备份。"],
    danger: true,
    okLabel: "删除这棵树",
  });
  if (!ok) return;
  snapshotFor("删除树");
  const index = state.library.trees.findIndex((item) => item.id === tree.id);
  state.library.trees.splice(index, 1);
  state.library.activeTreeId = state.library.trees[index]?.id ?? state.library.trees[index - 1]?.id ?? null;
  state.selectedId = activeTree()?.root.id ?? null;
  render();
  saveNow();
  renderUndoHint("已删除整棵树。", "撤销");
}

function loadSample() {
  const tree = primarySampleTree({});
  if (state.library.trees.some((item) => item.title === tree.title)) {
    toast("示例树已经在库里了");
    return;
  }
  state.library.trees.push(tree);
  state.library.activeTreeId = tree.id;
  state.selectedId = tree.root.id;
  render();
  saveNow();
  toast("已载入示例树：学会 RAG");
}

/* ------------------------------------------------------------------ 导入 / 导出 */

function exportLibrary() {
  const { text, filename, carriesSecret } = buildExport(state.library, { includeSecrets: false });
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const link = h("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(`已导出 ${filename}${carriesSecret ? "（含密钥！）" : "（不含密钥）"}`);
}

async function importFromText(text) {
  const parsed = parseExport(text);
  if (!parsed.ok) {
    await errorDialog({
      title: "导入被拒绝",
      detail: parsed.errors.map((error) => `${error.path || "（顶层）"}：${error.message}`),
      hint: "只接受 learntree 自己的导出文件；不会猜测未知格式。",
    });
    return;
  }
  const mode = await pickDialog({
    title: "导入方式",
    label: `文件里有 ${parsed.meta.treeCount} 棵树（导出于 ${parsed.meta.exportedAt.slice(0, 10)}）${
      parsed.carriesSecret ? "，并且含有 API 密钥" : ""
    }`,
    choices: [
      { value: "merge", label: "合并进当前库" },
      { value: "replace", label: "整库替换（当前库会被覆盖）" },
    ],
  });
  if (!mode) return;
  if (mode === "replace") snapshotFor("导入替换整库");
  const result = mergeLibrary(state.library, parsed.library, { mode });
  if (!result.ok) {
    await errorDialog({
      title: "导入失败",
      detail: result.errors.map((error) => `${error.path}：${error.message}`),
      hint: "当前库未做任何修改。",
    });
    return;
  }
  state.library = result.library;
  if (!state.library.activeTreeId) state.library.activeTreeId = state.library.trees[0]?.id ?? null;
  state.selectedId = activeTree()?.root.id ?? null;
  render();
  saveNow();
  toast(`导入完成：新增 ${result.report.added} 棵树${result.report.renamed.length ? "（重名已改 id）" : ""}`);
  if (mode === "replace") renderUndoHint("已整库替换。", "撤销");
}

/* ------------------------------------------------------------------ AI 分解 */

async function decomposeWithAi(nodeId) {
  const tree = activeTree();
  const node = findNode(tree, nodeId);
  if (!node) return;
  const config = state.library.settings.llm;
  if (!isConfigured(config)) {
    toast(aiHint(configIssue(config)), "warn");
    return;
  }
  state.busy = true;
  render();
  els.nodeActions.prepend(h("span", { class: "busy" }, "正在拆解…"));
  const result = await callLlm({
    config,
    treeTitle: tree.title,
    pathTitles: pathTitles(tree, nodeId, true),
    title: node.title,
    note: node.note,
    existingChildTitles: node.children.map((child) => child.title),
    fetchImpl: (url, init) => window.fetch(url, init),
  });
  state.busy = false;
  if (!result.ok) {
    await errorDialog({
      title: "AI 分解失败",
      detail: [result.error.message, result.error.raw ? `原文：${result.error.raw}` : ""].filter(Boolean),
      hint: `错误码 ${result.error.code}。你的树没有被修改 —— 可以直接手动加子问题。`,
    });
    render();
    return;
  }
  const adopted = await decomposeDialog({
    nodeTitle: node.title,
    items: result.items,
    meta: result.meta,
  });
  render();
  if (!adopted?.length) {
    status("已取消，树未改动");
    return;
  }
  tree.collapsed = tree.collapsed.filter((id) => id !== nodeId);
  const created = appendChildren(tree, nodeId, adopted, {});
  state.selectedId = created[0]?.id ?? nodeId;
  render();
  saveNow();
  toast(`采纳 ${created.length} 个子问题`);
}

function decomposeDialog({ nodeTitle, items, meta }) {
  const rows = items.map((item) => {
    const check = h("input", { type: "checkbox", checked: true });
    const title = h("input", { class: "edit-title", type: "text", value: item.title, maxlength: MAX_TITLE });
    const hint = h("input", { class: "edit-hint", type: "text", value: item.hint, placeholder: "提示（可空）" });
    const row = h("label", { class: "ai-row" }, check, h("span", { class: "ai-fields" }, title, hint));
    check.addEventListener("change", sync);
    return { row, check, title, hint };
  });
  const counter = h("span", { class: "muted" });
  function sync() {
    counter.textContent = `已选 ${rows.filter((entry) => entry.check.checked).length} / ${rows.length} 条`;
  }
  sync();
  const setAll = (value) => {
    for (const entry of rows) entry.check.checked = value;
    sync();
  };
  const body = h(
    "div",
    {},
    h("p", { class: "modal-note" }, `下面是 AI 为「${nodeTitle}」拆出的子问题。勾掉没用的，标题可以直接改。`),
    meta?.truncated
      ? h("p", { class: "modal-warn" }, `模型给了 ${meta.total} 条，只显示前 ${items.length} 条。`)
      : null,
    meta?.dropped ? h("p", { class: "modal-note" }, `另有 ${meta.dropped} 条与已有子问题重复，已丢弃。`) : null,
    h("div", { class: "ai-rows" }, ...rows.map((entry) => entry.row)),
    h(
      "div",
      { class: "modal-inline" },
      counter,
      h("button", { class: "linklike", type: "button", onclick: () => setAll(true) }, "全选"),
      h("button", { class: "linklike", type: "button", onclick: () => setAll(false) }, "全不选"),
    ),
  );
  return modal({
    title: "AI 分解预览",
    body,
    actions: [
      { label: "取消", value: null },
      {
        label: "采纳勾选项",
        primary: true,
        value: () =>
          rows
            .filter((entry) => entry.check.checked)
            .map((entry) => ({ title: entry.title.value, hint: entry.hint.value, source: "ai" })),
      },
    ],
    onMount: () => rows[0]?.title.focus(),
    width: "36rem",
  });
}

/* ------------------------------------------------------------------ 设置 */

async function openSettings() {
  const config = state.library.settings.llm;
  const enabled = h("input", { type: "checkbox", checked: config.enabled });
  const baseUrl = h("input", { type: "text", value: config.baseUrl, placeholder: "http://127.0.0.1:8931/v1" });
  const model = h("input", { type: "text", value: config.model, placeholder: "mock-mini" });
  const apiKey = h("input", { type: "password", value: config.apiKey, placeholder: "仅存在这台浏览器里" });
  const timeoutMs = h("input", { type: "number", value: String(config.timeoutMs ?? 20000), min: "1000", step: "500" });
  const reveal = h("input", { type: "checkbox" });
  const preview = h("pre", { class: "payload-preview" });
  const message = h("p", { class: "modal-note" });

  const fillPreview = () => {
    const draft = draftConfig({ enabled, baseUrl, model, apiKey, timeoutMs });
    const problem = configIssue(draft);
    if (problem) {
      preview.textContent = "";
      message.textContent = `暂时不会发请求：${aiHint(problem)}`;
      return;
    }
    const request = previewRequest(draft, {
      treeTitle: activeTree()?.title ?? "（示例）",
      pathTitles: ["（示例）学习目标"],
      title: "（示例）要拆解的问题",
      note: "",
      existingChildTitles: [],
    });
    preview.textContent = `${request.method} ${request.url}\n${JSON.stringify(request.headers, null, 2)}\n\n${JSON.stringify(request.body, null, 2)}`;
    message.textContent = `发送内容如上要约 ${request.bytes} 字节；密钥已打码。只发送路径与当前节点，不发送整棵树。`;
  };
  for (const input of [enabled, baseUrl, model, timeoutMs]) input.addEventListener("input", fillPreview);
  apiKey.addEventListener("input", fillPreview);
  reveal.addEventListener("change", () => {
    apiKey.type = reveal.checked ? "text" : "password";
  });
  fillPreview();

  const body = h(
    "div",
    {},
    h("p", { class: "modal-note" }, "不配 AI 也能完整使用：树可以手动拆。AI 只负责「分解节点」这一件事。"),
    h("label", { class: "field" }, enabled, " 启用 AI 分解"),
    h("label", { class: "field" }, "服务地址（OpenAI 兼容）", baseUrl),
    h("label", { class: "field" }, "模型名", model),
    h("label", { class: "field" }, "API 密钥", apiKey, reveal, " 显示"),
    h("label", { class: "field" }, "超时（毫秒）", timeoutMs),
    message,
    preview,
    h(
      "p",
      { class: "modal-warn" },
      "浏览器直连第三方服务需要对端开 CORS；不开就用 scripts/llm_proxy.py 起个本地代理，把地址填成 http://127.0.0.1:8932/v1。",
    ),
  );

  const ok = await modal({
    title: "设置",
    body,
    actions: [
      { label: "取消", value: null },
      { label: "保存", value: true, primary: true },
    ],
  });
  if (!ok) return;
  const draft = draftConfig({ enabled, baseUrl, model, apiKey, timeoutMs });
  state.library.settings.llm = draft;
  render();
  saveNow();
  toast("设置已保存");
}

function draftConfig(fields) {
  const timeout = Number(fields.timeoutMs.value);
  return {
    enabled: fields.enabled.checked,
    baseUrl: fields.baseUrl.value.trim(),
    model: fields.model.value.trim(),
    apiKey: fields.apiKey.value.trim(),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : 20000,
  };
}

/* ------------------------------------------------------------------ 对话框 */

function modal({ title, body, actions, onMount, width, bind }) {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const panel = h("div", { class: "modal", role: "dialog", "aria-modal": "true", "aria-label": title, style: width ? `--w:${width}` : "" },
      h("header", {}, h("h2", {}, title)),
      h("div", { class: "modal-body" }, body),
      h(
        "footer",
        { class: "modal-actions" },
        ...actions.map((action) =>
          h("button", {
            class: `btn ${action.primary ? "btn-primary" : ""} ${action.danger ? "btn-danger" : ""}`,
            type: "button",
            dataset: { value: String(action.label) },
            onclick: () => {
              const value = typeof action.value === "function" ? action.value() : action.value;
              close();
              resolve(value ?? null);
            },
          }, action.label),
        ),
      ),
    );
    const overlay = h("div", { class: "modal-overlay" }, panel);
    overlay.addEventListener("mousedown", (event) => {
      if (event.target === overlay) {
        close();
        resolve(null);
      }
    });
    function close() {
      overlay.remove();
      document.removeEventListener("keydown", onKey, true);
      previous?.focus?.();
    }
    function onKey(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        resolve(null);
      }
    }
    document.addEventListener("keydown", onKey, true);
    els.modalRoot.hidden = false;
    els.modalRoot.append(overlay);
    bind?.({ finish: (value) => { close(); resolve(value ?? null); } });
    onMount?.();
    const focusable = panel.querySelector("input, textarea, button");
    if (!onMount) focusable?.focus();
    els.modalRoot.toggleAttribute("data-open", true);
    const observer = new MutationObserver(() => {
      if (!els.modalRoot.querySelector(".modal-overlay")) {
        els.modalRoot.removeAttribute("data-open");
        observer.disconnect();
      }
    });
    observer.observe(els.modalRoot, { childList: true });
  });
}

function promptDialog({ title, label, initial = "", placeholder = "", maxLength = 200 }) {
  const input = h("input", { type: "text", value: initial, placeholder, maxlength: maxLength });
  return modal({
    title,
    body: h("label", { class: "field" }, label, input),
    actions: [
      { label: "取消", value: null },
      { label: "确定", value: () => input.value.trim(), primary: true },
    ],
    onMount: () => {
      input.focus();
      input.select();
    },
    width: "26rem",
  });
}

function textDialog({ title, label, initial = "" }) {
  const input = h("textarea", { rows: 6, placeholder: label });
  input.value = initial;
  return modal({
    title,
    body: h("label", { class: "field" }, label, input),
    actions: [
      { label: "取消", value: null },
      { label: "保存", value: () => input.value, primary: true },
    ],
    onMount: () => input.focus(),
    width: "32rem",
  });
}

function confirmDialog({ title, lines, okLabel = "确定", danger = false }) {
  return modal({
    title,
    body: h("div", {}, ...lines.map((line) => h("p", {}, line))),
    actions: [
      { label: "取消", value: null },
      { label: okLabel, value: true, danger },
    ],
    width: "26rem",
  });
}

function pickDialog({ title, label, choices }) {
  const finishRef = { finish: null };
  const list = h(
    "div",
    { class: "pick-list" },
    ...choices.map((choice) =>
      h(
        "button",
        {
          class: "pick-item",
          type: "button",
          onclick: () => finishRef.finish?.(choice.value),
        },
        choice.label,
      ),
    ),
  );
  return modal({
    title,
    body: h("div", {}, h("p", { class: "modal-note" }, label), list),
    actions: [{ label: "取消", value: null }],
    width: "28rem",
    bind: (api) => {
      finishRef.finish = api.finish;
    },
  });
}

function errorDialog({ title, detail, hint }) {
  return modal({
    title,
    body: h(
      "div",
      {},
      h("pre", { class: "error-detail" }, detail.join("\n")),
      hint ? h("p", { class: "modal-note" }, hint) : null,
    ),
    actions: [{ label: "知道了", value: true, primary: true }],
    width: "34rem",
  });
}

/* ------------------------------------------------------------------ 键盘 */

function onKeydown(event) {
  const tag = document.activeElement?.tagName;
  const typing = ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
  if (els.modalRoot.querySelector(".modal-overlay")) {
    if (event.key === "Enter" && tag === "INPUT") {
      event.preventDefault();
      els.modalRoot.querySelector(".modal-actions .btn-primary")?.click();
    }
    return;
  }
  const tree = activeTree();
  if (event.key === "/" && !typing) {
    event.preventDefault();
    els.search.focus();
    return;
  }
  if (event.key === "Escape" && typing && tag === "INPUT" && document.activeElement === els.search) {
    els.search.value = "";
    applySearch("");
    els.search.blur();
    return;
  }
  if (!tree || typing || event.ctrlKey || event.metaKey || event.altKey) return;
  const node = selectedNode();
  if (event.key === "Enter") {
    event.preventDefault();
    addChildPrompt(node?.id ?? tree.root.id);
  } else if (event.key === "Tab") {
    event.preventDefault();
    if (event.shiftKey) {
      const parent = node ? findParent(tree, node.id) : null;
      if (parent) select(parent.id);
    } else {
      const first = node?.children[0] ?? (node === null || node === tree.root ? tree.root.children[0] : null);
      if (first) select(first.id);
      else if (!node) select(tree.root.id);
    }
  } else if (["1", "2", "3"].includes(event.key) && node) {
    setStatus(tree, node.id, STATUSES[Number(event.key) - 1]);
    render();
    saveNow();
  } else if (event.key.toLowerCase() === "d" && node) {
    setStatus(tree, node.id, node.status === "done" ? "todo" : "done");
    render();
    saveNow();
  } else if (event.key.toLowerCase() === "c" && node?.children.length) {
    toggle(node.id);
  } else if (event.key.toLowerCase() === "f2" || event.key.toLowerCase() === "n") {
    if (node) editTitle(node.id);
  } else if (event.key === "Delete" && node) {
    deleteNodePrompt(node.id);
  }
}

/* ------------------------------------------------------------------ 搜索 */

function applySearch(query) {
  const tree = activeTree();
  state.query = query.trim().toLowerCase();
  state.matches = new Set();
  if (!tree || !state.query) {
    render();
    return;
  }
  const walk = (node) => {
    if (node.title.toLowerCase().includes(state.query) || (node.note ?? "").toLowerCase().includes(state.query)) {
      state.matches.add(node.id);
    }
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  const first = [...state.matches][0];
  if (first) {
    let parent = findParent(tree, first);
    while (parent) {
      if (tree.collapsed.includes(parent.id)) toggleCollapsed(tree, parent.id);
      parent = findParent(tree, parent.id);
    }
    state.selectedId = first;
  }
  status(state.matches.size ? `匹配 ${state.matches.size} 个节点` : "没有匹配的节点");
  render();
}

/* ------------------------------------------------------------------ 事件接线 */

function wire() {
  els.treeSelect.addEventListener("change", () => {
    state.library.activeTreeId = els.treeSelect.value;
    state.selectedId = activeTree()?.root.id ?? null;
    state.centerOn = state.selectedId;
    render();
    saveNow();
  });
  els.btnTreeNew.addEventListener("click", newTree);
  els.btnTreeRename.addEventListener("click", renameTree);
  els.btnTreeDelete.addEventListener("click", deleteTree);
  els.btnSample.addEventListener("click", loadSample);
  els.btnEmptySample.addEventListener("click", loadSample);
  els.btnEmptyNew.addEventListener("click", newTree);
  els.btnExport.addEventListener("click", exportLibrary);
  els.btnImport.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", async () => {
    const file = els.importFile.files?.[0];
    if (!file) return;
    try {
      await importFromText(await file.text());
    } catch (cause) {
      toast(`读文件失败：${cause.message}`, "warn");
    } finally {
      els.importFile.value = "";
    }
  });
  els.btnSettings.addEventListener("click", openSettings);
  els.search.addEventListener("input", () => applySearch(els.search.value));
  els.canvas.addEventListener("click", (event) => {
    const toggleTarget = event.target.closest?.("[data-toggle]");
    if (toggleTarget) {
      toggle(toggleTarget.getAttribute("data-toggle"));
      return;
    }
    const nodeTarget = event.target.closest?.("[data-id]");
    if (nodeTarget) select(nodeTarget.getAttribute("data-id"));
  });
  els.canvas.addEventListener("dblclick", (event) => {
    const nodeTarget = event.target.closest?.("[data-id]");
    if (nodeTarget) editTitle(nodeTarget.getAttribute("data-id"));
  });
  document.addEventListener("keydown", onKeydown);
  window.addEventListener("beforeunload", () => {
    if (state.saveTimer) saveNow();
  });
}

/* ------------------------------------------------------------------ 启动 */

export function boot() {
  Object.assign(els, {
    app: $("app"),
    treeSelect: $("tree-select"),
    btnTreeNew: $("btn-tree-new"),
    btnTreeRename: $("btn-tree-rename"),
    btnTreeDelete: $("btn-tree-delete"),
    search: $("search"),
    btnSample: $("btn-sample"),
    btnExport: $("btn-export"),
    btnImport: $("btn-import"),
    importFile: $("import-file"),
    btnSettings: $("btn-settings"),
    aiIndicator: $("ai-indicator"),
    treeTitle: $("tree-title"),
    canvas: $("canvas"),
    emptyState: $("empty-state"),
    btnEmptyNew: $("btn-empty-new"),
    btnEmptySample: $("btn-empty-sample"),
    progressText: $("progress-text"),
    progressRatio: $("progress-ratio"),
    progressFill: $("progress-fill"),
    consistencyNote: $("consistency-note"),
    outline: $("outline"),
    nodeActions: $("node-actions"),
    statusMsg: $("status-msg"),
    modalRoot: $("modal-root"),
    toastRoot: $("toast-root"),
  });
  wire();

  state.backend = browserBackend(window.localStorage);
  const loaded = loadLibrary(state.backend, {});
  state.library = loaded.library ?? emptyLibrary({});
  if (!loaded.ok && loaded.error) {
    els.app.hidden = false;
    toast(loaded.error.message, "warn");
    if (loaded.preserved) status("本地存储读不出来，已按空库打开；原内容还在，未覆盖。");
  }
  if (!state.library.trees.length) {
    els.app.hidden = false;
    render();
    status("新建一棵问题树，或者先载入示例树看看。");
    return;
  }
  state.library.activeTreeId ??= state.library.trees[0].id;
  state.selectedId = activeTree()?.root.id ?? null;
  state.centerOn = state.selectedId;
  render();
  status(`已载入 ${state.library.trees.length} 棵树`);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => boot());
} else {
  boot();
}

export { render, state, applySearch, select, toggle, activeTree, selectedNode };
