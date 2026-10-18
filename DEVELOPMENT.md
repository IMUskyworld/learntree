# learntree 开发文档（树状图 AI 学习平台）

> 状态：MVP 规格定稿（2026-09-23）。本文是"合同"：§20 是可执行的完成定义，
> `scripts/verify_mvp.py` 逐条核验它，任何一条不成立就不算完成。

---

## 1. 项目定位

学习一个陌生领域时，困难从来不是一条直线，而是一棵树：
"学会 RAG" → "向量检索" → "embedding 模型怎么选" → "中文 embedding 的分词"……
每个节点卡住都会阻塞整条路径，而大多数人只用一个扁平的 to-do 清单记录这些，
于是**看不出阻塞在哪一层、不知道已经解决了多少、也没人帮你把一个大问题拆开**。

learntree 把学习笔记变成**问题树**：

- 根节点 = 你的学习目标；
- 中间节点 = 拆出来的子问题 / 知识点；
- 叶子节点 = 可以直接动手解决的最小问题；
- 解决一个叶子，树上的进度就亮一块。

AI 在 MVP 里只做一件事：**把一个节点拆成 3–6 个子问题**（`decompose`）。
讲解、出题、诊断卡点都是后续里程碑，MVP 不碰——因为"拆问题"是树状结构唯一的刚需，
其它功能不放进来也能完整用。

一句话定位：**本地优先的问题树笔记本，AI 只负责拆解，不联网也能用。**

与四个已有项目的关系见 §23。

---

## 2. MVP 范围

### 2.1 做

| 能力 | 说明 |
| --- | --- |
| 多棵树 | 一个库（Library）里放多棵问题树，可切换、重命名、删除 |
| 手动建树 | 加子节点、编辑标题/备注、改状态（todo/doing/done）、删除、移动（拖拽不做，用"改父节点"菜单） |
| AI 分解 | 选中节点 → 调 LLM → 预览子问题清单（逐条勾选）→ 采纳插入树 |
| 进度 | 按叶子计算：`done 叶子数 / 总叶子数`，节点上也显示其子树的聚合进度 |
| 本地存储 | localStorage 自动保存；JSON 导出/导入（整库或单树） |
| 渲染 | SVG 树图（横向分层、正交连线）+ 侧栏大纲，节点可折叠 |
| 离线可用 | 不配 LLM 时全部功能可用，AI 按钮置灰并说明原因 |
| 样例 | 内置一棵"学会 RAG"示例树，首次进入一键载入 |

### 2.2 不做（明确排除）

- 不做账号、同步、协作、服务端数据库；
- 不做 Markdown 富文本、图片、附件（标题 + 纯文本备注）；
- 不做拖拽排序、框选、缩放画布（用简单滚动）；
- 不做 AI 讲解/出题/自动诊断（里程碑 2+）；
- 不做插件系统、主题市场；
- 不做 PWA / Service Worker（MVP 阶段引入缓存会让"改了没生效"变成常规坑）。

---

## 3. 目标用户和使用场景

**主用户**：像本项目作者这样的自学者——同时在啃多个技术方向，习惯本地工具，
不喜欢数据上云，希望"打开浏览器就能用，关掉也不丢"。

场景 A（无 AI）：早上打开 `index.html`，看到昨天的 RAG 树，
在"chunk 重叠率"下手动加三个子问题，标一个 done，进度从 43% 到 52%。

场景 B（有 AI）：卡在"怎么评估检索质量"，点"AI 分解"，
得到 5 个子问题（相关性标注、MRR、nDCG、召回率、离线/在线差别），
勾掉不感兴趣的两个，采纳，树自己长了。

场景 C（迁移）：换电脑，导出 `learntree-2026-09-23.json`，导入，全在。

---

## 4. 形态与入口

**纯静态 Web 应用**：手写 HTML/CSS/ES Module，零构建、零依赖、零打包。

入口有两种，都必须是"真的能用"：

1. `python -m http.server 8080` 后访问 `http://127.0.0.1:8080/`（推荐，ES Module 与 fetch 的完整语义）；
2. 直接双击 `index.html`（`file://`）。此模式下 ES Module 会被 CORS 拦截，
   因此 **`index.html` 用 `<script type="module" src="app/ui/app.js">` 的同时，
   必须在加载时检测 `location.protocol === "file:"` 并给出可读的提示页 + 一行启动命令**，
   而不是白屏。这是 §20 的验收项之一。

`package.json` 只有一个字段 `{"type":"module"}`（让 `node --test` 认 ES Module），
没有任何依赖，因此没有 `npm install` 步骤。

---

## 5. 总体架构

```
learntree/
  index.html               外壳：容器 + 引导脚本 + file:// 检测
  app/
    styles.css             全部样式，CSS 变量做主题
    core/
      tree.js              纯函数：节点/树的增删改查、进度、序列化、校验     ← 无 DOM
      render.js            纯函数：layoutTree(tree) + renderTreeSvg(...)→字符串 ← 无 DOM
      storage.js           Library 读写（注入式后端：localStorage / memory）    ← 无 DOM
      ai.js                buildPrompt / parseDecomposition / callLlm(fetch 注入) ← 无 DOM
    ui/
      app.js               唯一的 DOM 层：事件、状态机、渲染挂载、弹窗
  tests/                   node --test，只测 core/*（这正是 core 不碰 DOM 的原因）
  scripts/
    fake_llm.py            假 LLM（stdlib，含 /v1/chat/completions + CORS + OPTIONS）
    llm_proxy.py           本地 CORS 代理（真 endpoint 不开 CORS 时用）
    verify_mvp.py          §20 逐条核验（node --test + 静态完整性 + HTTP 往返 + 浏览器步骤登记）
    check.ps1              质量闸门
  docs/adr/                架构决策记录
  docs/protocol.md         数据协议细节
  .github/workflows/ci.yml node --test + verify_mvp
```

