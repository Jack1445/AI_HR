# boss-cli 调研分析

版本：v1.0（初稿）
调研日期：2026-10-14
调研对象：`boss-cli/`（上游 [joohw/boss-cli](https://github.com/joohw/boss-cli)，本地版本 0.6.6，GPL-3.0）
调研方式：静态阅读源码（`src/`、`docs/`、`package.json`、README），未登录实测。文末「待实测清单」列出需登录后验证的项。

---

## 1. 一句话结论

boss-cli 是一个**以「格式化中文纯文本」为输出契约**的单体 CLI，通过 CDP 驱动一只**独立用户数据目录的本地 Chrome** 操作 Boss直聘 B 端。它适合被后端以「子进程 + 文本解析」方式集成；**所有命令全局串行**（文件锁），候选人列表输出**不含稳定 ID**，这两点直接影响适配层与数据模型设计。

## 2. 基本信息

| 项 | 值 |
| --- | --- |
| npm 包 | `@joohw/boss-cli`（bin 名 `boss`） |
| 本地版本 | 0.6.6 |
| 技术栈 | TypeScript（ESM）→ `tsc` 编译到 `dist/`；运行时依赖仅 `puppeteer-core` + `dotenv` |
| 运行要求 | Node.js ≥ 20，本机 Chrome / Edge / Chromium |
| 许可证 | GPL-3.0（**注意：本项目若分发且与之形成衍生作品，需评估 GPL 传染性；进程间调用（spawn CLI）通常视为独立作品，但应以法务判断为准**） |
| 数据目录 | `~/.boss-cli/`（`.cache/` 浏览器数据与锁；`jd/` 岗位 JD 缓存 md） |

## 3. 运行机制（适配层必须知道的事实）

### 3.1 浏览器会话

- 连接方式：**先探测固定调试端口** `http://127.0.0.1:53470/json/version`（800ms），命中则复用已开的 Chrome；未命中则 `spawn` 新 Chrome 再 `puppeteer.connect`。
  - 端口可用 `BOSS_BROWSER_REMOTE_DEBUGGING_PORT` 覆盖。
  - 不用 `puppeteer.launch()`，刻意让 **Node 退出后浏览器保留**（登录态存续的关键）。
- 用户数据目录：`~/.boss-cli/.cache/browser-data`（独立于日常浏览器，Cookie/登录态都在这里）。可用 `BOSS_BROWSER_USER_DATA_DIR` 覆盖。
- Chrome 查找顺序：`CHROME_PATH` / `PUPPETEER_EXECUTABLE_PATH` 环境变量 → 常见安装路径（Windows 含 Chrome 与 Edge）。
- 无头模式：`BOSS_BROWSER_HEADLESS=true`，默认**有头**；`login` 命令会强制有头。
- 反检测：页面级 guard（webdriver 隐藏、插件 mock、拦截风控跳转等）+ CDP `Fetch.enable` 拦截风险脚本与上报。详见上游 `docs/browser-session.md`、`docs/anti-detection.md`。
- **不要在命令执行时手动打开页面 DevTools**（Boss 前端有反调试逻辑，可能触发风控）。

### 3.2 全局串行（重要）

- 所有业务命令经 `withBossSessionPage` 执行，内部包了一层**文件锁** `~/.boss-cli/.cache/session.lock`：
  - 同一时刻只允许一个 boss-cli 进程操作浏览器；
  - 后来者轮询等待，**最多等 30 秒**，超时报错 `Boss session is busy for more than 30s...`；
  - 锁带 PID/主机名，进程死亡后自动清理陈旧锁。
- **对适配层的要求**：后端也必须串行调用 CLI（自建队列），且命令超时预算要包含「排队等锁 30s + 页面导航 + 拟人延迟 + 列表稳定等待」。

### 3.3 命令耗时量级（来自源码中的等待常量）

| 环节 | 量级 |
| --- | --- |
| 浏览器首启 | 最长 30s 等待 |
| 侧栏 `.menu-list` 出现（登录态探针） | 最长 30s |
| `list` 列表稳定 | 最长 18s 轮询 |
| `positions`/`jd` 列表就绪 | 最长 16s 轮询 |
| `jd` 详情 | 固定 sleep 10s + 最长 12s 等待 |
| 各步骤之间 | 数百 ms 随机拟人延迟 |

**建议适配层单命令超时 120s**，并区分「锁等待超时」「登录失效」「页面结构变化」三类错误。

### 3.4 登录机制

- `boss login`：打开 `https://www.zhipin.com/web/user/?ka=header-login`，**立即返回**，不校验、不等待。扫码/验证由人在浏览器完成。登录态靠 user-data-dir 持久化。
- 登录态检测是**隐式**的：每个命令进主壳页后等侧栏 `.menu-list`；30s 不出现则报错「当前页面可能未登录或未进入 Boss 主界面」。
- **没有专门的「检查登录态」命令**。适配层可把一次轻量只读命令（如 `positions`）的结果当作登录态探针，或以后补一个最小上游补丁。

## 4. 输出契约

- 成功：结果文本走 **stdout**，退出码 0。
- 失败：错误信息（多为 `❌ ...` 中文）走 **stderr**，退出码 1。
- 版本更新提示走 **stderr**（24h 一次，状态存 `~/.boss-cli/.cache/version-check.json`），**不污染 stdout**。
- **没有 JSON / 机器可读模式**。所有 `impl*` 函数返回格式化中文字符串。文本解析是唯一集成途径（除非打上游补丁），格式随上游版本变化 → 必须用「脱敏样本 + 解析器回归测试」兜底。

### 4.1 各命令输出结构（从源码格式化逻辑还原）

#### `boss positions` —— 职位列表（只读，**有稳定 ID**）

```text
已读取 N 个职位（页面统计：共 N 个）。
状态统计：开放中 x｜待开放 y｜已关闭 z
来源页面：https://www.zhipin.com/web/chat/job/list
职位明细：
1. 职位名｜状态:开放中｜标签:xxx｜城市｜薪资｜经验...（meta 数组）｜看过我:n｜沟通过:n｜感兴趣:n｜ID:12345
```

- 字段：title、status、label、meta[]、viewed/chatted/interested、**id（DOM `data-id`，稳定）**。
- 多职位同名时 `jd` 的模糊匹配会报候选列表错误；名称是页面文本。

#### `boss jd <名称>` —— 职位 JD（只读，但会点开编辑面板）

- 先查本地缓存 `~/.boss-cli/jd/<职位名>.md`，命中直接返回（**重复调用零成本**）。
- 未命中则导航到职位管理页 → 点击该职位「编辑」→ 读表单 → 写缓存 md → 返回 markdown：
  `# 标题` / 状态、标签 / 基本信息（公司、招聘类型、职位名称、职位类型、是否驻外）/ 要求（经验、学历、薪资范围、薪资月数、关键词、工作地点）/ 职位描述正文。
- 支持名称精确/模糊匹配；模糊命中多个会报错并列出候选。

#### `boss list [--unread]` —— 沟通列表（只读，**无 ID**）

```text
沟通列表共 N 人，其中 M 人有未读消息。      （--unread 时首行改为「未读筛选：共 N 人…」）
候选人明细：
1. 姓名｜来源岗位｜未读:2｜时间:10:30｜消息:最近一条消息预览
```

- 字段：name、job（来源岗位文本）、time、message（最后一条预览）、unreadCount。
- **没有候选人 ID**；序号为 1-based 位置序号，随列表排序变化（新消息会重排），**不可用作持久标识**。
- 分页/滚动加载：**未见实现**，只读当前渲染出的 `.geek-item`。

#### `boss recommend [岗位关键字]` —— 推荐候选人（只读，内部有 ID 但不输出）

```text
（首行：当前岗位/页面信息）
推荐列表（按来源分组）：共 N 人。

常规推荐（n）
  - 1. 姓名[ | 看过]｜薪资:xx｜信息:xx｜期望:xx｜经历:xx｜[同事沟通过]｜可打招呼/已打招呼
    优势: xxx

打招呼产生的推荐（m）
  ...
```

- DOM 中存在 `data-geekid`（稳定候选人 ID），代码内部也解析了（用于 greet 去重），**但最终文本不输出 geekId**。
- 带岗位关键字时先在推荐页岗位下拉模糊切换。
- iframe 结构（`iframe[name="recommendFrame"]`），新旧两版卡片选择器并存——上游在跟随页面改版。

#### `boss chat <姓名> [--strict]` / `chat --index <n> [--unread]` —— 打开会话（只读 + 打开状态）

```text
成功进入候选人聊天：姓名
简历获取状态: 已获取/未获取

人才摘要：
姓名: xxx
活跃状态: xxx
基本信息: xx / xx / xx
沟通职位: xxx
期望: xxx
近期经历:
1. ...

备注: xxx

完整聊天消息：
[我] 10:30 消息内容
[对方] ...
```

- **这是目前信息最丰富的命令**：候选人摘要 + 全部聊天记录 + 简历状态一次拿到。可充当「候选人详情」数据源。
- 副作用：把「当前会话」切到该候选人（`send`/`action` 依赖此状态）。
- 同名处理：默认包含匹配，`--strict` 精确；或 `--index` 按 `list` 序号（可再带姓名校验）。

#### `boss search [关键词]` —— 常规搜索（只读）

进入 `/web/chat/search`，带关键词则填入并回车，输出牛人列表（格式与 recommend 类似，需实测确认）。

#### `boss deep-search [...]` —— 深度搜索（默认只读，`--match` 消耗配额）

- 默认输出表单状态（核心要求/加分项分组、今日剩余匹配次数、按钮状态），**不输出候选人**。
- `--core/--bonus` 可重复传入、按列表同步分组；`--clear-*` 清空。
- `--match` 才点「立即匹配」：**消耗今日匹配次数**，输出最新 20 条。

#### `boss preview <姓名>` —— 在线简历预览（只读但**消耗每日查看次数**）

- 要求当前已在推荐/深度搜索/常规搜索页且列表已加载；**不自动跳转**。
- 平台每日可查看次数有限。源码含 OCR 链路（截图 → 百度 OCR，凭证存 `~/.boss-cli`，由隐藏命令 `_baidu-keys` 配置）。

### 4.2 写操作命令（Stage 4 才接触，先登记）

| 命令 | 动作 | 备注 |
| --- | --- | --- |
| `send --text/-t` | 当前会话发消息 | 需先 `chat` 打开会话；`--request-resume` 发送后自动求简历 |
| `greet <姓名> [--job]` | 推荐/深搜页打招呼 | 消耗打招呼次数，单次成本高 |
| `action resume / agree-resume / request-attachment-resume` | 索要/同意简历 | 需当前会话 |
| `action not-fit` | 标记不合适 | 需当前会话 |
| `action remark --remark` | 写备注 | 需当前会话 |
| `action wechat` | 交换微信 | 需当前会话 |
| `action history` | 读「同事/我的沟通记录」弹层 | 只读 |
| `deep-search --match` | 消耗匹配次数 | 见上 |
| `update` | npm 自更新 | 与业务无关 |

## 5. 与项目 Stage 的映射

| 计划中的能力 | boss-cli 现状 | 结论 |
| --- | --- | --- |
| 获取岗位列表 | ✅ `positions`（含稳定 ID、状态、统计数据） | 直接可用 |
| 获取岗位 JD | ✅ `jd <名称>`（本地 md 缓存） | 直接可用 |
| 获取候选人列表 | ⚠️ 无「按岗位列候选人」命令。可用：`list`（沟通列表，含来源岗位文本，可按岗位名过滤，但仅限已建立沟通的）；`recommend <岗位>`（推荐池） | **语义与计划中的「岗位下的候选人」不同，Stage 1 需先定义清楚取哪一类** |
| 获取候选人详情 | ⚠️ 无独立命令。`chat <姓名>` 输出摘要+聊天记录（限已沟通）；`preview` 看在线简历（限推荐/搜索页、有日配额） | 组合使用 |
| 获取聊天记录 | ✅ `chat <姓名>` 输出完整消息 | 可用 |
| 发送消息等写操作 | ✅ `send`/`action`/`greet` | Stage 4 再启用 |

### Stage 1 接口映射建议

- `GET /api/jobs` ← `boss positions`（解析出 id/title/status/meta/stats）。
- `GET /api/jobs/{job_id}/candidates` ← 二选一或并行：
  1. `boss list` 按来源岗位名过滤（= 该岗位下已在沟通的候选人）；
  2. `boss recommend <岗位名>`（= 该岗位推荐池）。
  建议 Stage 1 两个都展示并明确标注语义，避免把「推荐池」误当「投递/沟通中」。
- `GET /api/candidates/{id}`（可选）← `boss chat <姓名>`（已沟通者）。

## 6. 数据标识问题（Stage 2 去重的前置结论）

| 实体 | 远端稳定标识 | 说明 |
| --- | --- | --- |
| 岗位 Job | ✅ 有（`data-id`，positions 输出 `ID:xxx`） | 可直接作主键来源 |
| 沟通列表候选人 | ❌ 无 | 只有姓名+来源岗位+时间+消息预览；序号是位置序号，会漂移 |
| 推荐候选人 | ⚠️ DOM 有 `data-geekid`，但**文本输出不含** | 要么组合键，要么上游补丁 |
| 候选人详情 | ❌ 无 | `chat` 按姓名定位 |

**可选方案**（Stage 2 前必须定）：

1. **组合键策略**（不改上游）：`候选人 = hash(姓名 + 来源岗位 + 期望/薪资等字段)`，接受偶发漂移，保留快照供人工合并。
2. **最小上游补丁**：让 `recommend` 输出行追加 `geekId:xxx`（DOM 已解析，改动 ~2 行），并按同样思路给 `list` 的 `.geek-item` 尝试提取 id。补丁需记录在 `docs/` 并跟踪上游升级。
3. 混合：先组合键落地 Stage 2，补丁作为后续增强。

## 7. 风险登记（结合源码实证）

| 风险 | 实证依据 | 控制措施 |
| --- | --- | --- |
| Boss 前端改版导致解析失败 | 选择器硬编码（`.geek-item`、`.job-jobInfo-warp` 等）；上游保留 `boss_availability.ts` 哈希熔断器（**当前为死代码，未接入命令链**），说明上游预期「改版即停用」 | 适配层解析失败时返回原始输出摘要 + 明确错误；样本回归测试；盯上游版本 |
| 登录态失效 | 表现为 `.menu-list` 30s 超时错误 | 适配层识别该错误文案 → 返回「需重新登录」语义，**不自动重试** |
| 命令串行与长耗时 | 文件锁 30s；单命令常态数秒~数十秒 | 后端队列串行化；超时 120s；前端加载态提示 |
| 页面状态依赖（send 需先 chat 等） | `send`/`action`/`preview`/`greet` 都要求特定前置页面状态 | 适配层把「chat→send」建模为一次原子操作，中间不允许插入其他命令 |
| 配额消耗 | preview 日配额、greet 次数、deep-search 匹配次数 | Stage 4 的操作确认 UI 中明确提示配额属性 |
| 交互模式不可用 | 生产模式（非 `npm run dev`）无参数启动直接报错退出 | 只使用单命令调用形式 |
| GPL-3.0 | LICENSE | 进程边界隔离（spawn），不复制上游源码进 backend；如需补丁，补丁文件单独管理并保留许可声明 |
| `docs/research/` 大目录 | 上游仓库内含 ~273 个前端逆向快照文件 | 与运行无关；若 fork/同步上游注意体积 |

## 8. 适配层设计建议（输入给 Stage 1）

1. **调用形式**：`spawn('boss', [cmd, ...args])`，收集 stdout/stderr/exitCode；不 shell 拼接（避免中文/引号问题），Node ≥ 20 环境由部署文档约束。
2. **串行队列**：进程内 FIFO，单并发；每个命令带 120s 兜底超时，超时 kill 进程组（注意 kill 不掉浏览器本体，只断 CLI——浏览器由设计保证可复用）。
3. **错误分类**：把 stderr 文案映射为 `LOGIN_EXPIRED`（menu-list/未登录）、`SESSION_BUSY`（lock 30s）、`PAGE_STRUCTURE_CHANGED`（选择器未找到类）、`QUOTA/BUSINESS`（已打招呼等）、`UNKNOWN`。
4. **解析器**：按命令一个 parser，输入纯文本输出强类型；每个 parser 配「脱敏样本」fixture 做单测（样本放 `backend/tests/fixtures/`，**真实数据脱敏后入库**）。
5. **JD 缓存直通**：`jd` 已有本地 md 缓存，适配层可直接读 `~/.boss-cli/jd/*.md` 作为二级缓存（路径可配）。
6. **健康检查**：`GET /api/health` 不做真实 CLI 调用；另加 `GET /api/boss/status` 跑一次轻量命令探测登录态（手动触发，不进自动轮询，避免无谓页面加载）。

## 9. 待实测清单（登录后执行，补回本文档）

- [ ] `boss login` 全流程（扫码 → 后续命令复用登录态）。
- [ ] `boss positions` 真实输出样本（脱敏存 `backend/tests/fixtures/positions.sample.txt`）。
- [ ] `boss list` / `boss list --unread` 样本（确认序号为位置序号、无 id）。
- [ ] `boss recommend <岗位>` 样本（确认输出行确实无 geekId）。
- [ ] `boss chat <姓名>` 样本（候选人摘要字段完整性、消息角色标签格式）。
- [ ] `boss search` 输出格式确认。
- [ ] 登录失效时的真实报错文案（与「menu-list」超时假设核对）。
- [ ] 锁竞争行为：两个终端同时跑只读命令，确认 30s 报错文案。
- [ ] Windows 下 Chrome 自动探测是否命中（或需 `CHROME_PATH`）。
- [ ] `boss jd <名称>` 生成缓存 md 的路径与命名（中文文件名、特殊字符替换 `_`）。

---

## 附：本调研覆盖的源码文件

`package.json`、`README.md`、`AGENTS.md`、`docs/boss-url-map.md`、`docs/browser-session.md`、`src/cli/cliRouter.ts`、`src/cli/version.ts`、`src/config.ts`、`src/browser/cdp_browser.ts`、`src/browser/browser_session.ts`、`src/common/boss_session_page.ts`、`src/common/boss_session_lock.ts`、`src/common/boss_availability.ts`、`src/toolset/{index,list,login,jd,recommend,chat}.ts`（chat.ts 部分）。
