# AI Recruiter

AI Recruiter 是一个基于 `boss-cli` 的招聘管理系统。当前处于 **Stage 0：工程初始化与可运行基线**，先验证本地服务、登录状态和只读数据链路，再逐步加入数据库、AI 分析和人工确认后的自动化操作。

## 当前范围

Stage 0 提供：

- FastAPI 后端和 `GET /api/health` 健康检查；
- React + TypeScript + Vite + Ant Design 前端首页；
- SQLAlchemy/Alembic 数据库基础设施，暂不创建业务表；
- 独立的 `boss-cli` 子模块和后端子进程适配器边界；
- 本地环境变量示例、启动说明和安全忽略规则。

第一版业务闭环是：启动项目 → 连接 `boss-cli` → 读取岗位 → 选择岗位 → 查看候选人列表。Stage 1 之前不会自动发送消息、打招呼或修改 BOSS 数据。

## 目录

```text
AI_HR/
├── backend/                 # FastAPI、配置、数据库和 boss-cli 适配器
├── frontend/                # React + Vite + Ant Design
├── boss-cli/                # 上游 https://github.com/joohw/boss-cli.git 子模块
├── docs/                    # boss-cli 调研和集成边界
└── AI_Recruiter_项目开发计划.md
```

## 本地启动

要求：Python 3.11+、Node.js 20+、本机 Chrome/Chromium。先复制环境示例。

PowerShell：

```powershell
Copy-Item .env.example .env
```

Git Bash：

```bash
cp .env.example .env
```

PowerShell 启动后端：

```powershell
py -3 -m venv .venv
.\.venv\Scripts\python -m pip install -e "backend[dev]"
.\.venv\Scripts\python -m uvicorn app.main:app --app-dir backend --reload --port 8000
```

Git Bash 启动后端：

```bash
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e 'backend[dev]'
./.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --reload --port 8000
```

启动前端（另开一个终端）：

```powershell
Set-Location frontend
npm install
npm run dev
```

打开 <http://localhost:5173>。后端健康检查地址为 <http://localhost:8000/api/health>。

## boss-cli 调研与实测

`boss-cli` 是独立的 GPL-3.0 项目，使用本机 Chrome/CDP 和本地用户数据目录。它输出中文纯文本，没有 JSON 模式；AI Recruiter 会通过单进程队列和解析器适配它，不直接依赖其内部 TypeScript 模块。

在完成登录后，可在 `boss-cli/` 中执行只读命令：

```powershell
Set-Location boss-cli
npm install
npm run build
node dist/cli/index.js login
node dist/cli/index.js positions
```

`login` 需要人工在浏览器中完成扫码或验证。真实输出样本和登录态验证尚未写入仓库；不要把 Cookie、简历、联系方式或 `.env` 提交到 Git。

## 验收入口

- 后端：`GET http://localhost:8000/api/health`
- 前端：<http://localhost:5173>
- 调研说明：[docs/boss-cli-analysis.md](docs/boss-cli-analysis.md)
