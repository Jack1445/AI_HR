# AI_HR 项目上下文与排障记录

更新时间：2026-10-20  
项目目录：`C:\Users\Jack\Desktop\AI_HR`

这份文档记录项目目标、环境约定、已经发生过的故障、诊断证据、修复进度和当前交接状态。它用于让后续开发或排障可以从已有证据继续，不需要重新猜测之前发生过什么。

## 1. 项目目标

项目目标是做一个本地运行的 AI Recruiter 招聘工作台。用户在网页中完成岗位同步、候选人查看、标注、匹配分析和人工确认动作；BOSS 相关读取通过 `boss-cli` 执行，写操作默认关闭，写入动作必须经过人工确认。

涉及的两个代码仓库：

- 主项目：`C:\Users\Jack\Desktop\AI_HR`
  - GitHub：<https://github.com/Jack1445/AI_HR>
  - 后端：`backend`
  - 前端：`frontend`
  - 启动入口：`start-ai-hr.bat` / `start-ai-hr.ps1`
- BOSS CLI 子模块：`C:\Users\Jack\Desktop\AI_HR\boss-cli`
  - 上游：<https://github.com/joohw/boss-cli>
  - 编译产物：`boss-cli\dist\cli\index.js`

用户选择使用项目内的 `.venv` 隔离 Python 依赖，不使用 conda。用户主要使用 Windows PowerShell，不使用 Git Bash。BOSS 账号登录在 Google Chrome 中，项目网页也应使用 Chrome 打开。

## 2. 进度概览

- Stage 0：已由用户验收通过。
- Stage 1 及后续招聘工作台功能：已经实现并进入联调。
- 主项目曾完成一次提交并上传 GitHub：`e4f7f4f feat: add web diagnostic sync logs`。
- 当前正在收尾的改动包括诊断面板、调试状态接口、启动脚本端口清理和后端版本校验。这些改动在本地已完成主要验证，尚待最终提交发布。
- `boss-cli` 子模块中的侧栏导航修复已经在本机编译和实跑成功，但子模块改动仍是本地工作树改动，尚未作为一个新的上游提交发布。

## 3. 用户实际遇到的现象

### 3.1 直接运行 CLI 时的页面与读取问题

用户在 PowerShell 中从 `boss-cli` 目录运行：

```powershell
node .\dist\cli\index.js positions
```

早期现象包括：

- 第一次运行提示无法通过侧边栏“职位管理”进入 `/web/chat/job/list`。
- 浏览器实际停在 `https://www.zhipin.com/web/chat/index`，用户手动点击左侧“职位管理”后，页面才进入 `https://www.zhipin.com/web/chat/job/list`，此时 CLI 能读到岗位。
- 还有一次命令末尾误带反斜杠，导致 CLI 路径或参数行为混淆。
- 在项目根目录直接运行 `node .\dist\cli\index.js positions` 会报 `MODULE_NOT_FOUND`，因为 CLI 入口实际位于 `boss-cli\dist\cli\index.js`。

手动进入职位管理后，CLI 曾成功读到 20 个职位，页面统计为 36 个职位，状态统计为开放中 2、待开放 11、已关闭 7。这证明账号登录、Chrome 会话和 BOSS 页面本身都可访问，问题集中在自动导航和进程状态。

### 3.2 网页启动与浏览器问题

用户希望在网页中交互，而不是在终端中操作。因此项目增加了一键入口脚本。期间出现过：

- 双击 `.bat` 后没有明显反馈。
- Edge 打开 `http://localhost:5173`，但用户的 BOSS 登录在 Chrome 中，后来已改为优先使用 Chrome。
- 页面能打开，但岗位区显示“暂无岗位，请先确认 BOSS 已登录”。
- 页面同步后显示“同步失败：同步招聘数据时发生未分类错误”。
- 启动脚本多次报告 8000 端口被 PID 16580、4816、39456、29224 等进程占用。
- `taskkill` 对已经退出的 PID 返回“没有找到进程”，旧脚本把这类竞态输出成失败，导致用户以为清理完全失败。

### 3.3 诊断按钮与日志问题

为避免让用户反复盲测，网页增加了“诊断同步”按钮和本地 JSONL 日志。最初用户点击后看不到日志，随后发现网页提示仍是通用错误。进一步检查后确认：用户访问的 8000 端口并不是当前源码启动的后端，而是一个仍在运行的旧版本进程。

## 4. 诊断过程与证据

### 4.1 先区分“网页问题”和“后端/CLI 问题”

后端诊断接口会把一次同步拆成几个阶段写入 `data\diagnostics\sync-*.log`：

- `sync.start`
- `cli.start`
- `cli.complete` 或 `cli.timeout`
- `sync.complete` 或 `sync.failed`

已经保存的日志：

- `data\diagnostics\sync-20261019T084921.459472Z-73a0ee70.log`
  - 记录到 CLI 阶段。
  - CLI stderr 明确显示 `.boss-cli` 会话锁持续 `EPERM`，等待 30 秒后退出。
- `data\diagnostics\sync-20261019T085133.093005Z-e0070a35.log`
  - 记录 CLI 运行 120 秒后超时。

