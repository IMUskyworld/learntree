/**
 * learntree · 存储层（不碰 DOM，后端以 {getItem,setItem,removeItem} 注入）
 * 规格见 DEVELOPMENT.md §7 / §8.3。
 */

import { SCHEMA_VERSION as TREE_SCHEMA_VERSION, makeId, validateTree } from "./tree.js";

export const APP_ID = "learntree";
export const SCHEMA_VERSION = 1;
export const LIBRARY_KEY = "learntree.library.v1";

export function defaultSettings() {
  return {
    llm: { enabled: false, baseUrl: "", model: "", apiKey: "", timeoutMs: 20000 },
    ui: { showAiBadge: true },
  };
}

export function emptyLibrary(ctx = {}) {
  const now = (ctx.now ?? (() => new Date().toISOString()))();
  return {
    schemaVersion: SCHEMA_VERSION,
    trees: [],
    activeTreeId: null,
    settings: defaultSettings(),
    createdAt: now,
  };
}

/** 测试用：与 localStorage 同形状的内存后端。 */
export function createMemoryBackend(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => {
      data.set(key, String(value));
    },
    removeItem: (key) => {
      data.delete(key);
    },
  };
}

/** 浏览器后端；隐私模式下 localStorage 会直接抛，探测失败就返回 null 让上层降级。 */
export function browserBackend(storage) {
  if (!storage) return null;
  try {
    storage.setItem("__learntree_probe__", "1");
    storage.removeItem("__learntree_probe__");
  } catch {
    return null;
  }
  return {
    getItem: (key) => {
      try {
        return storage.getItem(key);
      } catch {
        return null;
      }
    },
    setItem: (key, value) => storage.setItem(key, value),
    removeItem: (key) => storage.removeItem(key),
  };
}

/* ------------------------------------------------------------------ 校验 */

