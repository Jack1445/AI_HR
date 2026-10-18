# AI Recruiter

AI Recruiter 是一个基于 `boss-cli` 的招聘管理系统。Stage 0 已完成，当前进入 **Stage 1：只读招聘看板 MVP**，先验证岗位和已沟通候选人的只读数据链路，再逐步加入数据库、AI 分析和人工确认后的自动化操作。

## 当前范围

当前提供：

- FastAPI 后端和 `GET /api/health` 健康检查；
- React + TypeScript + Vite + Ant Design 前端首页；
- SQLAlchemy/Alembic 数据库基础设施，暂不创建业务表；
- 独立的 `boss-cli` 子模块和后端子进程适配器边界；
- `GET /api/jobs` 岗位列表只读接口；
- `GET /api/jobs/{job_id}/candidates` 已建立沟通候选人只读接口；
- 岗位选择、候选人表格、刷新、空数据和错误状态；
- 本地环境变量示例、启动说明和安全忽略规则。

第一版业务闭环是：启动项目 → 连接 `boss-cli` → 读取岗位 → 选择岗位 → 查看候选人列表。当前候选人列表采用 `boss list` 按来源岗位文本精确匹配，语义是“已经建立沟通的候选人”。页面不会发送消息、打招呼或修改 BOSS 数据。

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

后端需要从项目根目录启动，以便找到默认的 `boss-cli/dist/cli/index.js`。如果你之前已经创建过 `.env`，请确认其中包含：

```dotenv
BOSS_CLI_COMMAND=node
BOSS_CLI_ENTRYPOINT=boss-cli/dist/cli/index.js
```

如果使用全局安装的 `boss` 命令，可改为 `BOSS_CLI_COMMAND=boss` 并清空 `BOSS_CLI_ENTRYPOINT`。

启动前端（另开一个终端）：

```powershell
Set-Location frontend
npm install
npm run dev
```

打开 <http://localhost:5173>。后端健康检查地址为 <http://localhost:8000/api/health>。

Stage 1 验收时，在网页中确认岗位列表能够加载；点击岗位后确认候选人表格能够加载。岗位读取失败时，页面会显示 `boss-cli` 返回的登录、超时或页面结构错误；页面不会自动执行任何写操作。

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
