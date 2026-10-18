#!/usr/bin/env python3
"""learntree 的假 LLM 服务（标准库实现，零依赖）。

用途有两个：
1. 验收：在没有真 key 的情况下跑通「浏览器 → HTTP → 解析 → 采纳」整条链路；
2. 试用：让你先看清 AI 分解这个交互长什么样。

它不是给真学习用的 —— 返回的子问题是从提问里套出来的模板，不含任何理解。

    python scripts/fake_llm.py --port 8931 [--mode normal|prose|garbage|empty|many|dup|error|slow]

运行期可切档：POST /__mode {"mode": "garbage"}；探针：GET /health。
"""

from __future__ import annotations

import argparse
import json
import re
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

if hasattr(__import__("sys"), "stdout"):
    import sys

    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:  # pragma: no cover - 老版本/被重定向时的兜底
            pass

MODES = ("normal", "prose", "garbage", "empty", "many", "dup", "error", "slow")


class State:
    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.requests: list[dict[str, object]] = []
        self.lock = threading.Lock()


def field(prompt: str, label: str) -> str:
    match = re.search(rf"^{re.escape(label)}(.*)$", prompt, re.MULTILINE)
    return match.group(1).strip() if match else ""


def list_field(prompt: str, label: str) -> list[str]:
    raw = field(prompt, label)
    return [item.strip() for item in re.split(r"[、,，]", raw) if item.strip()]


def subproblems(target: str, existing: list[str], mode: str) -> list[dict[str, str]]:
    if mode == "dup" and existing:
        return [{"title": title, "hint": "与已有子问题重复"} for title in existing[:3]]
    base = [
        (f"{target}：先判断它属于哪一类问题", "把问句改写成可检索的关键词"),
        (f"{target}：最小的可跑例子长什么样", "先造一个 10 行数据的样例"),
        (f"{target}：怎么算「真的搞懂了」", "给自己一个能讲清楚的判据"),
        (f"{target}：三个最常见的误解", "对照社区里的高赞说法"),
        (f"{target}：它依赖哪些前置概念", "卡住就往上一层找"),
    ]
    if mode == "many":
        base = base + [(f"{target}：延伸问题 {index}", "") for index in range(1, 8)]
    if mode == "empty":
        return []
    return [{"title": title, "hint": hint} for title, hint in base[:4]]


def build_content(prompt: str, mode: str) -> str:
    target = field(prompt, "要拆解的问题：") or "这个节点"
    existing = list_field(prompt, "已经拆出来的子问题（不要重复）：")
    items = subproblems(target, existing, mode)
    payload = {"subproblems": items}
    body = json.dumps(payload, ensure_ascii=False)
    if mode == "garbage":
        return f"抱歉，我需要更多信息才能拆解 {target}。"
    if mode == "prose":
        return f"好的，这是针对「{target}」的拆解：\n```json\n{body}\n```\n需要我解释哪一条？"
    return body


class Handler(BaseHTTPRequestHandler):
    state: State  # 由 main() 注入
    protocol_version = "HTTP/1.1"

    def _cors(self, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.send_header("Cache-Control", "no-store")

    def _json(self, payload: dict[str, object], status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._cors(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802 - 名字由 BaseHTTPRequestHandler 决定
        self._cors(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/health"):
            self._json({"ok": True, "mode": self.state.mode, "requests": len(self.state.requests)})
            return
        if self.path.startswith("/last"):
            with self.state.lock:
                last = self.state.requests[-1] if self.state.requests else None
            self._json({"ok": True, "last": last})
            return
        self._json({"error": {"message": "unknown path"}}, 404)

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8", errors="replace") if length else ""
        try:
            payload = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            self._json({"error": {"message": "body 不是合法 JSON"}}, 400)
            return

        if self.path.startswith("/__mode"):
            mode = str(payload.get("mode", ""))
            if mode not in MODES:
                self._json({"ok": False, "error": f"未知档位 {mode}，可选：{', '.join(MODES)}"}, 400)
                return
            self.state.mode = mode
            self._json({"ok": True, "mode": mode})
            return

        if not self.path.endswith("/chat/completions"):
            self._json({"error": {"message": f"假服务只实现 /v1/chat/completions，收到 {self.path}"}}, 404)
            return

        messages = payload.get("messages") or []
        prompt = "\n".join(str(item.get("content", "")) for item in messages if isinstance(item, dict))
        mode = self.state.mode
        record = {
            "path": self.path,
            "model": payload.get("model"),
            "authorization": self.headers.get("Authorization"),
            "content_type": self.headers.get("Content-Type"),
            "response_format": payload.get("response_format"),
            "temperature": payload.get("temperature"),
            "prompt": prompt,
            "at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        }
        with self.state.lock:
            self.state.requests.append(record)

        if mode == "error":
            self._json({"error": {"message": "假服务按 error 档位拒绝服务", "type": "server_error"}}, 500)
            return
        if mode == "slow":
            time.sleep(3.0)

        content = build_content(prompt, mode)
        self._json(
            {
                "id": "chatcmpl-fake-0001",
                "object": "chat.completion",
                "created": int(time.time()),
                "model": payload.get("model") or "fake",
                "choices": [
                    {
                        "index": 0,
                        "message": {"role": "assistant", "content": content},
                        "finish_reason": "stop",
                    }
                ],
                "usage": {"prompt_tokens": len(prompt) // 4, "completion_tokens": len(content) // 4},
                "learntree_echo": {
                    "mode": mode,
                    "authorization": record["authorization"],
                    "response_format": record["response_format"],
                    "target": field(prompt, "要拆解的问题："),
                    "requests": len(self.state.requests),
                },
            }
        )

    def log_message(self, *_args: object) -> None:  # 安静：验收时输出太吵
        return


def main() -> int:
    parser = argparse.ArgumentParser(description="learntree 假 LLM 服务（仅用于验收与试用）")
    parser.add_argument("--port", type=int, default=8931)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--mode", choices=MODES, default="normal")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()

    Handler.state = State(args.mode)
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    banner = (
        f"假 LLM 已启动：http://{args.host}:{args.port}/v1/chat/completions（档位 {args.mode}）\n"
        f"  在 learntree 的「设置」里填：地址 http://{args.host}:{args.port}/v1 ，模型 fake，密钥随便填。\n"
        "  注意：它返回的是模板文字，不代表真实模型的拆解质量。Ctrl+C 停止。"
    )
    print(banner, flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
