/**
 * 内置示例树（DEVELOPMENT.md §2.1「样例」）。
 * 用紧凑规格描述，build() 负责展开成合法 Node —— 这样示例数据本身也走同一套校验。
 *
 * 规格字段：t=title, s=status, h=hint, n=note, a=AI 来源, children=子节点
 */

import { createTree } from "./tree.js";

const RAG = {
  title: "学会 RAG",
  rootNote: "目标：能给一个小知识库做出可评估的检索增强问答",
  collapsed: ["切分策略"],
  children: [
    {
      t: "文档入库",
      s: "doing",
      children: [
        {
          t: "解析：PDF/HTML/Markdown 各自的坑",
          children: [
            { t: "扫描件 PDF 要不要先 OCR", s: "done" },
            { t: "HTML 的导航栏怎么在解析阶段丢掉", s: "done" },
            { t: "表格在纯文本里怎么保住结构", h: "试试 markdown 化 + 保留表头" },
          ],
        },
        {
          t: "切分策略",
          children: [
            { t: "chunk 大小按字符还是按 token", s: "done" },
            { t: "重叠率（overlap）设多少、为什么", s: "done" },
            { t: "按标题层级递归切分 vs 固定窗口", h: "LangChain 的 RecursiveCharacterTextSplitter" },
            { t: "中文句子边界怎么判", a: true },
            { t: "表格和代码块要不要单独成块", a: true },
          ],
        },
        {
          t: "元数据设计",
          children: [
            { t: "来源、章节、时间戳分别存哪里", s: "doing" },
            { t: "过滤检索怎么用元数据缩小范围", h: "先过滤再算相似度，成本差别很大" },
          ],
        },
      ],
    },
    {
      t: "向量化",
      children: [
        {
          t: "embedding 模型选型",
          children: [
            { t: "中文场景下 BGE / m3e / OpenAI 的差别", s: "done" },
            { t: "MTEB 榜单能信多少", h: "注意评测集与自己的语料分布差异" },
            { t: "维度越高一定越好吗", a: true },
          ],
        },
        { t: "query 与 doc 用同一个向量空间吗", h: "非对称检索要不要加前缀" },
        { t: "长文档超过 512 token 怎么截断不丢关键信息", a: true },
        { t: "向量归一化与余弦/内积的关系", s: "done" },
      ],
    },
    {
      t: "检索",
      children: [
        {
          t: "索引结构",
          children: [
            { t: "HNSW 的参数 M / efConstruction 在调什么", s: "done" },
            { t: "IVF-PQ 什么时候比 HNSW 划算", h: "内存预算和召回的取舍" },
            { t: "千万级向量要不要上分布式", a: true },
          ],
        },
        { t: "混合检索：BM25 + 向量怎么融合分数", h: "RRF 是个便宜的起点", s: "doing" },
        { t: "重排序（rerank）值不值得加延迟", a: true },
      ],
    },
    {
      t: "生成",
      children: [
        { t: "上下文里怎么放引用标记", s: "done" },
        { t: "检索内容冲突时提示词如何要求模型拒答", a: true },
        { t: "上下文超长时压缩还是截断", h: "先量一下实际分布" },
      ],
    },
    {
      t: "评估",
      note: "目前最卡的一层：不知道从哪测起",
      children: [
        { t: "标注一批「问题 → 相关段落」的gold数据", s: "todo" },
        { t: "Recall@k / MRR / nDCG 分别回答什么问题", a: true },
        { t: "端到端答案质量与检索指标的相关性", h: "别只看检索指标" },
        { t: "离线评估与线上真实提问的差距", a: true },
      ],
    },
    {
      t: "工程与运维",
      children: [
        { t: "文档更新后向量索引的增量重建", s: "done" },
        { t: "缓存哪一层：embedding、检索还是答案", a: true },
        { t: "怎么防止一次脏数据把索引整体带偏", h: "入库前的 schema 校验 + 抽样人检" },
      ],
    },
  ],
};

const NOTE_TO_PUBLISH = {
  title: "把这三个月的学习笔记整理成博客",
  collapsed: [],
  children: [
    { t: "盘点有哪些值得写", children: [
      { t: "列出踩过的坑清单", s: "done" },
      { t: "哪些坑是别人已经写烂了的", s: "done" },
      { t: "只剩我自己视角的题目", a: true },
    ] },
    { t: "写作工具链", children: [
      { t: "图床与截图怎么办", s: "doing" },
      { t: "代码高亮与主题", h: "静态站生成器自带就够" },
    ] },
    { t: "发布与反馈", children: [
      { t: "标题怎么写得不像教程", a: true },
      { t: "要不要留反馈入口", s: "todo" },
    ] },
  ],
};

const EMPTY_TEMPLATE = {
  title: "（空树模板）从一句困惑开始",
  children: [{ t: "我到底想搞明白什么", h: "把困惑写成一个可判断真假的问句" }],
};

function flatten(spec) {
  return {
    title: spec.t,
    status: spec.s ?? "todo",
    source: spec.a ? "ai" : "user",
    hint: spec.h ?? "",
    note: spec.n ?? "",
    children: (spec.children ?? []).map((child) => flatten(child)),
  };
}

function buildSpec(spec, ctx) {
  const tree = createTree(
    {
      title: spec.title,
      root: {
        title: spec.title,
        note: spec.rootNote ?? "",
        children: spec.children.map((child) => flatten(child)),
      },
      collapsed: spec.collapsed ?? [],
    },
    ctx,
  );
  return titleCollapseToIds(tree, spec.collapsed ?? []);
}
/**
 * collapsed 在规格里用标题书写（便于人读），落库要换成 id。
 */
function titleCollapseToIds(tree, titles) {
  if (!titles.length) return tree;
  const wanted = new Set(titles);
  const ids = [];
  const walk = (node) => {
    if (wanted.has(node.title)) ids.push(node.id);
    for (const child of node.children) walk(child);
  };
  walk(tree.root);
  tree.collapsed = ids;
  return tree;
}

export function sampleTreeSpecs() {
  return [RAG, NOTE_TO_PUBLISH, EMPTY_TEMPLATE];
}

/** 返回三棵合法树：主示例 + 一个短树 + 一个近乎空的模板。 */
export function sampleTrees(ctx = {}) {
  return [buildSpec(RAG, ctx), buildSpec(NOTE_TO_PUBLISH, ctx), buildSpec(EMPTY_TEMPLATE, ctx)];
}

export function primarySampleTree(ctx = {}) {
  return buildSpec(RAG, ctx);
}
