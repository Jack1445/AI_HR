# AI Recruiter

AI Recruiter 是一个基于 `boss-cli` 的本地招聘工作台。最终版本保留只读优先的 BOSS 集成，把同步数据、候选人标注、匹配建议、沟通时间线、简历文件和 Agent 任务放进本地可追踪的数据库。

## 能力范围

- 只读读取 BOSS 岗位和已建立沟通的候选人；
- 手动同步到 SQLite，使用远端 ID 或稳定组合键去重，保留同步记录和原始快照；
- 候选人阶段、负责人、收藏、跟进时间、标签、备注和阶段历史；
- 本地搜索、岗位/阶段/标签筛选、时间线和漏斗统计；
- 不依赖外部 API key 的确定性匹配基线，输出分数、证据、优势、风险和待确认问题；
- 简历 TXT、MD、PDF、DOCX 文件的本地归档、哈希去重、文本提取和结构化摘要；
- 消息和 BOSS action 草稿、显式确认、幂等键、审计记录、紧急停止开关；
- Agent 的同步、批量匹配和每日建议任务。Agent 不绕过人工确认执行 BOSS 写入。

默认 `BOSS_ENABLE_WRITES=false`。即使创建了动作草稿，确认后也只会记录为 blocked，不会调用 BOSS 写命令。只有在明确完成登录、理解影响范围并手动打开开关后，允许列表中的单条动作才会执行。

## 目录

```text
AI_HR/
├── backend/                 # FastAPI、SQLAlchemy、Alembic 和业务服务
├── frontend/                # React + TypeScript + Vite + Ant Design
├── boss-cli/                # https://github.com/joohw/boss-cli.git 子模块
├── docs/                    # boss-cli 调研和集成边界
└── AI_Recruiter_项目开发计划.md
```

## 环境和启动

要求 Python 3.11+、Node.js 20+、本机 Chrome/Chromium。项目使用根目录 `.venv`，不需要 conda。

PowerShell：

```powershell
Copy-Item .env.example .env
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -e "backend[dev]"
.\.venv\Scripts\python.exe -m uvicorn app.main:app --app-dir backend --reload --port 8000
```

Git Bash：

```bash
cp .env.example .env
python -m venv .venv
./.venv/Scripts/python.exe -m pip install -e 'backend[dev]'
./.venv/Scripts/python.exe -m uvicorn app.main:app --app-dir backend --reload --port 8000
```

另开一个终端启动前端：

```powershell
Set-Location frontend
npm install
npm run dev
```

打开 <http://localhost:5173>；健康检查为 <http://localhost:8000/api/health>。后端从项目根目录启动，默认才能正确找到 `boss-cli/dist/cli/index.js`。首次使用 BOSS 前，在 `boss-cli/` 中执行 `npm install`、`npm run build`，再运行 `node dist/cli/index.js login` 完成人工登录。

### 一键启动（PowerShell）

以后可以直接在项目根目录运行：

```powershell
.\start-ai-hr.ps1
```

脚本会自动创建 `.env`（如果不存在），先清理 8000 和 5173 端口上的旧服务，再启动前后端，等待服务就绪，并优先使用已安装的 Google Chrome 打开 `http://localhost:5173`。也可以双击项目根目录中的 `start-ai-hr.bat` 启动。后端和前端窗口需要保持运行；停止服务时关闭这两个窗口即可。

网页使用的 Chrome 只是打开 AI Recruiter 界面；BOSS 数据读取仍由 `boss-cli` 的 CDP Chrome 会话完成。该会话的 Cookie 保存在 `~/.boss-cli/.cache/browser-data`，首次同步时如果该会话尚未登录，需要在它打开的 Chrome 窗口中完成一次 BOSS 登录。

网页“岗位”卡片中的“诊断同步”会沿用同一套只读同步流程，并把每个阶段的时间、进程号、工作目录、CLI 参数、退出码、耗时、标准输出和错误输出写入项目根目录的 `data/diagnostics/sync-*.log`。诊断失败时，页面错误提示会直接给出日志路径；日志只保存在本机，不包含浏览器 Cookie 或登录凭证。

如果 PowerShell 中 `python` 不可用，请使用已创建环境的绝对路径；如果在 Git Bash 中启动，必须使用 `./.venv/Scripts/python.exe` 这种斜杠写法。

## 主要接口

| 目的 | 接口 |
| --- | --- |
| 健康检查 | `GET /api/health` |
| BOSS 只读岗位/候选人 | `GET /api/jobs`、`GET /api/jobs/{job_id}/candidates` |
| 同步到本地 | `POST /api/local/sync?scope=all` |
| 本地候选人 | `GET/PATCH /api/local/candidates`、`GET /api/local/candidates/{id}` |
| 标签、备注、时间线 | `/api/local/candidates/{id}/tags`、`/notes`、`/timeline` |
| 匹配建议 | `POST /api/candidates/{id}/match` |
| 受控动作 | `POST /api/actions`、`/{id}/confirm`、`/{id}/cancel` |
| 简历 | `POST/GET /api/candidates/{id}/resumes`、`GET /api/resumes/search`、`POST /api/resumes/{id}/reparse`、`GET/DELETE /api/resumes/{id}` |
| Agent 任务 | `POST/GET /api/agent/tasks`、`/api/agent/policy` |
| 审计与指标 | `GET /api/admin/audit`、`GET /api/admin/metrics` |

简历上传接口接收原始请求体，文件名通过 `X-Filename` 请求头传入，避免强制引入 multipart 运行时；例如 `Content-Type: text/plain` 配合 `X-Filename: resume.txt`。

## 数据和安全边界

开发数据库由 Alembic revision `20261018_0001` 创建，应用启动时也会安全地补齐本地开发表。运行数据、简历文件、Cookie、联系方式和 `.env` 都被 `.gitignore` 排除。常规应用日志只记录命令错误摘要和审计元数据；诊断同步日志会保存 CLI 的完整标准输出和错误输出，便于定位页面或登录问题，但不读取或写入浏览器 Cookie、密码等登录凭证。

`boss-cli` 仍是独立 GPL-3.0 子模块，AI Recruiter 通过直接子进程适配器调用它，不复制其内部浏览器逻辑。BOSS 页面结构或登录状态变化时，只读同步会失败并保留已有本地数据；这类失败需要先在 `boss-cli` 中修复登录或页面访问，再重新同步。

当前 Agent 任务在本地请求内串行执行，具备任务状态、失败重试和取消接口；生产部署前仍应在反向代理或应用层接入真实身份认证、角色权限和后台队列。`X-Actor` 只用于本地审计标识，不能替代生产认证。

## 验证

```powershell
Set-Location backend
..\.venv\Scripts\python.exe -m pytest -q
Set-Location ..
.\.venv\Scripts\python.exe -m alembic -c backend/alembic.ini upgrade head
Set-Location frontend
npm run build
```

调研记录见 [docs/boss-cli-analysis.md](docs/boss-cli-analysis.md)，阶段目标见 [AI_Recruiter_项目开发计划.md](AI_Recruiter_项目开发计划.md)。
