param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath $PSScriptRoot).Path
Set-Location -LiteralPath $projectRoot

function Refresh-CommandPath {
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User')
}

function Get-UsablePython {
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
                return $version
            }
        } catch { }
    }
    return $null
}

function Get-UsableNode {
    if (!(Get-Command node -ErrorAction SilentlyContinue) -or !(Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        return $null
    }
    $version = (& node --version).Trim()
    if ($LASTEXITCODE -eq 0 -and $version -match '^v(\d+)\.' -and [int]$Matches[1] -ge 20) { return $version }
    return $null
}

function Get-ChromePath {
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
    )
    return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Install-MissingPackage([string]$name, [string]$packageId) {
    $winget = Get-Command winget.exe -ErrorAction SilentlyContinue
    if (!$winget) {
        throw "未找到 $name，且本机没有 Windows Package Manager (winget)。请先安装 $name，再重试。"
    }
    Write-Host "安装 $name ($packageId)..."
    & $winget.Source install --id $packageId --exact --source winget --accept-package-agreements --accept-source-agreements
    if ($LASTEXITCODE -ne 0) { throw "$name 安装失败（winget 退出码 $LASTEXITCODE）。请查看上方错误后重试。" }
    Refresh-CommandPath
}

$pythonVersion = Get-UsablePython
$nodeVersion = Get-UsableNode
$chromePath = Get-ChromePath
Write-Host "Python: $(if ($pythonVersion) { $pythonVersion } else { '未找到符合要求的版本' })"
Write-Host "Node.js: $(if ($nodeVersion) { $nodeVersion } else { '未找到符合要求的版本' })"
Write-Host "Chrome: $(if ($chromePath) { $chromePath } else { '未找到' })"
if ($CheckOnly) { return }

if (!$pythonVersion) {
    Install-MissingPackage 'Python 3.13' 'Python.Python.3.13'
    if (!(Get-UsablePython)) { throw 'Python 已安装，但当前终端仍找不到 3.11+ 版本。请重新打开终端后再运行安装入口。' }
}
if (!$nodeVersion) {
    Install-MissingPackage 'Node.js LTS' 'OpenJS.NodeJS.LTS'
    if (!(Get-UsableNode)) { throw 'Node.js 已安装，但当前终端仍找不到 20+ 版本或 npm。请重新打开终端后再运行安装入口。' }
}
if (!$chromePath) {
    Install-MissingPackage 'Google Chrome' 'Google.Chrome'
    if (!(Get-ChromePath)) { throw 'Chrome 已安装，但未能在常见路径找到。请确认安装位置后再运行安装入口。' }
}

& (Join-Path $projectRoot 'setup-ai-hr.ps1')
if ($LASTEXITCODE -ne 0) { throw '项目依赖安装或构建失败。' }
Write-Host '环境配置完成。双击 start-ai-hr.bat 启动。'