依赖方向：`ui → core`，core 内部 `ai/storage` 互不引用，`ui` 之外没有第二处碰 `document`。
这条规则让 90% 的逻辑在 `node --test` 里就能覆盖，不需要 jsdom（也不引入它）。

### 5.1 模块职责

- **tree.js**：`createNode`, `addChild`, `removeNode`, `findNode`, `findParent`, `moveNode`,
  `setStatus`, `iterate`, `progressOf`（叶子口径）, `subtreeProgress`, `serializeTree`,
  `parseTree`（带 schemaVersion 判定）, `validateTree`（返回结构化错误列表）。
  树以 `{id, title, note, status, source, hint, children: []}` 的普通对象存储，
  **不含 parent 指针**（父子关系靠 `findParent` 查，避免序列化环）。
- **render.js**：`layoutTree(tree, opts)` → `{nodes:[{id,x,y,depth,...}], links:[...], width, height}`；
  `renderTreeSvg(layout, state)` → SVG 字符串。文本必须转义（§15）。
- **storage.js**：`loadLibrary(backend)`, `saveLibrary(lib, backend)`, `migrate`, `exportJson`, `importJson`。
  backend 是 `{getItem, setItem, removeItem}` 形状，测试传 memory 实现。
- **ai.js**：见 §9。

---

## 6. 运行生命周期

1. 启动：`app.js` 读 localStorage → 没有则建空 Library（含设置默认值）；有 `schemaVersion` 不匹配则迁移或拒绝并提示。
2. 首屏：没有树 → 展示"新建树 / 载入示例树"引导。
3. 交互：任何改树操作 → 改内存对象 → `render()` → `saveLibrary()`（防抖 200ms 写盘，但删除/导入等破坏性操作立即写）。
4. AI：`callLlm` → 解析 → 预览弹窗 → 采纳才写树。
5. 失败：LLM 不可达 / JSON 非法 → 保留原树不动，错误原文进可折叠详情，明确告诉用户"未做任何修改"。

---

## 7. 目录与文件协议

无服务端目录结构。落盘只有两处：

- 浏览器 localStorage，键名 `learntree.library.v1`；
- 用户主动导出的文件，默认名 `learntree-<YYYY-MM-DD>.json`。

导出文件必须是**自描述**的：顶层 `{schemaVersion, exportedAt, app:"learntree", library:{...}}`，
导入时校验这三个字段，缺一个就拒绝（不猜）。

---

## 8. 数据协议

### 8.1 Node

```json
{
  "id": "n_k3f9x2",
  "title": "chunk 重叠率怎么定",
  "note": "先看 LangChain 默认 200 的理由",
  "status": "todo",
  "source": "user",
  "hint": "",
  "children": []
}
```

- `id`：`n_` + 6 位小写字母数字，库内唯一，由 `createNode` 生成（可注入随机源以便测试）。
- `title`：必填，1–200 字符，去掉首尾空白，**纯文本**（渲染时转义）。
- `status`：`"todo" | "doing" | "done"`，其它值视为非法。
- `source`：`"user" | "ai"`，标记这个节点是谁写的（界面上 AI 节点带一个小标记）。
- `hint`：AI 分解时给的一句话提示，用户节点一般空。

### 8.2 Tree

```json
{
  "schemaVersion": 1,
  "id": "t_ab12cd",
  "title": "学会 RAG",
  "createdAt": "2026-09-23T01:00:00.000Z",
  "updatedAt": "2026-09-23T01:20:00.000Z",
  "root": { ...Node... },
  "collapsed": ["n_k3f9x2"]
}
```

`collapsed` 记录折叠状态，属于视图而非内容，但跟着树走（导入到别的树名也不影响正确性）。

### 8.3 Library

```json
{
  "schemaVersion": 1,
  "trees": [ ...Tree... ],
  "activeTreeId": "t_ab12cd",
  "settings": {
    "llm": { "baseUrl": "", "model": "", "apiKey": "", "enabled": false }
  }
}
```

- `settings.llm.baseUrl`：OpenAI 兼容地址，如 `http://127.0.0.1:8931/v1`。
- **apiKey 只存在浏览器 localStorage**：不写日志、不进导出文件的默认视图（见 §15），
  导出时若包含 key 必须在文件名外再给一句显式警告，默认导出会剥掉 apiKey。

### 8.4 进度口径

- `progressOf(tree)` = `done 的叶子数 / 叶子总数`（叶子 = `children.length === 0`）。
- 叶子总数为 0（只有根且根无子）时进度为 `0`，根自身 done 记为 `1`。
- `subtreeProgress(node)` 同口径递归，用于节点上的聚合小环。
- 为什么按叶子：**中间节点 done 意味着它的子问题都 done**，重复计数会让进度虚高。
  手动把中间节点标 done 而子节点没完成时，UI 要显示"标记与子树不一致"的警告角标
  （不自动改写用户数据，只提示）。

