#!/usr/bin/env python3
"""learntree 的本地 CORS 代理：给不肯开 CORS 的真 LLM 用。

浏览器直连第三方 OpenAI 兼容端点会被 CORS 拦住，这个脚本在你本机收一圈，
把请求原样转发到 --upstream，再把响应带 CORS 头吐回来。

    python scripts/llm_proxy.py --port 8932 --upstream https://api.example.com/v1
    # 然后在 learntree 设置里把地址填成 http://127.0.0.1:8932/v1

--upstream 带不带尾部 /v1 都可以：带 /v1 时会剥掉请求路径里重复的 /v1，
避免拼成 /v1/v1/chat/completions（真 API 会 404；2026-10-18 DeepSeek 实测发现并修复）。

密钥仍然只从你的浏览器经过这个进程，不落盘、不写日志（日志只记状态码和字节数）。
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass

HOP_BY_HOP = {"host", "connection", "keep-alive", "content-length", "accept-encoding", "origin", "referer"}


class Handler(BaseHTTPRequestHandler):
    upstream: str = ""
    timeout: float = 60.0
    protocol_version = "HTTP/1.1"

    def _cors(self, status: int = 200) -> None:
        self.send_response(status)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "authorization, content-type")
        self.send_header("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")

    def _emit(self, status: int, body: bytes, content_type: str) -> None:
        self._cors(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # noqa: N802
        self._cors(204)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path.startswith("/health"):
            self._emit(200, json.dumps({"ok": True, "upstream": self.upstream}).encode(), "application/json")
            return
        self.forward("GET", b"")

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        self.forward("POST", self.rfile.read(length) if length else b"")

    def forward(self, method: str, body: bytes) -> None:
        base = self.upstream.rstrip("/")
        path = self.path
        # 应用侧固定请求 /v1/chat/completions；--upstream 若已带 /v1，直接拼接会变成
        # /v1/v1/chat/completions（真 API 返回 404）。这里剥掉重复的一层前缀。
        if base.endswith("/v1") and path.startswith("/v1/"):
            path = path[len("/v1") :]
        target = base + path
        request = urllib.request.Request(target, data=body if body else None, method=method)
        for name, value in self.headers.items():
            if name.lower() not in HOP_BY_HOP:
                request.add_header(name, value)
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:  # noqa: S310 - 地址由用户显式给定
                payload = response.read()
                self._emit(response.status, payload, response.headers.get("Content-Type", "application/json"))
                print(f"{method} {self.path} -> {response.status} ({len(payload)}B)", flush=True)
        except urllib.error.HTTPError as error:
            payload = error.read()
            self._emit(error.code, payload, error.headers.get("Content-Type", "application/json"))
            print(f"{method} {self.path} -> {error.code} ({len(payload)}B)", file=sys.stderr, flush=True)
        except Exception as error:  # 网络层失败也要让浏览器拿到结构化响应
            payload = json.dumps(
                {"error": {"message": f"本地代理转发失败：{type(error).__name__}: {error}", "type": "proxy_error"}}
            ).encode("utf-8")
            self._emit(502, payload, "application/json")
            print(f"{method} {self.path} -> 502 {error}", file=sys.stderr, flush=True)

    def log_message(self, *_args: object) -> None:
        return


def main() -> int:
    parser = argparse.ArgumentParser(description="learntree 本地 CORS 代理")
    parser.add_argument("--port", type=int, default=8932)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--upstream", required=True, help="例如 https://api.example.com/v1")
    parser.add_argument("--timeout", type=float, default=60.0)
    args = parser.parse_args()

    if not args.upstream.startswith(("http://", "https://")):
        print("--upstream 必须是 http(s) 地址", file=sys.stderr)
        return 2

    Handler.upstream = args.upstream.rstrip("/")
    Handler.timeout = args.timeout
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(
        f"CORS 代理：http://{args.host}:{args.port}/v1/* -> {Handler.upstream}/*\n"
        f"  在 learntree 设置里把地址填 http://{args.host}:{args.port}/v1\n"
        "  密钥只在内存里过一遍，不写日志。Ctrl+C 停止。",
        flush=True,
    )
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
