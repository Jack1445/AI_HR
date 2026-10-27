param(
    [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
$backendDir = Join-Path $projectRoot "backend"
$frontendDir = Join-Path $projectRoot "frontend"
$pythonExe = Join-Path $projectRoot ".venv\Scripts\python.exe"
$frontendPort = 5173
$backendPort = 8000
$backendVersion = "0.4.4"
$chromeCandidates = @(
    (Join-Path ${env:LOCALAPPDATA} "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles} "Google\Chrome\Application\chrome.exe"),
    (Join-Path ${env:ProgramFiles(x86)} "Google\Chrome\Application\chrome.exe")
)
$chromePath = $chromeCandidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

function Get-ListeningProcessIds {
    param([int]$Port)

    $connections = @()
    try { $connections = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop) } catch {}

    $activeProcessIds = @()
    foreach ($connection in $connections) {
        $processId = [int]$connection.OwningProcess
        if ($processId -le 0) {
            continue
        }
        if (Get-Process -Id $processId -ErrorAction SilentlyContinue) {
            $activeProcessIds += $processId
        }
    }

    if ($activeProcessIds.Count -eq 0) {
        $netstatLines = @(netstat.exe -ano -p tcp 2>$null | Select-String -Pattern "LISTENING")
        foreach ($line in $netstatLines) {
            if ($line.Line -match "\s+(?:0\.0\.0\.0|127\.0\.0\.1|\[::\]|::):$Port\s+\S+\s+LISTENING\s+(\d+)\s*$") {
                $activeProcessIds += [int]$Matches[1]
            }
        }
    }
    return @($activeProcessIds | Select-Object -Unique)
}

function Test-ListeningPort {
    param([int]$Port)

    return @(Get-ListeningProcessIds -Port $Port).Count -gt 0
}

function Wait-ForHttp {
    param(
        [string]$Url,
        [int]$TimeoutSeconds = 40
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Wait-ForBackend {
    param([int]$TimeoutSeconds = 40)

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        try {
            $response = Invoke-RestMethod -Uri "http://127.0.0.1:$backendPort/api/health" -TimeoutSec 3
            if ($response.status -eq "ok" -and $response.version -eq $backendVersion) {
                return $true
            }
        }
        catch {
            Start-Sleep -Milliseconds 500
        }
        Start-Sleep -Milliseconds 300
    } while ((Get-Date) -lt $deadline)

    return $false
}

function Stop-PreviousAiHrWindows {
    $titlePrefixes = @("AI Recruiter Backend*", "AI Recruiter Frontend*")
    foreach ($prefix in $titlePrefixes) {
        $oldWindows = Get-Process -Name cmd -ErrorAction SilentlyContinue |
            Where-Object { $_.MainWindowTitle -like $prefix }
        foreach ($oldWindow in $oldWindows) {
            Write-Host "关闭旧服务窗口：$($oldWindow.MainWindowTitle)"
            $previousErrorAction = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            & taskkill.exe /PID $oldWindow.Id /T /F 2>$null | Out-Null
            $ErrorActionPreference = $previousErrorAction
        }
    }
    Start-Sleep -Milliseconds 700
}

function Stop-ListeningProcess {
    param([int]$Port)

    # Uvicorn --reload creates a child worker. Kill the complete process tree and
    # re-check a few times so the child cannot immediately reclaim the port.
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
        $listeners = @(Get-ListeningProcessIds -Port $Port)

        if ($listeners.Count -eq 0) {
            return
        }

        foreach ($processId in $listeners) {
            if ($processId -le 0) {
                continue
            }
            Write-Host "关闭占用端口 $Port 的进程树：PID $processId"
            & cmd.exe /d /c "taskkill.exe /PID $processId /T /F >nul 2>&1"
            $killExitCode = $LASTEXITCODE
            Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue
            if ($killExitCode -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
                Write-Host "无法结束仍存在的 PID $processId，可能需要以管理员身份运行入口脚本"
            }
        }
        Start-Sleep -Milliseconds 900
    }
}

if (!(Test-Path -LiteralPath $pythonExe)) {
    throw "找不到项目虚拟环境：$pythonExe`n请先运行：.\.venv\Scripts\python.exe -m venv .venv"
}

if (!(Test-Path -LiteralPath (Join-Path $frontendDir "node_modules"))) {
    throw "前端依赖尚未安装。请先运行：Set-Location frontend; npm install"
}

Stop-PreviousAiHrWindows
Stop-ListeningProcess $backendPort
Stop-ListeningProcess $frontendPort

if ($chromePath) {
    $env:CHROME_PATH = $chromePath
    Write-Host "Chrome 路径：$chromePath"
}
else {
    Write-Host "未找到 Chrome，将使用系统默认浏览器打开网页。"
}

$envFile = Join-Path $projectRoot ".env"
if (!(Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $projectRoot ".env.example") -Destination $envFile
    Write-Host "已创建 .env 配置文件。"
}

if (Test-ListeningPort $backendPort) {
    $blockedPids = @(Get-ListeningProcessIds -Port $backendPort)
    $blockedText = if ($blockedPids.Count -gt 0) { $blockedPids -join ", " } else { "未知" }
    throw "后端端口 $backendPort 清理失败，仍被 PID $blockedText 占用。请以管理员身份重新双击入口脚本。"
}
$backendCommand = "title AI Recruiter Backend && `"$pythonExe`" -m uvicorn app.main:app --app-dir backend --port $backendPort"
Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/k", $backendCommand) `
    -WorkingDirectory $projectRoot
Write-Host "后端启动中：http://localhost:$backendPort"

if (Test-ListeningPort $frontendPort) {
    $blockedPids = @(Get-ListeningProcessIds -Port $frontendPort)
    $blockedText = if ($blockedPids.Count -gt 0) { $blockedPids -join ", " } else { "未知" }
    throw "前端端口 $frontendPort 清理失败，仍被 PID $blockedText 占用。请以管理员身份重新双击入口脚本。"
}
$frontendCommand = "title AI Recruiter Frontend && npm run dev -- --host 127.0.0.1"
Start-Process `
    -FilePath "cmd.exe" `
    -ArgumentList @("/k", $frontendCommand) `
    -WorkingDirectory $frontendDir
Write-Host "前端启动中：http://localhost:$frontendPort"

if (!(Wait-ForBackend)) {
    throw "后端未启动到当前版本 v$backendVersion；可能仍有旧进程占用端口 $backendPort。请查看后端窗口中的错误信息。"
}

if (!(Wait-ForHttp "http://127.0.0.1:$frontendPort")) {
    throw "前端在规定时间内没有启动。请查看前端窗口中的错误信息。"
}

Write-Host "AI Recruiter 已启动。"
Write-Host "网页入口：http://localhost:$frontendPort"

if (!$NoBrowser) {
    if ($chromePath) {
        Start-Process -FilePath $chromePath -ArgumentList @("--new-window", "http://localhost:$frontendPort")
    }
    else {
        Start-Process "http://localhost:$frontendPort"
    }
}
