# 同步排队与 CLI 退出故障

日期：2026-10-21，以下时间为北京时间。

## 证据

- 15:53:59 的同步：总耗时 118.362 秒，岗位命令排队 113.985 秒，实际岗位命令约 1.19 秒。此版本尚未记录锁占用者，不能从该文件确定前一个请求的身份。
- 16:01:21 的同步（`sync-20261021T080121.034132Z-304044f3.log`）：排队约 0.001 秒，CLI 自行启动 Chrome；第 7.861 秒已经输出岗位数据，`cli.cleanup` 于 16:01:28.919 完成，但进程没有退出，16:03:21 达到 120 秒超时。
- 此次更新检查约 0.004 秒，不能解释两分钟的等待。

## 原因

`cdp_browser.ts` 自行 `spawn()` Chrome，通过 stdout/stderr 管道取得 DevTools 地址，再通过 `puppeteer.connect()` 建立浏览器连接。`proc.unref()` 只移除了子进程本身对事件循环的引用，没有释放两条管道。

`browser_session.ts` 清理时尝试使用 `browser.process()`，但 connect 模式不拥有这个 ChildProcess，返回 null。原来的 `clearSpawnedChromeProcessRef()` 又只清空变量，没有关闭管道。因此首次启动 Chrome 的 CLI 在业务结束后仍保持运行，后端等到 120 秒超时才释放执行锁，后续请求就会长时间排队。复用已有 Chrome 的命令没有新建这些管道，因而通常很快。

Node 官方说明：detached/unref 之外，还需要解除连接到父进程的 stdio：<https://nodejs.org/api/child_process.html#optionsdetached>。

## 修复与验证

- 在释放实际保存的 Chrome ChildProcess 时，销毁本端 stdout/stderr 读取流，并执行 unref；断开 CDP 后调用此清理，不关闭 Chrome。
- 去掉依赖 `browser.process()` 的无效清理；无 Browser 引用时也释放自行启动的进程句柄。
- `node scripts/test-browser-detach.mjs` 使用独立、未登录的临时 Chrome 配置，验证启动浏览器、断开连接、CLI 自然退出以及浏览器仍可连接。修复前复现“断开后超过两秒仍未退出”；修复后整项测试约 0.499 秒通过。测试只关闭自己创建的浏览器。
- 16:06:01 实际只读诊断同步成功，HTTP 用时约 4.61 秒：岗位 1.34 秒、候选人 3.03 秒、数据库 0.21 秒、排队接近零、每条命令清理后退出约 0.01 秒。日志：`sync-20261021T080601.123740Z-91b56a25.log`。
- 真实同步验证复用了已有浏览器；冷启动释放问题由独立 Chrome 回归测试验证。实际业务耗时仍取决于页面加载和固定等待。

本次修复已构建到本机 boss-cli/dist。主项目已有的“页面仅读本地数据”优化减少了竞争来源；本修复解决首次启动 Chrome 的资源释放缺陷。后端执行锁与 120 秒命令超时保持原有策略。
