# Boss URL 与功能对照

本文件记录 boss-cli 已知页面 URL、对应命令和当前位置要求。修改页面导航、命令入口或报错文案前，先对照这里，避免把某个命令改成隐式跳转或多路径兜底。

## 页面 URL

| URL / Path | 页面功能 | 相关命令 | 当前行为 |
| --- | --- | --- | --- |
| `https://www.zhipin.com/web/user/?ka=header-login` | 登录入口 | `boss login` | 直接打开登录页，交还给人工扫码/验证。 |
| `/web/chat/index` | 沟通列表、候选人会话页 | `boss list`、`boss list --unread`、`boss chat <姓名>`、`boss chat [姓名] --index <序号> [--unread]`、`boss send`、`boss action` | `list` / `chat` 会先检查当前位置，不在该页时直接进入；`chat --index` 使用 `boss list` 输出的 1-based 序号，带 `--unread` 时使用 `boss list --unread` 输出的序号；同时提供姓名时会校验序号对应候选人姓名，适合处理同名候选人；`send` / `action` 要求当前会话已打开。 |
| `/web/chat/recommend` | 推荐候选人列表 | `boss recommend`、`boss preview <姓名>`、`boss greet <姓名>` | `recommend` 会先检查当前位置，不在该页时直接进入；`preview` / `greet` 要求当前已在该页且列表已加载。 |
| `/web/chat/aiform` | 深度搜索 / Agent 搜索 | `boss deep-search [--core <要求>] [--bonus <加分项>] [--clear-core] [--clear-bonus] [--match]`、`boss preview <姓名>`、`boss greet <姓名>` | `deep-search` 会先检查当前位置，不在该页时直接进入；默认只输出招聘要求表单、核心要求、加分项、今日剩余匹配次数和按钮状态，不输出候选列表；`--core` / `--bonus` 可重复，并按传入列表同步对应分组（多余行会删除，不足会新增），`--clear-core` / `--clear-bonus` 清空对应分组；只有 `--match` 会消耗今日匹配次数并输出列表顶部最新 20 条；`preview` / `greet` 要求当前已在该页且列表已加载。 |
| `/web/chat/search` | 常规搜索 | `boss search [关键词]`、`boss preview <姓名>` | `search` 会先检查当前位置，不在该页时直接进入；带关键词时填入搜索框并回车搜索；`preview` 要求当前已在该页且列表已加载，不支持 `--job`。 |
| `/web/chat/job/list` | 职位管理列表（内容位于 `/web/frame/job_v2/list` iframe） | `boss positions`、`boss jd <name>` | 命令自动点击侧栏“职位管理”，等待 job_v2 iframe 加载后读取。 |

## 约定

- 当前 URL 校验优先于 DOM 猜测。命令依赖特定页面时，先检查 path，再执行页面读取或点击。
- 不为高风险操作添加隐式兜底跳转。需要用户处于特定页面的命令，应直接报出当前 URL 与目标 URL。
- 页面入口发生变化时，同步更新本文件和相关命令 help 文案。

## 本地耗时诊断

## AI HR 手动试读与沟通核验

- `boss recommend-greet --geek-id <ID> --name <姓名> --base-info <基本信息> --job-label <完整岗位标签>`：仅供用户在 AI HR 勾选并确认后调用。进入推荐页、关闭旧简历并精确切换岗位；在同一次 DOM 操作内再次核对完整岗位标签、唯一候选人 ID、姓名及基本信息（排除活跃/在线状态字段）后点击该卡片的“打招呼”。只处理已加载列表，未找到不扩展抓取，不按姓名降级匹配。遇付费/验证/限制弹窗停止，不点击购买或其他确认按钮。等待平台反馈，JSON 区分明确成功、已招呼、已点击但待核实、未找到、身份冲突、平台阻止。仅点击无明确成功证据不会报告已送达；异常不自动重试。


- `boss list --inspect-identities`：只读检查当前 DOM 的同名同岗位分组及行标识属性，不滚动、不打开会话，不输出姓名和消息正文。

- `boss list --inspect-scroll [--probe]`：诊断当前沟通列表的 DOM 层级、滚动尺寸与 CSS；默认不滚动。显式 `--probe` 只向下移动一个视口内的距离，检查位置变化并恢复原位；不打开会话，不输出姓名/消息。用于排查历史滚动容器定位失败。实际 BOSS 的 `.user-list.b-scroll-stable` 使用 `overflow:hidden`，历史读取直接定位这个列表并操作其原生 `scrollTop`，不能只根据 `overflow:auto/scroll` 判断。

