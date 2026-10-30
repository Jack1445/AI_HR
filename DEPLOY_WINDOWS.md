# Windows 环境依赖与部署清单

## 需要安装

| 依赖 | 要求 | 用途 |
| --- | --- | --- |
| Windows | 10/11，PowerShell 5.1 或更新版本 | 启动脚本与 API Key 的 DPAPI 本机加密 |
| Git | 使用 `git clone` / `git pull` 时需要 | 克隆和更新源码；下载 ZIP 后运行程序不需要 |
| Python | 3.11 或更新版本；安装时加入 PATH 或安装 `py` 启动器 | FastAPI 后端和 SQLite 数据库 |
| Node.js + npm | Node.js 20 或更新版本 | React 前端和内置 BOSS CLI |
| Google Chrome | 当前稳定版 | 打开工作台以及登录 BOSS；BOSS CLI 也可自动检测 Edge |
| 网络 | 首次安装依赖及使用 BOSS/API 时可连接相应服务 | `pip`、`npm`、BOSS 与所选模型服务 |

项目根目录的 `backend/pyproject.toml` 是 Python 依赖清单；`frontend/package-lock.json` 和 `boss-cli/package-lock.json` 锁定两个 Node 项目的依赖版本。`boss-cli/` 是本仓库的普通目录，无需安装外部 BOSS CLI，也无需初始化 Git 子模块。根目录 `.env.example` 是可复制的配置模板，运行数据和密钥不会上传到 GitHub。

## 新电脑首次部署

下载项目后，直接双击根目录的 `install-ai-hr.bat`。它会检查 Python 3.11+、Node.js 20+ 和 Chrome；缺少时调用 Windows Package Manager（`winget`）安装，随后创建虚拟环境、安装项目依赖并构建。系统软件安装可能显示 Windows 权限确认；如电脑没有 `winget`，脚本会指出缺少的依赖。安装完成后双击 `start-ai-hr.bat`。

如使用 Git 克隆项目，在 PowerShell 中执行：

```powershell
git clone https://github.com/Jack1445/AI_HR.git
Set-Location AI_HR
.\install-ai-hr.bat
.\start-ai-hr.bat
```

项目安装阶段使用 `npm ci` 安装前端及内置 BOSS CLI 依赖，并构建两者。依赖安装成功后，双击 `start-ai-hr.bat` 即可启动；工作台地址为 <http://localhost:5173>，后端健康检查地址为 <http://localhost:8000/api/health>。启动脚本会占用本机 5173 和 8000 端口，并会关闭这两个端口上已有的监听进程；请先保存其他使用这些端口的工作。

首次读取 BOSS 时，在 BOSS CLI 打开的 Chrome 会话中人工登录。网页右上角的账号应与当前登录账号一致。若配置模型 API，在“AI 管理”页面重新填写 Base URL、API Key 并选择模型；原电脑的 DPAPI 加密密钥不能跨 Windows 用户或电脑复用。

## 后续更新

先关闭前后端服务窗口，再在项目目录执行：

```powershell
git pull
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\setup-ai-hr.ps1
.\start-ai-hr.bat
```

重复运行安装脚本会更新依赖和构建，不会删除 `.env` 或本地数据库。

## 本地保存与迁移

- 数据库、截图、附件简历、诊断日志及分析结果保存在根目录 `data/`；Git 已忽略此目录。新电脑克隆后是空数据库，需要重新读取数据。
- `.env`、`.venv`、`node_modules` 和构建结果也不会上传。不要把原电脑的 API Key、浏览器 Cookie、候选人资料或简历放入 Git 仓库。
- 如需迁移已有业务数据，可在停止程序后自行备份并复制 `data/` 到新电脑相同位置。API Key 仍需在新电脑重新输入，BOSS 也需重新登录。
- 登录后的 BOSS 浏览器资料位于当前 Windows 用户目录 `~/.boss-cli/.cache/browser-data`，不会随 Git 仓库迁移。

## 安装核对

```powershell
.\.venv\Scripts\python.exe --version
node --version
Test-Path .\boss-cli\dist\cli\index.js
Test-Path .\frontend\node_modules
```

最后两条应返回 `True`。启动后访问健康检查地址，看到 `status: ok` 才表示后端已就绪。
