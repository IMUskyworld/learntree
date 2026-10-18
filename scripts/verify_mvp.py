#!/usr/bin/env python3
"""learntree · MVP 完成定义逐条核验（DEVELOPMENT.md §20）。

    python scripts/verify_mvp.py [--skip-tests] [--keep-open]

每条标准打印 PASS / SKIP / FAIL，最后给一行总计。退出码：全绿 0，有 FAIL 1。
20-11（浏览器端到端）不在这里自动化 —— 它由 browser-use 手工实测并登记在 §24.1，
本脚本把它标成 SKIP 并把登记状态读出来提示，绝不用别的手段冒充它通过了。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TMP = ROOT / ".verify-tmp"

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:  # pragma: no cover
        pass

RESULTS: list[tuple[str, str, str]] = []

# §14 软目标（毫秒）
PERF_TARGETS = {"layout200": 8.0, "layout500": 30.0, "render200": 12.0, "render500": 40.0}


def record(status: str, name: str, detail: str = "") -> None:
    RESULTS.append((status, name, detail))
    print(f"{status:4} {name:34} {detail}")


def run(cmd: list[str], cwd: Path = ROOT, timeout: float = 180.0) -> subprocess.CompletedProcess[str]:
    env = dict(subprocess.os.environ)
    env["PYTHONIOENCODING"] = "utf-8"
    env["FORCE_COLOR"] = "0"
    return subprocess.run(  # noqa: S603 - 参数永远是列表，不经过 shell
        cmd,
        cwd=str(cwd),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
    )


def node() -> str:
    found = shutil.which("node") or shutil.which("node.exe")
    if not found:
        raise RuntimeError("PATH 里找不到 node（需要 Node 20+）")
    return found


def probe(name: str, *args: str, timeout: float = 120.0) -> dict[str, object]:
    proc = run([node(), str(ROOT / "scripts" / "verify" / "probes.mjs"), name, *args], timeout=timeout)
    line = (proc.stdout or "").strip().splitlines()[-1] if (proc.stdout or "").strip() else ""
    try:
        payload = json.loads(line)
    except json.JSONDecodeError:
        raise RuntimeError(f"探针 {name} 没有输出 JSON：{proc.stdout[:200]} {proc.stderr[:200]}") from None
    if not payload.get("ok"):
        raise RuntimeError(f"探针 {name} 失败：{payload.get('error')}")
    return payload


def unit(file: str) -> tuple[str, str]:
    proc = run([node(), "--test", str(ROOT / "tests" / file)], timeout=180)
    text = proc.stdout + proc.stderr
    passed = int(re.search(r"ℹ pass (\d+)", text).group(1)) if re.search(r"ℹ pass (\d+)", text) else 0
    failed = int(re.search(r"ℹ fail (\d+)", text).group(1)) if re.search(r"ℹ fail (\d+)", text) else 0
    ms = re.search(r"ℹ duration_ms ([\d.]+)", text)
    timing = f"{float(ms.group(1)) / 1000:.2f}s" if ms else "?"
    if proc.returncode != 0 or failed:
        first = next((line for line in text.splitlines() if line.strip().startswith("✖")), "")
        return "FAIL", f"{failed} 个用例失败（{timing}）{first[:160]}"
    return "PASS", f"{passed} 个用例全绿（{timing}）"


# ------------------------------------------------------------------ 静态完整性


def local_refs(html: str) -> list[str]:
    out = []
    for match in re.finditer(r'(?:src|href)\s*=\s*"([^"]+)"', html):
        value = match.group(1).strip()
        if value.startswith(("data:", "#", "mailto:")):
            continue
        out.append(value)
    for match in re.finditer(r'(?:s\.src|href)\s*=\s*"((?:app|scripts|docs)/[^"]+)"', html):
        out.append(match.group(1))
    return sorted(set(out))


def check_static_integrity() -> tuple[str, str]:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    missing = [ref for ref in local_refs(html) if not (ROOT / ref.split("#")[0].split("?")[0]).exists()]
    external = [ref for ref in local_refs(html) if ref.startswith(("http://", "https://", "//"))]

    js_files = sorted((ROOT / "app").rglob("*.js")) + sorted((ROOT / "app").rglob("*.mjs"))
    unresolved: list[str] = []
    remote_js: list[str] = []
    for js in js_files:
        text = js.read_text(encoding="utf-8")
        for match in re.finditer(r'from\s+"(\./[^"]+|\.\./[^"]+)"', text):
            target = (js.parent / match.group(1)).resolve()
            if not target.exists():
                unresolved.append(f"{js.relative_to(ROOT)} -> {match.group(1)}")
        remote_js += [line.strip() for line in text.splitlines() if re.search(r'(import|require)\s*\(?\s*["\']https?://', line)]

    css = (ROOT / "app" / "styles.css").read_text(encoding="utf-8")
    css_urls = re.findall(r"url\(\s*['\"]?([^)'\"]+)", css)
    css_external = [item for item in css_urls if item.startswith(("http:", "https:", "//", "data:"))]
    css_missing = [
        item
        for item in css_urls
        if not item.startswith(("http:", "https:", "//", "data:"))
        and not (ROOT / "app" / item.lstrip("./")).exists()
    ]

    problems = []
    if missing:
        problems.append(f"HTML 引用不存在：{missing}")
    if unresolved:
        problems.append(f"JS import 找不到文件：{unresolved}")
    if external or remote_js:
        problems.append(f"存在外部资源引用（零依赖约束被破）：{external + remote_js}")
    if css_external:
        problems.append(f"CSS 引了外部字体/图片：{css_external}")
    if css_missing:
        problems.append(f"CSS url() 指向不存在的文件：{css_missing}")
    if problems:
        return "FAIL", "；".join(problems)
    return (
        "PASS",
        f"{len(local_refs(html))} 个本地引用齐全、{len(js_files)} 个 js 模块 import 可解析、0 个外链资源",
    )


def check_file_guard() -> tuple[str, str]:
    html = (ROOT / "index.html").read_text(encoding="utf-8")
    guard = re.search(r'location\.protocol\s*===?\s*"file:"', html)
    notice = re.search(r'id="file-notice"', html)
    module = re.search(r's\.src\s*=\s*"app/ui/app\.js"', html)
    classic_before = html.find("location.protocol")
    module_before = html.find('type="module" src=')
    if not (guard and notice and module):
        return "FAIL", "index.html 里缺少 file:// 检测 / 提示块 / 受控的模块注入"
    if module_before != -1 and module_before < classic_before:
        return "FAIL", "静态 module 标签在守卫之前就加载了，file:// 下仍会白屏"
    if "python -m http.server" not in html:
        return "FAIL", "提示里没有可直接照抄的启动命令"
    return "PASS", "file:// 会显示可操作的提示页（含启动命令），模块脚本只在非 file 分支注入"


def check_innerhtml_whitelist() -> tuple[str, str]:
    offenders = []
    total = 0
    for js in sorted((ROOT / "app").rglob("*.js")):
        for number, line in enumerate(js.read_text(encoding="utf-8").splitlines(), 1):
            if not re.search(r"\.innerHTML\s*=[^=]", line):
                continue
            total += 1
            if "innerHTML-ok" not in line:
                offenders.append(f"{js.relative_to(ROOT)}:{number}")
    if offenders:
        return "FAIL", f"未登记的 innerHTML 赋值：{offenders}"
    if total != 1:
        return "FAIL", f"innerHTML 赋值点应为 1 处，实际 {total} 处（§15 的收敛前提）"
    return "PASS", f"全项目 {total} 处 innerHTML 赋值，均已登记（SVG 挂载点）"


# ------------------------------------------------------------------ 假 LLM 服务


def wait_port(host: str, port: int, deadline: float) -> None:
    while time.time() < deadline:
        try:
            with socket.create_connection((host, port), timeout=0.4):
                return
        except OSError:
            time.sleep(0.08)
    raise RuntimeError(f"假 LLM 没能在 {host}:{port} 起来")


def free_port() -> int:
    """别写死 8931：上一轮没关干净的假服务会让验收莫名其妙地红。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def http_json(url: str, payload: dict | None = None, method: str | None = None, timeout: float = 12.0):
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"))
    if data:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - 只打本机端口
            return response.status, dict(response.headers), response.read().decode("utf-8", "replace")
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read().decode("utf-8", "replace")