---

## 9. AI 设计（只做分解）

### 9.1 请求

`callLlm(config, node, context, {fetchImpl, timeoutMs})` → `{ok, items, raw, error}`。

- 端点：`${baseUrl}/chat/completions`，`Authorization: Bearer ${apiKey}`（key 为空则不发这个头）。
- `temperature: 0.4`，`max_tokens: 900`，`response_format: {"type":"json_object"}`
  （不支持该参数的服务会忽略它，不影响我们再做一次容错解析）。
- 超时默认 20s，`AbortController` 实现；超时返回结构化错误 `timeout`。

### 9.2 Prompt（要点）

系统提示固定三句话：你是学习规划助手；只输出 JSON；不要客套。
用户消息带：目标（根标题）、当前路径（从根到该节点的标题链）、该节点已有子节点标题（用于去重）、
节点自身标题/备注、以及硬约束：

```json
{"subproblems":[{"title":"...","hint":"..."}]}
```

- 3–6 条，每条 ≤ 40 字，必须互不相同、且**不得重复已有子节点**，按学习顺序排列，不要解释。

### 9.3 解析（`parseDecomposition`）

必须是**严格的**，也是**容错的**：

1. 剥 ```json 围栏；
2. 截取第一个平衡的 `{...}`；
3. `JSON.parse`；
4. 取 `subproblems`（兼容 `children`/`items` 三个键名，因为不同模型会漂）；
5. 过滤：title 非空、去重（含与现有子节点大小写无关去重）、上限 8 条、超出截断并在结果里标 `truncated`；
6. 任何一步失败 → `{ok:false, error:{code, message, raw}}`，**绝不静默返回空列表当真成功**。

### 9.4 降级

未配置 / `enabled:false` → 按钮置灰 + tooltip 说明去设置页的路径。
网络失败/解析失败 → 弹窗显示错误 + "手动作个记号"的引导（可以手动加子节点），原树不动。

---

## 10. 渲染与布局

`layoutTree`：

- 深度决定 x（`x = depth * (nodeWidth + gapX)`），同层按叶子优先的中序遍历分配 y；
- 父节点 y = 子节点 y 的中点（简单、够看，不追求最优交叉最小化）；
- 折叠节点的子树不布局、不渲染，父节点右侧画 `+N` 徽标；
- 输出 `width/height` 供容器滚动。

`renderTreeSvg`：

- 每个节点一个 `<g class="node" data-id="..." data-status="...">`，内含 rect + 两行截断文本 + 进度环；
- 连线用正交折线 `<path class="link">`；
- 状态用 class 上色（todo 灰 / doing 蓝 / done 绿），**不用颜色单独表意**（另有勾选标记，色盲可用）；
- 文本一律走 `escapeXml`，测试用带 `<script>`、`&`、`"`、中文、emoji 的标题卡住。

---

## 11. UI 交互清单

- 顶栏：树切换下拉、新建、重命名、删除、导出、导入、设置（齿轮）。
- 左：SVG 树（点击选中，双击编辑标题）；下：进度条 + `12/28 叶子已完成`。
- 侧栏大纲：树形列表，可折叠，与 SVG 同步选中。
- 选中节点后的操作条：`+ 子问题`、`AI 分解`、`状态`、`移动父节点`、`删除`（删除有确认 + 显示将一起删掉的节点数）。
- AI 预览弹窗：逐条复选框 + 标题/hint 可就地编辑 + "全部采纳/取消"；采纳前不改树。
- 键盘：`Enter` 新建子节点、`Tab` 深入、`Shift+Tab` 上升、`1/2/3` 切状态、`d` 标 done、`/` 聚焦搜索（搜索仅标题匹配高亮）。
- 撤销：MVP 不做通用 undo，但删除/导入前把上一版本快照进内存，弹窗里给"撤销刚才的操作"一次。

---

## 12. 技术栈

| 层 | 选择 | 理由 |
| --- | --- | --- |
| 运行时 | 浏览器 ES Module | 零构建，源码即产物 |
| 视图 | 手写 DOM + SVG 字符串 | 不需要框架，也避免引入依赖 |
| 状态 | 普通对象 + `render()` 全量重绘 | 树规模小（§16 目标 500 节点），全量重绘够用且没有一致性 bug |
| 存储 | localStorage | 本地优先；导出兜底 |
| AI | fetch + OpenAI 兼容协议 | 不绑厂商 |
| 单测 | `node --test` | Node 22+ 内置，零依赖 |
| 辅助脚本 | Python 3.11 标准库 | 与另三个项目一致，假服务/代理都无需 pip |

版本约束：现代浏览器（Chrome/Edge 110+、Firefox 115+、Safari 16.4+）。
不使用需要构建的语法（无 JSX、无 TS、无装饰器）。Node ≥ 20（`node --test` + `--experimental-test-isolation` 不依赖）。

---

## 13. 配置设计

设置页字段（存 Library.settings）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `llm.enabled` | `false` | 总开关，false 时不发任何网络请求 |
| `llm.baseUrl` | `""` | 例 `http://127.0.0.1:8931/v1` |
| `llm.model` | `""` | 例 `gpt-4o-mini` |
| `llm.apiKey` | `""` | 仅本地；导出默认剥离 |
| `llm.timeoutMs` | `20000` | |
| `ui.showAiBadge` | `true` | 是否给 AI 生成的节点打标记 |