export function validateLibrary(value) {
  const errors = [];
  if (!value || typeof value !== "object") {
    return { ok: false, errors: [{ path: "", message: "库必须是对象" }] };
  }
  if (value.schemaVersion !== SCHEMA_VERSION) {
    errors.push({ path: "schemaVersion", message: `不支持的版本: ${value.schemaVersion}` });
  }
  if (!Array.isArray(value.trees)) {
    errors.push({ path: "trees", message: "trees 必须是数组" });
  } else {
    const seen = new Set();
    value.trees.forEach((tree, index) => {
      for (const error of validateTree(tree).errors) {
        errors.push({ path: `trees[${index}].${error.path}`, message: error.message });
      }
      if (tree && typeof tree.id === "string") {
        if (seen.has(tree.id)) errors.push({ path: `trees[${index}].id`, message: `树 id 重复: ${tree.id}` });
        seen.add(tree.id);
      }
    });
  }
  if (value.activeTreeId !== undefined && value.activeTreeId !== null && typeof value.activeTreeId !== "string") {
    errors.push({ path: "activeTreeId", message: "activeTreeId 必须是字符串、null 或缺省" });
  }
  const llm = value.settings?.llm;
  if (llm !== undefined) {
    if (!llm || typeof llm !== "object") errors.push({ path: "settings.llm", message: "必须是对象" });
    else {
      for (const field of ["baseUrl", "model", "apiKey"]) {
        if (llm[field] !== undefined && typeof llm[field] !== "string") {
          errors.push({ path: `settings.llm.${field}`, message: "必须是字符串" });
        }
      }
      if (llm.timeoutMs !== undefined && !(Number.isFinite(llm.timeoutMs) && llm.timeoutMs > 0)) {
        errors.push({ path: "settings.llm.timeoutMs", message: "必须是正数毫秒" });
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

/* ------------------------------------------------------------------ 读写 */

/**
 * 读坏了不写盘：宁可当空库开工，也不能把用户可能还能修的数据覆盖掉（§20-4）。
 */
export function loadLibrary(backend, ctx = {}) {
  if (!backend) {
    return {
      ok: false,
      library: emptyLibrary(ctx),
      error: { code: "no_backend", message: "这个浏览器不允许写入本地存储；导出文件是你唯一的备份手段。" },
    };
  }
  let raw;
  try {
    raw = backend.getItem(LIBRARY_KEY);
  } catch (cause) {
    return {
      ok: false,
      library: emptyLibrary(ctx),
      error: { code: "unreadable", message: `读取本地存储失败：${cause?.message ?? cause}` },
    };
  }
  if (raw === null || raw === undefined) return { ok: true, library: emptyLibrary(ctx), created: true };

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    return {
      ok: false,
      library: emptyLibrary(ctx),
      preserved: true,
      error: {
        code: "corrupt_json",
        message: `本地存储不是合法 JSON（${cause.message}）；原内容已保留、未被覆盖。`,
      },
    };
  }
  const check = validateLibrary(parsed);
  if (!check.ok) {
    const tooNew = Number(parsed?.schemaVersion) > SCHEMA_VERSION;
    return {
      ok: false,
      library: emptyLibrary(ctx),
      preserved: true,
      errors: check.errors,
      error: {
        code: tooNew ? "too_new" : "invalid_library",
        message: tooNew
          ? `这份数据由更新的 learntree 写出（v${parsed.schemaVersion}），升级后再打开；原内容未覆盖。`
          : `本地存储内容不合法（${check.errors[0].path}）；原内容未覆盖。`,
      },
    };
  }
  return { ok: true, library: normalizeLibrary(parsed) };
}

export function normalizeLibrary(value) {
  const base = defaultSettings();
  return {
    schemaVersion: SCHEMA_VERSION,
    trees: value.trees.map((tree) => ({
      schemaVersion: TREE_SCHEMA_VERSION,
      id: tree.id,
      title: tree.title,
      createdAt: tree.createdAt,
      updatedAt: tree.updatedAt,
      root: tree.root,
      collapsed: Array.isArray(tree.collapsed) ? tree.collapsed.filter((item) => typeof item === "string") : [],
    })),
    activeTreeId: typeof value.activeTreeId === "string" ? value.activeTreeId : null,
    settings: {
      llm: { ...base.llm, ...(value.settings?.llm ?? {}) },
      ui: { ...base.ui, ...(value.settings?.ui ?? {}) },
    },
    createdAt: typeof value.createdAt === "string" ? value.createdAt : null,
  };
}

export function saveLibrary(library, backend) {
  if (!backend) return { ok: false, error: { code: "no_backend", message: "无法写入本地存储" } };
  const check = validateLibrary(library);
  if (!check.ok) {
    return { ok: false, errors: check.errors, error: { code: "invalid_library", message: "拒绝写入不合法的库" } };
  }
  try {
    backend.setItem(LIBRARY_KEY, JSON.stringify(library));
    return { ok: true };
  } catch (cause) {
    const quota = /quota|exceeded/i.test(`${cause?.name ?? ""} ${cause?.message ?? ""}`);
    return {
      ok: false,
      error: {
        code: quota ? "quota_exceeded" : "unwritable",
        message: quota
          ? "本地存储已满：先导出备份，再删掉不用的树。"
          : `写入本地存储失败：${cause?.message ?? cause}`,
      },
    };
  }
}

/* ------------------------------------------------------------------ 导出 / 导入 */

export function stripSecrets(library) {
  const copy = structuredClone(library);
  if (copy?.settings?.llm) copy.settings.llm.apiKey = "";
  return copy;
}

function localDay(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 文件名按本地日历日：UTC 会让东八区用户在凌晨拿到"昨天"的文件名。 */
export function exportFilename(value) {
  const day = value instanceof Date ? localDay(value) : String(value).slice(0, 10);
  return `learntree-export-${day}.json`;
}

/** 默认剥掉 apiKey —— 导出文件常常会被发到群里或网盘。 */
export function buildExport(library, options = {}) {
  const instant = options.now ?? new Date().toISOString();
  const now = new Date(instant).toISOString();
  const stamp = new Date(instant);
  const payload = {
    app: APP_ID,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: now,
    treeCount: library.trees.length,
    library: options.includeSecrets ? structuredClone(library) : stripSecrets(library),
  };
  return {
    text: JSON.stringify(payload, null, 2),
    filename: exportFilename(stamp),
    carriesSecret: Boolean(payload.library?.settings?.llm?.apiKey),
  };
}

/** 导入只认自描述文件：app / schemaVersion / exportedAt / library 缺一个就拒，不猜。 */
export function parseExport(text) {
  let payload;
  try {
    payload = JSON.parse(String(text ?? ""));
  } catch (cause) {
    return { ok: false, errors: [{ path: "", message: `不是合法 JSON：${cause.message}` }] };
  }
  const errors = [];
  if (!payload || typeof payload !== "object") {
    errors.push({ path: "", message: "顶层必须是对象" });
  } else {
    if (payload.app !== APP_ID) {
      errors.push({
        path: "app",
        message: `这不是 learntree 的导出文件（app=${JSON.stringify(payload.app ?? null)}）`,
      });
    }
    if (payload.schemaVersion !== SCHEMA_VERSION) {
      errors.push({ path: "schemaVersion", message: `不支持的文件版本: ${payload.schemaVersion}` });
    }
    if (typeof payload.exportedAt !== "string" || !payload.exportedAt) {
      errors.push({ path: "exportedAt", message: "缺少导出时间戳" });
    }
    if (payload.library === undefined) {
      errors.push({ path: "library", message: "缺少 library" });
    } else {
      for (const error of validateLibrary(payload.library).errors) {
        errors.push({ path: `library.${error.path}`, message: error.message });
      }
    }
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    library: normalizeLibrary(payload.library),
    meta: { exportedAt: payload.exportedAt, treeCount: payload.library.trees.length },
    carriesSecret: Boolean(payload.library?.settings?.llm?.apiKey),
  };
}

/** 合并导入：同名不同 id 就是两棵树（不去猜），只有 id 真冲突时才重发 id。 */
export function mergeLibrary(target, incoming, options = {}) {
  const ctx = options.ctx ?? {};
  if (options.mode === "replace") {
    const replaced = target.trees.length;
    const library = normalizeLibrary({ ...structuredClone(incoming), settings: incoming.settings });
    return { ok: true, library, report: { added: library.trees.length, replaced, renamed: [] } };
  }
  const taken = new Set(target.trees.map((tree) => tree.id));
  const incoming_ = structuredClone(incoming.trees);
  const renamed = [];
  for (const tree of incoming_) {
    if (taken.has(tree.id)) {
      const from = tree.id;
      tree.id = makeId("t", ctx.rand);
      taken.add(tree.id);
      renamed.push({ from, to: tree.id, title: tree.title });
    } else {
      taken.add(tree.id);
    }
  }
  const merged = normalizeLibrary({
    ...target,
    trees: [...target.trees, ...incoming_],
    activeTreeId: target.activeTreeId ?? (incoming_[0]?.id ?? null),
    settings: target.settings,
  });
  const check = validateLibrary(merged);
  if (!check.ok) {
    return { ok: false, errors: check.errors, library: target, report: null };
  }
  return { ok: true, library: merged, report: { added: incoming_.length, replaced: 0, renamed } };
}