- `boss recommend-jobs` 手动读取推荐页岗位下拉完整标签，不提取候选人。标签重复则报错，禁止模糊选择。
- `boss recommend [岗位关键字] [--job-label <完整标签>] [--limit 50] [--json]` 最多读取 50 人（CLI 未指定 limit 时仍默认 10，AI HR 固定传 20）。AI HR 使用 `--job-label` 精确匹配完整标签，不接受与关键字混用；读取前切换到对应岗位，读取结束再次核对岗位。普通关键词模式保留给其他 CLI 调用方。JSON 返回实际岗位标签、时间及列表。
- 增量读取使用 `--exclude-file <JSON文件>`，文件元素为 `{name, baseInfo}`。仅规范化空白，两个字段都相同才跳过；先读取这两个字段查重，再提取新人的详细卡片字段，最多返回50位新人。不足时向下滚动加载，每轮等待列表卡片变化（最长 5 秒），再提取和查重，找到上限立即停止；连续3次没有新卡片或累计15次滚动就返回实际结果及 `stop_reason`。不翻页、不打招呼、不打开简历。文件只在本地读取。
- `boss list --history --json [--since YYYY-MM-DD]`：供 AI HR 手动同步使用，切换全部沟通后从顶部滚动到列表底部。日期为北京时间所选日（含）至今；不凭单条旧会话停止，以免置顶/非时间排序漏人。底部连续 10 秒没有变化且未加载中才结束；10 分钟或 2000 次滚动保护上限、加载错误会报错，不返回部分成功。无法解析日期的人选保留并计数。普通 `list` 的当前列表/序号语义不变。
- `boss classify --targets <JSON数组>` 在 `/web/chat/index` 的全部列表中按 BOSS 会话 data-id 精确定位每批最多 10 个会话，并交叉核对姓名和来源岗位，保留已加载列表，目标不在 DOM 时从顶部滚动查找（含虚拟列表）；逐个打开并读取消息方向、求简历入口和双向回复限制提示。打开会话可能让 BOSS 标为已读。不会发送消息或请求简历；查找超时或无法唯一定位会显式返回失败原因。
- 双方消息或可用的求简历入口可证明双方沟通；单方分类必须同时有平台的双向回复限制提示。缺失/冲突的证据、缺少会话编号、编号与姓名/岗位不符、无法定位或超时均显式返回待核验及原因，禁止凭最近消息文案和未读数猜测。
- 推荐读取仍只由专门按钮触发；沟通历史读取和逐批核验由 AI HR 的“同步 BOSS 数据”触发，页面加载不触发。
- `boss recommend-resume --geek-id <ID> --name <姓名> --output <绝对PNG路径> [--job-label <完整标签>]`：进入 `/web/chat/recommend`，关闭旧简历面板；AI HR 传入来源岗位完整标签，切换并核对该岗位后再按卡片稳定 ID 和姓名精确核对后打开这一人的在线简历并截图。无法唯一匹配时明确报错，不按姓名模糊匹配或翻页搜索。输出结构化 JSON 元数据，图片直接存到指定本地文件；截图前恢复最小化窗口并置前，等待字体与布局稳定。文本简历核对正文姓名；BOSS 的单画布简历没有 DOM 文本，仅在新打开的卡片已通过 ID 和姓名核对时接受，等待实际截图像素有内容。按简历真实高度动态扩展视口，并检查画布从顶部覆盖完整正文，避免虚拟渲染遗漏长简历上半部分。每次截图都将简历内部及所有外层 frame 的滚动位置归零，等待位置和尺寸稳定；统一按主页面坐标截取，避免推荐列表滚动偏移重复叠加导致漏掉顶部头像。保存前再次检查 PNG 像素，空白或仅水印图片明确报错且不生成成功文件；不会自动重开简历重试或绕过平台限制。截图期间应保持 BOSS 窗口可见。不调用 OCR、不发送截图到第三方、不打招呼。平台要求付费或无权查看时明确报错。

设置 `BOSS_CLI_TIMING=true` 后，CLI 在 stderr 输出以 `[boss-cli][timing]` 开头的 JSON 事件，包含步骤名、开始/完成/失败状态、时间、PID、span_id 和耗时，不包含候选人正文。记录覆盖命令前的 npm 版本检查、会话锁、浏览器初始化、岗位与沟通页准备、列表提取及命令清理。计时不会改变上述命令的导航位置要求或等待策略；stdout 数据格式保持原样。

命令清理时除断开 CDP 外，还释放本次自行启动 Chrome 的 stdout/stderr 管道和子进程引用；不会关闭 Chrome。连接模式下 `browser.process()` 为 null，不能依靠它清理自行 spawn 的进程。回归验证：构建后运行 `node scripts/test-browser-detach.mjs`，使用独立无登录配置验证 CLI 退出而 Chrome 继续运行。

- 沟通历史 JSON 的每行包含 `sourceId`（BOSS DOM `data-id`）和 `legacyMatchUnique`。按会话编号积累，重复 DOM 的同一编号只保留一份；同名同岗位但编号不同保留为不同人。缺少编号的行单独报告 `unidentified`，继续其他人，不按姓名猜身份。`classify` 的每个目标必须含 `{id, sourceId, name, job}`；同名切换时还等待上一人的消息面板更新。