优先级：设置页 > 内置默认。没有 env var（浏览器里没有），
`scripts/fake_llm.py` 的端口通过 `--port` 指定，默认 8931。

---

## 14. 性能要求（软目标）

| 指标 | 目标 | 测量 |
| --- | --- | --- |
| `node --test` 全量 | < 5s | verify_mvp 打印 |
| core 单测冷启动 | < 1.5s | 同上 |
| 200 节点树 `layoutTree` | < 8ms（Node 侧） | `verify_mvp.py` 用 node 微基准 |
| 500 节点 `layoutTree` | < 30ms | 同上 |
| 500 节点 `renderTreeSvg` 字符串生成 | < 40ms | 同上 |
| 首屏（本地 http，无 AI） | < 300ms 可交互 | §24 手工记录（Lighthouse 不引入） |

超出软目标不阻塞发布，但必须写进 §24 的"已知偏差"。

---

## 15. 安全与隐私

1. **XSS**：所有用户输入（标题、备注、树名、错误原文）在 SVG 与 DOM 里都必须转义或用 `textContent`。
   单测 + 浏览器实测各卡一条（标题写 `<img src=x onerror=alert(1)>`，不得弹窗、不得变成节点外的元素）。
2. **API key**：只进 localStorage 和请求头；不进导出文件默认内容、不进 console 日志、
   不进 prompt、不进 verify 脚本输出。README 明确写"公用电脑上请用导出+清空或浏览器无痕"。
3. **不收集**：无埋点、无遥测、无字体/CDN 外链。`index.html` 与所有 css/js **不得出现任何 http(s) 外链资源**，
   这条由 §20 静态完整性检查强制（正则扫 `src=`/`href=`/`url(`）。
4. **AI 数据面**：只发送当前路径 + 目标节点 + 已有子节点标题；不发送整棵树、不发送备注以外的内容。
   设置页写清楚"发送内容示例"按钮，展示将要发的 payload。
5. file:// 模式不静默失败，给出可读提示（§4）。

---

## 16. 测试策略

- **core 单测**（`node --test tests/*.test.js`）：tree / render / ai / storage 四组，纯函数，注入 clock/random/fetch/backend。
- **静态完整性**（verify_mvp）：`index.html` 引用的每个文件存在；无外链资源；无 `import` 未使用路径；CSS 无外部 `url()`。
- **真实 HTTP 往返**（verify_mvp）：起 `scripts/fake_llm.py`（真 socket），用 Node 的 `fetch`
  直接打它，验证 `callLlm` 的 header/body/解析/CORS 预检——**不是 mock，是本机真请求**。
- **浏览器端到端**（browser-use，§24 登记）：起 `python -m http.server`，真点击走完
  建树 → AI 分解（指向 fake_llm）→ 采纳 → 标 done → 进度 → 刷新持久化 → 导出/导入 → XSS 标题。
- 不设覆盖率门槛（无工具链），以 §20 的逐条可执行标准代替。

---

## 17. 里程碑

| 里程碑 | 内容 |
| --- | --- |
| M0（本 MVP） | §2.1 全部 + 单测/静态/HTTP 三层核验 + 浏览器实测 |
| M1 | AI 讲解节点（"这块我不会，讲讲"）、出题自测 |
| M2 | 卡点诊断（根据 done/todo 分布给出下一步建议）、时间戳与复习间隔 |
| M3 | 多树合并/引用（同一知识点跨树共享）、图片附件 |
| M4 | 打包为 PWA / 桌面壳（可选），Obsidian/Markdown 双向 |

---

## 18. 实现顺序

1. 脚手架（index.html/package.json/CI/scripts 占位）
2. `core/tree.js` + 单测
3. `core/render.js` + 单测
4. `core/ai.js` + `core/storage.js` + 单测
5. `ui/app.js` + `styles.css`（先能手动建树跑通）
6. fake_llm / llm_proxy / verify_mvp / check.ps1
7. 浏览器端到端实测，修问题
8. 文档 + ADR + README + §24 回填

---

## 19. 命令速查

```bash
# 打开应用
python -m http.server 8080           # 然后访问 http://127.0.0.1:8080/

# 测试
node --test tests/                   # 或 npm test

# 假 LLM（验收/试用用）
python scripts/fake_llm.py --port 8931

# 真 endpoint 没有 CORS 时
python scripts/llm_proxy.py --port 8932 --upstream https://api.example.com/v1

# 验收
python scripts/verify_mvp.py
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1
```

---

## 20. MVP 完成定义（可执行标准）

`scripts/verify_mvp.py` 必须逐条打印 `PASS/FAIL/SKIP`，全部非 FAIL 才算完成。
每条后面的括号是它的证据来源。

