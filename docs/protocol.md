# learntree 数据协议 v1

规范来源：`DEVELOPMENT.md` §8。机器可读定义见 `docs/schemas/learntree-v1.schema.json`。
所有时间戳是 UTC ISO-8601 字符串；所有文本是纯文本（渲染时转义，不解析 Markdown）。

## Node

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

| 字段 | 类型 | 约束 |
| --- | --- | --- |
| `id` | string | `n_` + 6 位 `[a-z0-9]`，同一棵树内唯一 |
| `title` | string | 1–200 字，连续空白压成一个空格，纯文本 |
| `note` | string | 可空，用户备注 |
| `status` | enum | `todo` \| `doing` \| `done`，其它值一律拒绝 |
| `source` | enum | `user` \| `ai`（这个节点是谁写的） |
| `hint` | string | 可空，AI 分解给的一句话提示 |
| `children` | Node[] | 数组，**没有 parent 指针**（父子关系靠遍历，避免序列化出现环） |

## Tree

```json
{
  "schemaVersion": 1,
  "id": "t_ab12cd",
  "title": "学会 RAG",
  "createdAt": "2026-09-23T01:00:00.000Z",
  "updatedAt": "2026-09-23T01:20:00.000Z",
  "root": { "id": "n_r00000", "title": "学会 RAG", "status": "todo", "source": "user", "note": "", "hint": "", "children": [] },
  "collapsed": ["n_k3f9x2"]
}
```

`collapsed` 是节点 id 数组，属于视图状态但跟着树走（所以导出到别的机器也会保持折叠形状）。
构造时去重、丢弃非字符串项。

## Library（localStorage 里的东西）

```json
{
  "schemaVersion": 1,
  "trees": [ /* Tree[] */ ],
  "activeTreeId": "t_ab12cd",
  "settings": {
    "llm": { "enabled": false, "baseUrl": "", "model": "", "apiKey": "", "timeoutMs": 20000 },
    "ui": { "showAiBadge": true }
  },
  "createdAt": "2026-09-23T01:00:00.000Z"
}
```

- 存储键：`learntree.library.v1`；
- `trees[].id` 在库内必须唯一（导入冲突时由 `mergeLibrary` 重发 id，并在报告里列出改名）；
- `apiKey` 只存在这里，不会出现在默认导出、日志、prompt 或 `verify_mvp` 输出中。

## Export 文件

```json
{
  "app": "learntree",
  "schemaVersion": 1,
  "exportedAt": "2026-09-23T01:20:00.000Z",
  "treeCount": 3,
  "library": { /* Library */ }
}
```

导入时 `app` / `schemaVersion` / `exportedAt` / `library` 四个字段缺任何一个都**直接拒绝**
并逐条报出错误路径（`app`、`library.trees[1].root.children[0].status` 这种），不猜未知格式。
文件名用**本地日历日**：`learntree-export-2026-09-23.json`。

## 进度口径

```
progress(tree) = done 的叶子数 / 叶子总数          叶子 = children 为空
只有根且根未 done → { done: 0, total: 1, ratio: 0 }
```

- 中间节点标 `done` 而它的叶子没全 `done` 时：**不计入进度**，但会在侧栏给出
  "标记与子树不一致"的提示和可点击的节点名（`findInconsistencies`）。
  只提示，不自动改写用户数据。
- 节点上显示的 `9/31` 是同一口径递归算出来的子树进度。

## AI 契约

请求（OpenAI 兼容 `POST {baseUrl}/chat/completions`）：

```json
{
  "model": "…",
  "messages": [{ "role": "system", "content": "…" }, { "role": "user", "content": "…" }],
  "temperature": 0.4,
  "max_tokens": 900,
  "response_format": { "type": "json_object" }
}
```

user 消息固定包含这几行（也是假服务解析的依据）：

```
学习目标：…
当前所处路径：A › B › C
要拆解的问题：…
补充说明：…                      （可选）
已经拆出来的子问题（不要重复）：X、Y   （可选）
```

期望响应内容：

```json
{"subproblems": [{"title": "…", "hint": "…"}]}
```

解析器额外宽容：Markdown 围栏、前后散文、`children` / `items` 键名、纯字符串数组。
宽容只作用于"能不能读出来"，不作用于"读不出来怎么装"：任何一步说不通都是结构化错误码
（`invalid_json` / `empty_result` / `http_status` / `timeout` / `network` / `not_configured` /
`invalid_response`），并且**树不会被改动**。

## 版本策略

`schemaVersion` 是唯一的版本位。读的时候只认 `1`，将来加字段走"归一化补默认"，
破坏性变更才升版本号并写显式 `migrate()`。不做猜测式兼容。