def check_fake_llm_roundtrip() -> tuple[str, str]:
    port = free_port()
    host = "127.0.0.1"
    base = f"http://{host}:{port}/v1"
    server = subprocess.Popen(  # noqa: S603
        [sys.executable, str(ROOT / "scripts" / "fake_llm.py"), "--port", str(port), "--mode", "normal"],
        cwd=str(ROOT),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    try:
        wait_port(host, port, time.time() + 10)
        # 1) CORS 预检必须能过，否则浏览器直连就是死路
        status, headers, _ = http_json(f"{base}/chat/completions", method="OPTIONS")
        if status != 204 or headers.get("Access-Control-Allow-Origin") != "*":
            return "FAIL", f"OPTIONS 预检异常：status={status} headers={headers}"
        # 2) 真 fetch → callLlm → 解析
        good = probe("http", base)
        if int(good.get("items", 0)) < 3:
            return "FAIL", f"只解析出 {good.get('items')} 条子问题"
        if good.get("authorizationSeen") != "Bearer sk-probe-123456":
            return "FAIL", f"服务端没看到正确的 Authorization 头：{good.get('authorizationSeen')}"
        if not good.get("responseFormatSeen"):
            return "FAIL", "服务端没收到 response_format"
        if good.get("promptLeaksKey"):
            return "FAIL", "密钥漏进了 prompt 正文"
        if not good.get("promptHasPath"):
            return "FAIL", "prompt 里没带上路径上下文"
        # 3) 各种坏回复都要落成结构化错误，而不是"看起来成功了"
        seen_modes = []
        for mode, expected in [
            ("garbage", "invalid_json"),
            ("empty", "empty_result"),
            ("dup", "empty_result"),
            ("many", "ok"),
            ("prose", "ok"),
            ("error", "http_status"),
        ]:
            set_status, _, body = http_json(f"{base.rsplit('/v1', 1)[0]}/__mode", {"mode": mode})
            if set_status != 200:
                return "FAIL", f"切档 {mode} 失败：{body}"
            result = probe("http", base, expected)
            if expected == "ok" and int(result.get("items", 0)) < 1:
                return "FAIL", f"{mode} 档位解析不出条目"
            seen_modes.append(f"{mode}→{result.get('code') or 'ok'}")
        # 4) slow 档位 + 300ms 超时 → timeout
        http_json(f"{base.rsplit('/v1', 1)[0]}/__mode", {"mode": "slow"})
        timed = probe("http", base, "timeout", "300")
        if timed.get("code") != "timeout":
            return "FAIL", f"慢响应应当超时，实际 {timed}"
        return (
            "PASS",
            f"真 HTTP 往返 {good.get('ms')}ms/{good.get('items')} 条；坏回复 {' '.join(seen_modes)}；超时→timeout",
        )
    except Exception as cause:  # noqa: BLE001 - 验收脚本要把任何异常收成一行 FAIL
        return "FAIL", f"{type(cause).__name__}: {cause}"
    finally:
        server.terminate()
        try:
            server.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover
            server.kill()


def check_proxy_script() -> tuple[str, str]:
    """代理脚本自身可起、可转发、带 CORS —— 用假服务当上游，不碰外网。

    2026-10-18 加严：上游带 /v1 时，转发路径不得拼成 /v1/v1/...（真 API 会 404；
    假服务只校验后缀，之前这条是假阴性）。
    """
    fake_port, port = free_port(), free_port()
    host = "127.0.0.1"
    fake = subprocess.Popen(  # noqa: S603
        [sys.executable, str(ROOT / "scripts" / "fake_llm.py"), "--port", str(fake_port)],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    proxy = subprocess.Popen(  # noqa: S603
        [
            sys.executable,
            str(ROOT / "scripts" / "llm_proxy.py"),
            "--port",
            str(port),
            "--upstream",
            f"http://127.0.0.1:{fake_port}/v1",
        ],
        cwd=str(ROOT),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        wait_port(host, port, time.time() + 10)
        status, headers, body = http_json(
            f"http://{host}:{port}/v1/chat/completions",
            {
                "model": "proxy-model",
                "messages": [{"role": "user", "content": "要拆解的问题：代理能不能转"}],
            },
        )
        if status != 200:
            return "FAIL", f"代理转发返回 {status}：{body[:160]}"
        if headers.get("Access-Control-Allow-Origin") != "*":
            return "FAIL", "代理响应没带 CORS 头"
        payload = json.loads(body)
        if not payload.get("choices"):
            return "FAIL", f"代理响应体不像 chat.completion：{body[:160]}"
        result = probe("http", f"http://{host}:{port}/v1")
        if int(result.get("items", 0)) < 3:
            return "FAIL", "callLlm 经代理拿不到 3 条以上子问题"
        # 回归（2026-10-18）：上游带 /v1 时，请求路径里的 /v1 必须被剥掉一层，
        # 否则真 API 收到 /v1/v1/chat/completions 会 404（假服务此前照收，发现不了）。
        _, _, last_body = http_json(f"http://{host}:{fake_port}/last")
        last_path = json.loads(last_body).get("last", {}).get("path")
        if last_path != "/v1/chat/completions":
            return "FAIL", f"代理转发路径为 {last_path!r}，应为 '/v1/chat/completions'（上游带 /v1 被拼成 /v1/v1/...）"
        return "PASS", "本机代理转发 + CORS 头 + callLlm 经代理往返成功（未访问外网）；上游带 /v1 时不重复拼接"
    except Exception as cause:  # noqa: BLE001
        return "FAIL", f"{type(cause).__name__}: {cause}"
    finally:
        for process in (proxy, fake):
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:  # pragma: no cover
                process.kill()


def check_browser_evidence() -> tuple[str, str]:
    """20-11 只能由真实浏览器实测盖章；这里读 §24.1 的登记，绝不自己冒充。"""
    spec = ROOT / "DEVELOPMENT.md"
    if not spec.exists():
        return "SKIP", "还没有 DEVELOPMENT.md"
    text = spec.read_text(encoding="utf-8")
    # 只看 §24.1 之后的登记表，否则会命中 §20 里那条标准本身的描述文字。
    tail = text.split("### 24.1", 1)
    section = tail[1] if len(tail) > 1 else ""
    row = re.search(r"^\|\s*20-11\s*\|(.*)\|", section, re.MULTILINE)
    cell = row.group(1).strip() if row else ""
    done = "☑" in cell or "PASS" in cell
    if done:
        return "SKIP", "浏览器端到端已由 §24.1 手工实测登记（本脚本不自动开浏览器）"
    return "SKIP", "待 §24.1 用 browser-use 真点一遍后登记；自动化侧无法代替"


def check_perf() -> tuple[str, str]:
    payload = probe("perf")
    slow = []
    for key, limit in PERF_TARGETS.items():
        value = float(payload.get(key, 9999))
        if value > limit:
            slow.append(f"{key}={value}ms>{limit}ms")
    detail = " ".join(f"{key}={payload.get(key)}ms" for key in PERF_TARGETS)
    sizes = f"（节点数 {payload.get('nodes200')}/{payload.get('nodes500')}，SVG {payload.get('bytes500')}B/500节点）"
    if slow:
        return "FAIL", f"超出 §14 软目标：{', '.join(slow)} {detail}"
    return "PASS", f"{detail}{sizes}，全部低于 §14 软目标"


# ------------------------------------------------------------------ 主流程


def guard(name: str, action) -> None:
    """任何一条标准内部炸了都要变成 FAIL，而不是把整个验收脚本带崩。"""
    try:
        status, detail = action()
    except Exception as cause:  # noqa: BLE001
        status, detail = "FAIL", f"{type(cause).__name__}: {cause}"
    record(status, name, detail)


def run_unit(file: str) -> tuple[str, str]:
    return unit(file)


def degrade_check() -> tuple[str, str]:
    payload = probe("degrade")
    if payload.get("fetchCalls") != 0:
        return "FAIL", f"未配置时仍发了 {payload.get('fetchCalls')} 个请求"
    codes = {key: payload[key]["code"] for key in ("disabled", "noUrl", "noModel")}
    return "PASS", f"三种缺配置形态都降级为 not_configured，0 次网络请求：{codes}"


def roundtrip_check() -> tuple[str, str]:
    payload = probe("roundtrip")
    return (
        "PASS",
        f"{payload['trees']} 棵树 / {payload['nodes']} 行指纹一致；导出默认无密钥={not payload['keyInExport']}；"
        f"折叠保真={payload['collapsedPreserved']}；拒收外来文件={payload['rejectsForeignApp']}",
    )


def xss_check() -> tuple[str, str]:
    payload = probe("xss", str(ROOT))
    inner, inner_detail = check_innerhtml_whitelist()
    if payload.get("offenders") or payload.get("rawImg") or payload.get("rawScript"):
        return "FAIL", f"有用户数据逃成了标签：{payload}"
    if inner != "PASS":
        return "FAIL", inner_detail
    return "PASS", f"恶意标题/note/hint 无一逃逸；{inner_detail}"


def main() -> int:
    parser = argparse.ArgumentParser(description="learntree MVP 验收")
    parser.add_argument("--skip-tests", action="store_true", help="跳过 node --test（check.ps1 已单独跑过）")
    args = parser.parse_args()

    TMP.mkdir(parents=True, exist_ok=True)
    print(f"learntree · §20 验收（{ROOT}）")
    print(f"node={shutil.which('node') or '未找到'} python={sys.version.split()[0]}")

    unit_checks = [
        ("20-1 tree", "tree.test.js"),
        ("20-2 render", "render.test.js"),
        ("20-3 ai", "ai.test.js"),
        ("20-4 storage", "storage.test.js"),
    ]
    for name, file in unit_checks:
        if args.skip_tests:
            record("SKIP", name, "check.ps1 已单独跑过 node --test")
        else:
            guard(name, lambda file=file: run_unit(file))

    guard("20-5 static_integrity", check_static_integrity)
    guard("20-6 fake_llm_http", check_fake_llm_roundtrip)
    guard("20-6b llm_proxy", check_proxy_script)
    guard("20-7 ai_unconfigured", degrade_check)
    guard("20-8 file_protocol", check_file_guard)
    guard("20-9 export_import_roundtrip", roundtrip_check)
    guard("20-10 xss_defense", xss_check)
    guard("20-11 browser_e2e", check_browser_evidence)
    guard("20-12 perf", check_perf)

    shutil.rmtree(TMP, ignore_errors=True)

    passed = sum(1 for status, _, _ in RESULTS if status == "PASS")
    skipped = sum(1 for status, _, _ in RESULTS if status == "SKIP")
    failed = sum(1 for status, _, _ in RESULTS if status == "FAIL")
    print()
    print(f"{passed} PASS / {skipped} SKIP / {failed} FAIL")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