| # | 标准 | 证据 |
| --- | --- | --- |
| 20-1 | core/tree.js 单测全绿：增删改查、子树删除计数、进度按叶子（含空树/只有根/中间节点 done 但子未完成三种边界）、序列化-解析往返、非法 status/schemaVersion 拒绝 | `node --test tests/tree.test.js` |
| 20-2 | core/render.js 单测全绿：布局 x 随深度递增、父 y 为子中点、折叠子树不渲染且给出 `+N`、文本转义（`<script>`/`&`/`"`/emoji）、每个节点带 `data-id` 与 `data-status` | `tests/render.test.js` |
| 20-3 | core/ai.js 单测全绿：围栏 JSON、前后有散文的 JSON、`children`/`items` 别名、非法 JSON → 结构化错误、>8 条截断并标 truncated、与现有子节点去重、超时返回 `timeout` 且不抛出 | `tests/ai.test.js` |
| 20-4 | core/storage.js 单测全绿：memory backend 往返一致、损坏数据（JSON 语法错/字段缺）→ 拒绝并保留原状、导出文件剥离 apiKey、导入无 `app` 字段 → 拒绝 | `tests/storage.test.js` |
| 20-5 | 静态完整性：`index.html`/css/js 引用的所有本地资源存在，且全仓**零外部 http(s) 资源引用**（无 CDN/字体/图片外链） | verify_mvp 扫描 |
| 20-6 | 真 HTTP 往返：起 `scripts/fake_llm.py` 真监听端口，用 Node `fetch` 经 `callLlm` 打通 —— 断言 Authorization 头、`response_format` 存在、返回被解析成 ≥3 条、OPTIONS 预检带 CORS 头 | verify_mvp（node 子进程） |
| 20-7 | AI 未配置时不崩：`enabled:false` 下 `callLlm` 不发请求并返回 `not_configured`；UI 层由 20-11 的浏览器步骤覆盖 | verify_mvp + 单测 |
| 20-8 | file:// 直开不白屏：`index.html` 检测协议并渲染提示 + 启动命令（用 DOM 字符串断言 + 浏览器实测双证） | verify_mvp 静态断言 + §24 |
| 20-9 | 导出/导入往返保真：3 棵含 AI 节点/折叠/状态的树，导出→导入→与原始 `JSON.stringify` 等价（忽略 `exportedAt`） | verify_mvp（node 子进程） |
| 20-10 | XSS 静态防线：对含 `<img src=x onerror=...>` 的标题，`renderTreeSvg` 输出中不出现未转义的 `<img`，且 core 中不存在 `innerHTML =` 直接拼接用户数据的赋值（扫描 `innerHTML` 使用点，白名单制） | verify_mvp 扫描 + 20-2 |
| 20-11 | 浏览器端到端全绿（browser-use 真点击）：载入示例树 → 加子节点 → 配 fake_llm → AI 分解 → 勾选采纳 → 标 done → 进度变化 → 刷新后仍在 → 导出文件下载 → 恶意标题不执行 | §24 逐小步登记，含截图路径 |
| 20-12 | 性能：§14 的 core 基准达标；`node --test` 全量 < 5s | verify_mvp 微基准 |

不满足任何一条 → 不算完成，必须写进 §24"已知偏差"，说明为什么、什么时候补。

---

## 21. 已定稿决策与剩余待确认问题

### 21.1 已定稿（2026-09-23，用户确认）

1. 项目/包名 `learntree`，目录 `C:\code\github小项目\learntree`。
2. 形态：**纯静态 Web 应用**，零构建零依赖，可本地打开、可部署到 Qoder Sites。
3. 主结构：**问题树**（根=学习目标，节点=问题，叶子=可动手的最小问题）。
4. MVP 的 AI 只做**分解节点**；讲解/出题/诊断留给 M1+。
5. 本地优先存储：localStorage + JSON 导入导出，无后端。
6. AI 可选：不配置时全部功能可用（我自己拍的两条之一，与 4 一致）。
7. 真 LLM 若无 CORS，用 `scripts/llm_proxy.py` 本地代理（浏览器直连需 CORS）。

### 21.2 剩余待确认（不阻塞）

- 是否需要中文/英文双语 UI（MVP 只做中文，留 CSS/i18n 余地但不实现）；
- 移动父节点用菜单还是未来的拖拽（MVP 菜单）；
- 是否在 README 里放截图 GIF（需要真实浏览器截图，可能顺手加）。

---

## 22. 开发约束（继承前四个项目的实测教训）

1. **PowerShell 闸门必须写 `-NoProfile -ExecutionPolicy Bypass`**（faillab 事故 F-0001：本机默认策略拦 `-File`）。
2. **Windows 控制台是 cp936**：Python 脚本开头 `sys.stdout.reconfigure(encoding="utf-8", errors="replace")`；
   子进程输出按 UTF-8 → GBK → replace 顺序解码；测试里跑子进程时必须把 `PYTHONIOENCODING` 剥掉再断言严格 UTF-8
   （envdoctor §25 回归教训）。
3. **不要依赖 CWD**：所有路径相对仓库根拼（envdoctor 22-6 因 per-check cwd 未创建而 `NotADirectoryError` 崩过）。
4. **不要假设管道是 TTY**：非交互时不弹输入、不ANSI刷屏。
5. **判定必须三态**：能证明/不能证明/证据不足要区分（faillab F-0002/F-0003 教训：命令没跑起来 ≠ 问题已修复）。
   映射到本项目：**LLM 返回空列表/解析失败 ≠ "这个节点不需要拆"**。
6. **不引入 npm 依赖**（零依赖是卖点，也是 §20-5 的硬约束）。
7. **中文路径**：本仓库根路径含中文，任何脚本不得把路径拼进需要 shell 解析的命令行字符串；用 `subprocess` 列表参数。