直接请求旧的 8000 后端只返回旧的通用 500 错误，并且没有生成诊断目录；在临时端口启动当前后端后，接口能返回 502/504 和诊断日志路径。这个对比证明当时网页访问的是旧进程，而不是当前源码。

### 4.2 定位 BOSS 导航的具体错误

使用 `BOSS_CLI_DEBUG=true` 直接运行 CLI，修复前的关键输出是：

```text
sidebar-search-result {"targetPoint":{}}
Protocol error (Input.dispatchMouseEvent): Invalid parameters
Failed to deserialize params.x - BINDINGS: double value expected
```

原因是页面脚本通过 `page.evaluate` 返回了一个箭头函数对象，而不是执行函数并返回 `{ x, y }`。后续鼠标事件收到的坐标是空对象，因此 Chrome CDP 拒绝了 `x` 参数。

### 4.3 修复后的实跑证据

侧栏导航改成在页面内查找“职位管理”链接并执行原生 DOM `target.click()`，不再依赖不稳定的坐标对象。重新构建并运行 CLI 后，关键输出变为：

```text
sidebar-search-result {"clicked":true}
sidebar-navigation-complete currentUrl=https://www.zhipin.com/web/chat/job/list
positions-after-navigation currentUrl=https://www.zhipin.com/web/chat/job/list
已读取 20 个职位（页面统计：共36个职位/每页20个）。
```

这次实跑没有用户手动点击侧栏，说明“自动从沟通页进入职位管理页”的核心问题已经被定位并修复。

## 5. 已完成的代码修复

### 5.1 诊断链路

- 新增 `backend/app/services/diagnostics.py`，为每次诊断同步创建独立 JSONL 文件。
- `backend/app/adapters/boss_cli.py` 记录 CLI 启动、退出码、耗时、stdout、stderr；超时后也会保存已经产生的输出。
- `/api/local/sync?scope=all&diagnostic=true` 返回诊断日志路径；失败时也把日志路径放入错误信息。
- 前端增加“诊断同步”按钮、持久化日志路径提示和“调试信息”区域。
- 调试状态接口为 `/api/debug/status`，只返回经过筛选的事件字段和 stdout/stderr 的字符数，不直接回显完整输出。

### 5.2 启动与旧进程识别

- `start-ai-hr.ps1` 会尝试通过 `Get-NetTCPConnection` 和 `netstat -ano` 找到监听端口的 PID。
- 启动脚本会等待 `/api/health` 返回当前后端版本，而不是只要 HTTP 可访问就继续。
- 当前源码版本标记为 `0.2.2`。旧版本进程占用 8000 时，启动脚本应报告“后端未启动到当前版本”，从而暴露 stale backend，而不是让网页静默调用旧代码。
- 对已经消失的 PID，脚本应把它视为竞态而不是致命错误；如果最终仍有监听者，才报告端口清理失败。

### 5.3 BOSS CLI 侧栏导航

修改位于 `boss-cli\src\common\boss_sidebar_nav.ts`，并已执行构建。当前本机 `boss-cli\dist` 能自动进入职位管理页并读取岗位。

## 6. 当前文件和发布状态

主项目已经上传过的提交：

```text
e4f7f4f feat: add web diagnostic sync logs
```

当前本地还包含待整理的诊断/调试/启动脚本改动。相关文件包括：

- `backend\app\adapters\boss_cli.py`
- `backend\app\api\routes\health.py`
- `backend\app\api\routes\debug.py`
- `backend\app\main.py`
- `backend\app\services\diagnostics.py`
- `backend\tests\test_health.py`
- `frontend\src\App.tsx`
- `frontend\src\api.ts`
- `frontend\src\index.css`
- `start-ai-hr.ps1`
- `docs\diagnostic-run-20261019.md`

工作区里还有一个未跟踪的 Excel 文件：

```text
Appendix A (R2)_HKU SH Residence_ Reservation For~.xlsx
```

这个文件与项目无关，不应被加入提交。`boss-cli` 子模块的本地修改也不能只通过主项目提交来替代，若要让其他机器通过 GitHub 得到同样的 CLI 修复，需要先在 `boss-cli` 上游创建并发布对应提交，再更新主项目的子模块指针。

## 7. 下一步验收路径

1. 用最新的 `start-ai-hr.bat` 启动一次，等待浏览器打开 Chrome 的 `http://localhost:5173`。
2. 页面顶部的后端版本应显示 `0.2.2`；若不是，说明仍有旧后端进程占用 8000。
3. 点击“诊断同步”。无论成功还是失败，页面都应显示本次日志的绝对路径，并在“调试信息”区域显示最近同步阶段、后端 PID、CLI 入口是否存在和最近错误摘要。
4. 如果同步成功，岗位列表应出现岗位；如果失败，只需把页面显示的日志文件内容提供出来，就能根据最后一个事件判断是端口、会话锁、BOSS 登录、导航还是数据解析问题。

## 8. 结论

这次故障不是单一原因：旧后端进程让网页继续使用过期代码；CLI 侧栏导航又存在一个明确的 CDP 坐标参数 bug；隔离运行中还观察到了会话锁权限和超时路径。现在三类问题都已有对应的诊断记录或代码修复，后续验证应以网页显示的后端版本和诊断日志为准。
