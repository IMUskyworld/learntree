# learntree 本地质量闸门：推之前跑这个。
# 用法:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/check.ps1
#
# 必须带 -ExecutionPolicy Bypass：本机默认执行策略会拦 -File（faillab 事故 F-0001）。
# 本项目零 npm 依赖，所以闸门里没有 install / build 步骤 —— 有依赖就说明跑偏了。
# 本文件存成 UTF-8 with BOM：Windows PowerShell 5.1 否则会把中文按 GBK 解码而解析失败。

param(
    [switch]$SkipAudit
)

$ErrorActionPreference = 'Stop'
# 让重定向到文件/CI 的日志是 UTF-8，而不是 GBK
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$script:failed = $null

function Step($name, $body) {
    Write-Host ""
    Write-Host "==> $name" -ForegroundColor Cyan
    $script:lastExit = 0
    try {
        & $body | Out-Host
        $script:lastExit = $LASTEXITCODE
    } catch {
        $script:lastExit = 1
        Write-Host "x $name 抛异常：$_" -ForegroundColor Red
    }
    if ($script:lastExit -ne 0) {
        Write-Host ""
        Write-Host "x 闸门停在：$name" -ForegroundColor Red
        exit $script:lastExit
    }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host "x 找不到 node（需要 Node 20+）" -ForegroundColor Red
    exit 1
}
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
    Write-Host "x 找不到 python（需要 Python 3.11+，只用标准库）" -ForegroundColor Red
    exit 1
}

Step "node --check 语法" {
    $files = Get-ChildItem -Recurse -Path app, scripts, tests -Include *.js, *.mjs
    foreach ($file in $files) {
        node --check $file.FullName
        if ($LASTEXITCODE -ne 0) { break }
    }
    Write-Host "    $($files.Count) 个 js/mjs 文件语法通过"
}

Step "python 语法编译" {
    python -m compileall -q scripts
}

Step "换行符（仓库内必须 LF）" {
    $bad = @()
    $files = Get-ChildItem -Recurse -Path . -Include *.js, *.mjs, *.css, *.html, *.json, *.md, *.py, *.ps1, *.yml
    foreach ($file in $files) {
        if ($file.FullName -match '\\(\.verify-tmp|__pycache__|node_modules|\.git)\\') { continue }
        $bytes = [System.IO.File]::ReadAllBytes($file.FullName)
        for ($i = 0; $i -lt $bytes.Length - 1; $i++) {
            if ($bytes[$i] -eq 13 -and $bytes[$i + 1] -eq 10) { $bad += $file.Name; break }
        }
    }
    if ($bad.Count -gt 0) {
        Write-Host "    含 CRLF 的文件：$($bad -join ', ')"
        exit 1
    }
    Write-Host "    $($files.Count) 个文件全部 LF"
}

Step "零依赖（不许有 node_modules / package-lock）" {
    foreach ($name in @('node_modules', 'package-lock.json', 'yarn.lock')) {
        if (Test-Path $name) {
            Write-Host "    发现了 $name —— 本项目的第一原则是零依赖"
            exit 1
        }
    }
    $pkg = (Get-Content package.json -Raw -Encoding UTF8) | ConvertFrom-Json
    if ($pkg.dependencies -or $pkg.'devDependencies') {
        Write-Host "    package.json 里出现了依赖表"
        exit 1
    }
    Write-Host "    package.json 无依赖，仓库无锁文件"
}

Step "unit tests (node --test)" {
    # 不要加路径/glob：Windows 的 shell 不展开通配符、Node 20 不认 glob 字面量（见 ci.yml）
    node --test
}

if ($SkipAudit) {
    Write-Host ""
    Write-Host "    （已跳过 §20 验收：-SkipAudit）" -ForegroundColor DarkGray
} else {
    Step "MVP 验收 (§20)" {
        python scripts/verify_mvp.py
    }
}

Write-Host ""
Write-Host "all checks passed" -ForegroundColor Green