---

## 23. 与其它项目的关系

- labbox（实验记录）、envdoctor（环境诊断）、labloop（实验编排）、faillab（失败归档）都是 CLI/服务端工具；
  learntree 是第一个**前端形态**的项目，也是第一个"输入是人脑中的困惑"而不是"输入是机器证据"的。
- 潜在联动：faillab 的一条事故可以手动变成 learntree 的一个问题节点（"为什么 PowerShell 拦了我的脚本"），
  解决后标 done。MVP 不做自动导入（避免跨仓依赖），但在 `docs/` 里留一份手工映射说明。
- 部署：本仓库其它项目没有可部署产物；learntree 若用户点头，可用 Qoder Sites 发布静态站（不做默认动作）。

---

## 24. 实现状态（MVP 完成定义逐条核验）

> 本节在实现过程中回填。空表 = 未开始。

### 24.1 逐条核验（§20）

核验时间 2026-09-23，本机 Windows 10.0.26200 / node v24.20.0 / Python 3.11.9。
`python scripts/verify_mvp.py` 输出 **12 PASS / 1 SKIP / 0 FAIL**（SKIP 即 20-11，见下）。

| # | 状态 | 证据 |
| --- | --- | --- |
| 20-1 | ☑ PASS | `node --test tests/tree.test.js` 29 用例 0.15s：叶子口径进度（只有根 / 中间节点 done 但子未完成 / 全 done）、删除返回子树规模、moveNode 四种禁止、序列化往返、schemaVersion 与重复 id 拒绝 |
| 20-2 | ☑ PASS | `tests/render.test.js` 23 用例 0.15s：x 随深度线性、父 y = 子中点、折叠子树不渲染且 `+N`、`data-id/status/depth/source`、转义、选中/命中 class、大纲与 SVG 折叠一致 |
| 20-3 | ☑ PASS | `tests/ai.test.js` 25 用例 0.24s：围栏/散文/字符串数组/三种键名、>上限截断标 truncated、与已有子问题去重、全撞报 `empty_result`、超时 `timeout` 且 signal 真 abort |
| 20-4 | ☑ PASS | `tests/storage.test.js` 22 用例：内存后端往返保真、坏 JSON/坏结构/更新版本一律拒绝且**不回写覆盖**、导出默认剥 key、缺 `app` 字段拒收、合并 id 冲突重发 |
| 20-5 | ☑ PASS | verify_mvp 扫描：index.html 的 2 个本地引用存在、6 个 js 模块 import 全部可解析、CSS 无 `url()`、全仓 0 个外部 http(s) 资源引用 |
| 20-6 | ☑ PASS | 真起 `scripts/fake_llm.py` 占端口：OPTIONS 预检 204 + `Access-Control-Allow-Origin: *`；Node 真 `fetch` 经 `callLlm` 往返 46ms 解析 4 条；服务端自报收到 `Bearer sk-probe-123456` 与 `response_format`，且 prompt 里没有 key；切 6 档坏回复 → `invalid_json/empty_result/empty_result/ok/ok/http_status`；slow 档 + 300ms → `timeout` |
| 20-6b | ☑ PASS | `scripts/llm_proxy.py` 以假服务为上游：转发 200、响应带 CORS 头、`callLlm` 经代理拿到 ≥3 条（全程未访问外网）；2026-10-18 加严：断言假服务实际收到的路径恰为 `/v1/chat/completions`（防 `/v1/v1` 回归） |
| 20-7 | ☑ PASS | `enabled:false` / 缺 baseUrl / 缺模型名 三种形态都返回 `not_configured` 且**发出 0 个请求**；UI 侧见 20-11 的"按钮置灰 + tooltip" |
| 20-8 | ☑ PASS | 静态断言 + 浏览器实测：`file://` 打开时提示页可见、`#app` 计算样式 `display:none`、页面里 0 个 module 脚本、提示含可照抄的 `python -m http.server 8080` |
| 20-9 | ☑ PASS | 3 棵树 / 59 行内容指纹导出→导入后逐字相等，折叠与 AI 来源标记保真，`activeTreeId` 保持，外来 `app` 字段文件被拒 |
| 20-10 | ☑ PASS | 恶意标题/note/hint 渲染后 `offenders=[]`、无裸 `<img`/`<script`；全项目 `.innerHTML =` 恰好 1 处且带 `innerHTML-ok` 标记 |
| 20-11 | ☑ 实测（脚本外） | 见下面 §24.6 的浏览器逐小步记录（browser-use 真点）。verify_mvp 里这一条固定打印 SKIP，因为脚本不自动开浏览器 |
| 20-12 | ☑ PASS | layout200=1.27ms / layout500=1.44ms / render200=2.26ms / render500=3.76ms，全部低于 §14 软目标（8/30/12/40ms）；`node --test` 全量 99 用例 < 0.5s |

### 24.6 浏览器端到端实录（20-11，browser-use + Chrome，真点击）

服务：`python -m http.server 8099`（应用）+ `python scripts/fake_llm.py --port 8931`（假 LLM）。

