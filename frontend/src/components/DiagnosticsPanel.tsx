import { Button, Collapse, Descriptions, Space, Table, Typography } from "antd";
import { BugOutlined, ReloadOutlined } from "@ant-design/icons";
import type { DebugStatus, HealthResponse } from "../api";

export const timingLabels: Record<string, string> = {
  "cli.update_check": "检查 boss-cli 更新", "cli.command": "执行命令（含子步骤）", "cli.cleanup": "断开浏览器连接",
  "session.lock_wait": "等待浏览器会话锁", "browser.ensure_session": "准备浏览器会话（含子步骤）",
  "browser.connect": "连接 Chrome", "browser.install_guards": "配置浏览器监听", "browser.select_page": "选择浏览器标签",
  "browser.install_page_guards": "初始化页面监听", "browser.close_blank_pages": "清理空白标签",
  "browser.bring_to_front": "激活浏览器标签", "browser.page_guards": "检查页面监听",
  "page.chat_shell": "检查或进入 BOSS 主页面", "page.sidebar_ready": "等待侧栏就绪",
  "positions.navigate": "进入职位管理", "positions.settle_delay": "岗位页面固定等待",
  "positions.rows_ready": "等待并提取岗位列表", "positions.after_rows_delay": "岗位读取后固定等待",
  "candidates.navigate": "进入沟通页", "candidates.filter_ready": "等待筛选栏",
  "candidates.history": "加载全部沟通历史", "candidates.history_scroll": "滚动加载历史会话",
  "candidates.filter_click": "切换候选人筛选", "candidates.filter_delay": "筛选后固定等待",
  "candidates.filter_selected": "确认筛选选中", "candidates.list_settled": "等待候选人列表稳定", "candidates.extract": "提取候选人文字",
  "backend.queue_wait": "后端排队", "backend.spawn": "启动 CLI 进程", "backend.first_output": "启动至首次数据输出",
  "backend.command_total": "CLI 总耗时（含子步骤和退出）", "backend.command_timeout": "CLI 超时",
  "backend.exit_wait": "清理完成后等待 CLI 退出和输出关闭",
  "backend.parse_jobs": "解析岗位输出", "backend.parse_candidates": "解析并分配候选人",
  "sync.jobs_total": "岗位阶段总耗时", "sync.candidates_total": "候选人阶段总耗时", "sync.database": "保存本地数据库", "sync.total": "本次同步总耗时",
};

type Props = {
  status: DebugStatus | null; health: HealthResponse | null; loading: boolean;
  busy: boolean; diagnosing: boolean; logPath: string | null;
  sync: Record<string, unknown> | null; onRefresh: () => void; onDiagnose: () => void;
};

export function DiagnosticsPanel({ status, health, loading, busy, diagnosing, logPath, sync, onRefresh, onDiagnose }: Props) {
  const rows = status?.diagnostics.sync_id === status?.latest_sync?.id ? status?.diagnostics.timings ?? [] : [];
  return <Collapse className="diagnostics" ghost items={[{
    key: "diagnostics", label: <span><BugOutlined /> 同步诊断与运行详情</span>,
    children: <div className="diagnostic-body">
      <div className="diagnostic-toolbar"><Typography.Text type="secondary">查看同步各环节耗时，排查读取问题。</Typography.Text><Space wrap>
        <Button icon={<ReloadOutlined />} loading={loading} onClick={onRefresh}>刷新状态</Button>
        <Button icon={<BugOutlined />} loading={diagnosing} disabled={busy && !diagnosing} onClick={onDiagnose}>诊断同步</Button>
      </Space></div>
      <Descriptions size="small" column={{ xs: 1, sm: 2 }} bordered>
        <Descriptions.Item label="后端版本">{health?.version ?? "未知"}</Descriptions.Item>
        <Descriptions.Item label="后端进程">{status?.runtime.pid ?? "未知"}</Descriptions.Item>
        <Descriptions.Item label="当前命令">{status?.active_cli ? `${status.active_cli.command} · ${status.active_cli.elapsed_seconds.toFixed(1)} 秒` : "空闲"}</Descriptions.Item>
        <Descriptions.Item label="最近同步">{status?.latest_sync ? ({ success: "成功", running: "进行中", failed: "失败" })[status.latest_sync.status] ?? status.latest_sync.status : "暂无"}</Descriptions.Item>
        <Descriptions.Item label="同步日志" span={2}><span className="break-text">{logPath ?? status?.diagnostics.latest_log ?? "暂无"}</span></Descriptions.Item>
        <Descriptions.Item label="当前命令日志" span={2}><span className="break-text">{status?.active_cli?.diagnostic_log ?? "无"}</span></Descriptions.Item>
        <Descriptions.Item label="最近错误" span={2}>{status?.latest_sync?.error_summary || "无"}</Descriptions.Item>
      </Descriptions>
      {rows.length > 0 && <>
        <p className="muted">各步骤耗时以秒计；总耗时包含子步骤，各行不能直接相加。同步时自动刷新。</p>
        <Table size="small" pagination={{ pageSize: 10, showSizeChanger: false }} scroll={{ x: 560 }} dataSource={rows.map((row, key) => ({ ...row, key }))} columns={[
          { title: "命令", dataIndex: "command", render: (value: string) => value === "positions" ? "岗位" : value === "list" ? "候选人" : "同步" },
          { title: "步骤", dataIndex: "stage", render: (value: string) => timingLabels[value] ?? value },
          { title: "状态", dataIndex: "status", render: (value: string) => ({ running: "执行中", complete: "完成", failed: "失败", interrupted: "中断" })[value] ?? value },
          { title: "耗时（秒）", dataIndex: "elapsed_seconds", render: (value: number) => value.toFixed(3), sorter: (a, b) => a.elapsed_seconds - b.elapsed_seconds },
        ]} />
      </>}
      <details className="raw-details"><summary>查看原始调试信息</summary><pre className="debug-output">{JSON.stringify({ sync, backend: status }, null, 2)}</pre></details>
    </div>,
  }]} />;
}
