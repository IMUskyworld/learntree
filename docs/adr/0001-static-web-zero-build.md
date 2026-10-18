# ADR-0001：纯静态 Web 应用，零构建、零依赖

- 状态：已接受（2026-09-23）
- 相关：`DEVELOPMENT.md` §4 / §12 / §20-5

## 背景

learntree 的形态有三个候选：CLI + HTML 报告（前四个项目的路子）、带前端的桌面应用、
纯静态 Web 应用。用户明确选了「纯静态 Web 应用」，理由是这个产品的价值一半在交互上
（点节点、折叠、看进度亮起来），CLI 撑不住；另一半是"随时能打开"，
装 Python 包 + 起服务 + 记命令的门槛太高。

## 决策

手写 HTML / CSS / ES Module，**不引入任何构建工具和 npm 依赖**：

- 没有 `package-lock.json`、没有 `node_modules`，`package.json` 只有 `{"type":"module"}`；
- 没有 TypeScript、没有框架、没有打包器；源码即产物，仓库里是什么浏览器就跑什么；
- 逻辑放在 `app/core/*.js` 的纯函数里，用 Node 内置的 `node --test` 测；
- DOM 只允许出现在 `app/ui/app.js` 一个文件里。

## 后果

**正面**

- 打开成本 = 一个静态文件服务器（`python -m http.server`），甚至可以整仓丢进任何静态托管；
- 没有依赖漂移、没有 lockfile 冲突、没有"我这能跑你那不能"；
- CI 只有两步：`node --test` + `python scripts/verify_mvp.py`，两个平台各 30 秒；
- 审计面极小：`check.ps1` 里有一条专门检查"不许出现 node_modules / 锁文件 / 依赖表"。

**负面与应对**

| 代价 | 应对 |
| --- | --- |
| ES Module 在 `file://` 下被 CORS 拒绝，双击打不开 | 引导脚本用 classic script 判断协议，`file://` 显示可操作的提示页（§20-8 有静态与浏览器双证据） |
| 没有类型检查 | 核心函数全部纯函数 + 入参归一化（`normalizeNode/normalizeTree`），非法数据在校验层就被结构化拒绝 |
| 没有打包 = 手写 DOM 很啰嗦 | 一个 `h()` 帮助函数 + 唯一一处 `innerHTML`（SVG 挂载点，白名单强制） |
| 没有框架，状态全量重绘 | 树规模小（§14 目标 500 节点，实测 500 节点渲染 2–4ms），全量重绘反而没有一致性 bug |

## 备选方案

- **Vite + 框架**：开发体验好，但"零依赖"这个卖点直接没了，且验收脚本要装 node_modules；
- **Tauri/Electron 桌面**：分发成本高，MVP 阶段不值；
- **单文件 HTML（内联全部 JS）**：能双击打开，但代码不可维护、也没法用 `node --test` 测核心。
  M4 可以考虑把它作为"额外产物"，而不是开发形态。
