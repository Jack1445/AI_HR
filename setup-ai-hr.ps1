$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $projectRoot

$pythonCommand = $null
$pythonArgs = @()
$candidates = @(
    @{ Name = 'py'; Arguments = @('-3') },
    @{ Name = 'python'; Arguments = @() }
)
foreach ($candidate in $candidates) {
    $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
    if (!$command) { continue }
    $arguments = $candidate.Arguments
    try {
        $version = & $command.Source @arguments -c 'import sys; print(sys.version_info[0]*100+sys.version_info[1])' 2>$null
        if ($LASTEXITCODE -eq 0 -and $version -match '^\d+$' -and [int]$version -ge 311) {
            $pythonCommand = $command.Source
            $pythonArgs = $arguments
            break
        }
    } catch { }
}
if (!$pythonCommand) { throw '未找到 Python 3.11 或更新版本。请先运行 install-ai-hr.bat。' }

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
if (!$nodeCommand -or !$npmCommand) { throw '未找到 Node.js 或 npm。请先安装 Node.js 20 或更新版本。' }
$nodeVersion = (& node --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw "需要 Node.js 20 或更新版本，当前为 $nodeVersion" }

$venvPython = Join-Path $projectRoot '.venv\Scripts\python.exe'
if (!(Test-Path -LiteralPath $venvPython)) {
    Write-Host '创建 Python 虚拟环境...'
    & $pythonCommand @pythonArgs -m venv .venv
    if ($LASTEXITCODE -ne 0) { throw '创建 Python 虚拟环境失败。' }
}

Write-Host '安装后端依赖...'
& $venvPython -m pip install -e ./backend
if ($LASTEXITCODE -ne 0) { throw '安装后端依赖失败。' }

Write-Host '安装并构建内置 BOSS CLI...'
& $npmCommand.Source ci --prefix boss-cli
if ($LASTEXITCODE -ne 0) { throw '安装 BOSS CLI 依赖失败。' }
& $npmCommand.Source run build --prefix boss-cli
if ($LASTEXITCODE -ne 0) { throw '构建 BOSS CLI 失败。' }

Write-Host '安装并构建前端...'
& $npmCommand.Source ci --prefix frontend
if ($LASTEXITCODE -ne 0) { throw '安装前端依赖失败。' }
& $npmCommand.Source run build --prefix frontend
if ($LASTEXITCODE -ne 0) { throw '构建前端失败。' }

$envFile = Join-Path $projectRoot '.env'
if (!(Test-Path -LiteralPath $envFile)) {
    Copy-Item -LiteralPath (Join-Path $projectRoot '.env.example') -Destination $envFile
    Write-Host '已创建本机 .env 配置。'
}

Write-Host '安装完成。运行 .\start-ai-hr.bat 启动；首次使用 BOSS 时请在浏览器中登录。'