| 小步 | 结果 |
| --- | --- |
| 打开 `http://127.0.0.1:8099/` | 空状态引导出现（新建 / 载入示例），顶栏、大纲、进度条齐全 |
| 点「载入示例树」 | 43 节点、38 可见（折叠 5）、进度 9/31=29%，AI 节点带 `AI` 标，折叠节点显示 `+5` |
| 点「设置」→ 勾启用 → 填 `http://127.0.0.1:8931/v1` / `fake-llm` / 假 key | 预览区实时显示 `POST …/chat/completions` + 打码后的 `Bearer sk-f…only` + 完整 body，并写明"约 560 字节、只发送路径与当前节点" |
| 选中「评估」→ 点「AI 分解」 | 弹窗列出 4 条，可逐条勾选、标题就地可改；取消 1 条、改写 1 条后采纳 |
| 采纳 | 大纲 38→41 行，进度 9/31→9/34，toast「采纳 3 个子问题」，新节点带 AI 标记 |
| 选中叶子按 `d` / `2` | 进度 9/34→10/34；状态符 ○→◐（非颜色可辨识） |
| 「改标题」写入 `<img src=x onerror="window.__xss()">` | 图上原样显示为文本，画布 innerHTML 中无裸 `<img`，注入的 `__xss()` **未被调用** |
| 刷新页面 | 树、进度 10/34、AI 配置全部从 localStorage 恢复（5657B） |
| 点「导出」（拦截真实 Blob） | 文件名 `learntree-export-<本地日>.json`，顶层键 `app/schemaVersion/exportedAt/treeCount/library`，**文件里没有 key**，baseUrl/model 保留 |
| 导入外来 JSON（DataTransfer 喂真 File 对象） | 弹「导入被拒绝」，逐条列出 `app：…` `library.activeTreeId：…`，树数不变（1→1） |
| 导入合法导出件 → 选「合并进当前库」 | 1→3 棵树，同名不同 id 视为两棵树，toast「导入完成：新增 2 棵树」 |
| 折叠「检索」 | 大纲 41→35 行，SVG 与大纲同时显示 `+6` |
| 搜索「重叠」 | 命中 1 个节点并自动展开祖先、选中并高亮，状态栏「匹配 1 个节点」 |
| 删除节点 → 点「撤销」 | 节点消失后一键回来，toast「已撤销」 |
| 新建 / 重命名 / 切换 / 删除整棵树 + 撤销 | 4 棵树间切换正常，删除确认文案含节点数（47），撤销恢复 |
| 直接双击打开 `file:///…/learntree/index.html` | 显示可读提示页（含启动命令），`#app` 计算样式 `display:none`，页面里 0 个 module 脚本 |
| AI 失败路径（把假服务切到 garbage 档） | 弹「AI 分解失败」：`invalid_json` + 原文 + "你的树没有被修改"，节点数与进度逐项不变 |

**这一轮实测揪出并修掉的 4 个真 bug**（纯单测都发现不了）：

1. `decomposeDialog` 把 `modal()` 的 Promise 包断了一层 —— 点「采纳」永远没反应（弹窗会关，树不涨）。
2. `[hidden]` 被 `.app { display: grid }` 覆盖 —— `file://` 提示页下面漏出半截界面。
3. 导出文件名用 UTC 日期 —— 东八区凌晨导出会写成"昨天"。
4. 节点文字宽度超出节点盒（标题 15 字 / 备注 24 字对中文太宽），且 SVG 坐标在早期版本里是 `NaN`（padding 被加了两次）。
5. `callLlm` 忽略了设置里的 `llm.timeoutMs`，只认调用方传参 —— 由 §20-6 的 slow 档超时用例抓到。

### 24.2 性能实测（§14 目标对照）

| 指标 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| `node --test` 全量 | < 5s | 99 用例 ≈ 0.3s | 达标 |
| core 单测冷启动 | < 1.5s | 0.14–0.28s / 文件 | 达标 |
| 200 节点 `layoutTree` | < 8ms | 1.2–2.7ms | 达标 |
| 500 节点 `layoutTree` | < 30ms | 1.3–1.8ms | 达标 |
| 500 节点 `renderTreeSvg` | < 40ms | 3.2–4.4ms（SVG ≈ 286KB） | 达标 |
| 真 HTTP 往返（假服务，本机） | 不设目标 | 46–52ms | 记录用 |
| 首屏可交互（本机 http） | < 300ms | 未测（不引入 Lighthouse，见 §24.4） | 未覆盖 |

### 24.3 本机无法执行 / 需外部条件

| 项 | 需要谁 | 备注 |
| --- | --- | --- |
| 真 LLM 的拆解质量 | 用户填 key | 2026-10-18 已用 DeepSeek 抽测一轮（§24.7）；样本小，其它厂商/模型仍未验证 |
| 首屏性能与 Lighthouse | 谁在意谁跑 | MVP 不引入工具链，见 §24.4 |
| 公网部署（Qoder Sites / 任意静态托管） | 用户点头 | 纯静态，`index.html` + `app/` 直接可发 |
| git init + 首次提交 | 用户点头 | 本仓库 2026-10-18 已完成（`main`，首个提交 `515ecc4`）；其余四个项目待用户点头 |
| 非 Chromium 内核（Firefox/Safari）实测 | 有机器的人 | 本机只有 Edge/Chrome；SVG 与 ES Module 都是标准用法 |

### 24.5 已知的产品局限（诚实清单）

1. **AI 拆解质量只抽测过一轮真模型**：2026-10-18 用 DeepSeek（deepseek-chat）经本地代理实测，
   直连与浏览器全流程各走了一遍，都可用（§24.7）；但样本很小、其它厂商/模型未验证，
   hint 的长期实用性也待观察。更早的全部证据来自假服务 —— 它只能证明链路通，不代表内容质量。
2. 布局是"叶子占行 + 父居中"的朴素算法，宽树（同层 >20 子）会很高，没有做交叉最小化。
3. 没有通用 undo：只有删除/整库导入前的一次性快照。
4. 没有移动端适配调优（<900px 只做了不崩的堆叠布局）。
5. 搜索只匹配标题和备注，不做拼音/模糊。
6. 折叠状态存在树对象里（`collapsed`），所以它会跟着导出文件走 —— 换设备会带过去，这是有意的取舍。

### 24.4 与规格书的已知偏差（诚实性记录）

| 偏差 | 原因 | 处理 |
| --- | --- | --- |
| §20-11 在 verify_mvp 里永远是 SKIP | 脚本不自动开浏览器，不用别的手段冒充 | 由 §24.6 的手工实测登记兜证据 |
| §14 的"首屏 < 300ms"未测 | 引入 Lighthouse 就等于引入工具链，违背零依赖 | 记为未覆盖，M1 再决定 |
| 多了一个 `20-6b llm_proxy` 检查项 | 代理脚本是 AI 可用的前提，值得单独验 | 已并入验收输出 |
| §11 的"移动父节点"用弹窗列表而非菜单 | 列表在深树上更好点，也不用先做右键菜单 | 视为实现细节 |
| `index.html` 里的模块脚本是注入的 | `file://` 下必须根本不去加载，静态标签做不到 | §20-8 的静态断言按这个形状写 |

---

### 24.7 真模型实测（DeepSeek，2026-10-18）

> 补 §24.3 / §24.5-1 的空白：首次用真 key（`deepseek-chat`，经 `scripts/llm_proxy.py`）跑通，
> 覆盖直连、代理、浏览器三层。结论：协议兼容、失败路径正确、拆解质量可用；
> 并因此抓到并修掉一个真 bug（见下）。样本很小，不代表所有厂商/模型。

| 层 | 实测 | 结果 |
| --- | --- | --- |
| 直连 | `callLlm` 拆「评估」与一个叶子节点 | 各 6 条、约 2.3s；与已有子节点零文本重复；baseUrl 不带 `/v1` 也能自动补齐 |
| 直连 | 错密钥 / 1ms 超时 | 结构化 `http_status(401)` / `timeout`，不装成功、不抛异常 |
| 代理 | `llm_proxy.py --upstream https://api.deepseek.com/v1` | 修复后 2.3s / 6 条（修复前真 API 404，见下） |
| 浏览器 | 设置 → AI 分解「评估」→ 取消 1 条 → 采纳 5 条 → `d` 标完成 → 刷新 → 导出 | `9/31 → 9/36 → 10/36`、48 节点、AI 配置与状态全部持久化；导出文件 `apiKey:""`；网络面板 `OPTIONS 204 + POST 200` 均经本地代理 |

**抓到的 bug 与修复**：`llm_proxy.py` 直接拼接 `upstream + 请求路径`，而应用固定请求
`/v1/chat/completions`；按文档把上游写成 `.../v1` 会转发成 `/v1/v1/chat/completions`，真 API 返回 404。
假服务只校验路径以后缀结尾，所以 20-6b 此前是假阴性（协议"通"但真端点是 404）。修复：上游以 `/v1`
结尾时剥掉请求路径里重复的 `/v1`；并在 20-6b 增加"假服务实际收到的路径必须恰为
`/v1/chat/completions`"的回归断言。

**仍未验证的**：其它厂商（OpenAI 及各类兼容网关）、更大样本的拆解质量、hint 的长期实用性。

---

## 25. 变更记录

| 日期 | 内容 |
| --- | --- |
| 2026-09-23 | 规格定稿，MVP 完成定义 12 条 |
| 2026-09-23 | MVP 实现完成：core 四模块 + UI + 假 LLM/CORS 代理 + 验收脚本；99 个单测、`verify_mvp` 12 PASS / 1 SKIP / 0 FAIL |
| 2026-09-23 | 浏览器端到端实测（§24.6）修掉 5 个单测抓不到的 bug：AI 预览弹窗 Promise 断链、`[hidden]` 被 `display:grid` 覆盖、导出文件名用了 UTC 日、节点文字溢出节点盒、`callLlm` 忽略设置里的 `timeoutMs` |
| 2026-09-23 | 补 §24.1–§24.6、README、三份 ADR、`docs/protocol.md`、`docs/schemas/learntree-v1.schema.json`、`docs/known-deviations.md` |
| 2026-10-18 | 真模型（DeepSeek）实测：直连/代理/浏览器三级通过；修复 `llm_proxy.py` 上游带 `/v1` 时拼成 `/v1/v1/...` 导致真 API 404 的 bug，20-6b 增加路径回归断言；回填 §24.7，更新 §24.1/§24.3/§24.5 |
| 2026-10-18 | `git init`（`main`）+ 首次提交 `515ecc4`（30 文件 / 7544 行）；作者身份写在仓库局部配置，未动全局 |
