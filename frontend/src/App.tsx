import { useEffect, useState } from "react";
import {
  Alert, Button, Card, Col, Descriptions, Empty, Input, Layout, List, Row, Select, Space, Spin, Statistic, Table, Tag, Typography, message,
} from "antd";
import { BugOutlined, CheckCircleOutlined, ReloadOutlined, SafetyOutlined, SyncOutlined } from "@ant-design/icons";
import {
  confirmAction, createAction, fetchCandidateDetail, fetchDebugStatus, fetchHealth, fetchLocalCandidates, fetchLocalJobs, fetchPolicy, matchCandidate, syncLocal, updateCandidate,
  type ActionResponse, type AgentPolicy, type CandidateDetail, type DebugStatus, type HealthResponse, type LocalCandidate, type LocalJob, type MatchResult,
} from "./api";

const { Header, Content, Footer } = Layout;
const stageOptions = ["new", "contacted", "communicating", "interview_pending", "interviewing", "decision", "offer", "hired", "rejected", "archived"];
const timingLabels: Record<string, string> = {
  "cli.update_check": "检查 boss-cli 更新", "cli.command": "执行命令（含子步骤）", "cli.cleanup": "断开浏览器连接",
  "session.lock_wait": "等待浏览器会话锁", "browser.ensure_session": "准备浏览器会话（含子步骤）",
  "browser.connect": "连接 Chrome", "browser.install_guards": "配置浏览器监听", "browser.select_page": "选择浏览器标签",
  "browser.install_page_guards": "初始化页面监听", "browser.close_blank_pages": "清理空白标签",
  "browser.bring_to_front": "激活浏览器标签", "browser.page_guards": "检查页面监听",
  "page.chat_shell": "检查或进入 BOSS 主页面", "page.sidebar_ready": "等待侧栏就绪",
  "positions.navigate": "进入职位管理", "positions.settle_delay": "岗位页面固定等待",
  "positions.rows_ready": "等待并提取岗位列表", "positions.after_rows_delay": "岗位读取后固定等待",
  "candidates.navigate": "进入沟通页", "candidates.filter_ready": "等待筛选栏",
  "candidates.filter_click": "切换候选人筛选", "candidates.filter_delay": "筛选后固定等待",
  "candidates.filter_selected": "确认筛选选中", "candidates.list_settled": "等待候选人列表稳定", "candidates.extract": "提取候选人文字",
  "backend.queue_wait": "后端排队", "backend.spawn": "启动 CLI 进程", "backend.first_output": "启动至首次数据输出",
  "backend.command_total": "CLI 总耗时（含子步骤和退出）", "backend.command_timeout": "CLI 超时",
  "backend.exit_wait": "清理完成后等待 CLI 退出和输出关闭",
  "backend.parse_jobs": "解析岗位输出", "backend.parse_candidates": "解析并分配候选人",
  "sync.jobs_total": "岗位阶段总耗时", "sync.candidates_total": "候选人阶段总耗时", "sync.database": "保存本地数据库", "sync.total": "本次同步总耗时",
};

function App() {
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [localJobs, setLocalJobs] = useState<LocalJob[]>([]);
  const [selectedJob, setSelectedJob] = useState<LocalJob | null>(null);
  const [localCandidates, setLocalCandidates] = useState<LocalCandidate[]>([]);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateDetail | null>(null);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);
  const [diagnosticLogPath, setDiagnosticLogPath] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState<DebugStatus | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [syncDebug, setSyncDebug] = useState<Record<string, unknown> | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionResponse | null>(null);

  // Browsing the dashboard reads local snapshots. Only sync contacts BOSS.
  const loadOverview = async () => {
    setLoading(true); setError(null);
    const [healthResult, localResult, policyResult, debugResult] = await Promise.allSettled([fetchHealth(), fetchLocalJobs(), fetchPolicy(), fetchDebugStatus()]);
    if (healthResult.status === "fulfilled") setHealth(healthResult.value);
    if (localResult.status === "fulfilled") setLocalJobs(localResult.value.jobs);
    if (policyResult.status === "fulfilled") setPolicy(policyResult.value);
    if (debugResult.status === "fulfilled") setDebugStatus(debugResult.value);
    const failed = [healthResult, localResult, policyResult].find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setError(failed.reason instanceof Error ? failed.reason.message : "部分数据读取失败");
    setLoading(false);
  };

  useEffect(() => { void loadOverview(); }, []);

  useEffect(() => {
    if (!syncing && !diagnosing) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await fetchDebugStatus(AbortSignal.timeout(8000));
        if (!stopped) setDebugStatus(result);
      } catch (reason) {
        if (!stopped) setSyncDebug((current) => ({ ...current, debug_refresh_error: reason instanceof Error ? reason.message : "读取进度失败" }));
      } finally {
        if (!stopped) timer = setTimeout(() => void poll(), 2000);
      }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [syncing, diagnosing]);

  const timingRows = debugStatus?.diagnostics.sync_id === debugStatus?.latest_sync?.id
    ? (debugStatus?.diagnostics.timings ?? []) : [];
  const activeStage = [...timingRows].reverse().find((row) => row.status === "running");

  const refreshDebug = async () => {
    setDebugLoading(true);
    try { setDebugStatus(await fetchDebugStatus()); }
    catch (reason) { setSyncDebug((current) => ({ ...(current ?? {}), debug_refresh_error: reason instanceof Error ? reason.message : "读取调试状态失败" })); }
    finally { setDebugLoading(false); }
  };

  const syncErrorText = (reason: unknown) => reason instanceof Error ? reason.message : "同步失败";

  const diagnosticPathFromError = (reason: unknown) => {
    const text = syncErrorText(reason);
    const match = text.match(/诊断日志：(.+)$/);
    return match?.[1]?.trim() || null;
  };

  const selectJob = async (job: LocalJob) => {
    setSelectedJob(job); setSelectedCandidate(null); setMatch(null); setCandidateLoading(true); setError(null);
    try {
      const result = await fetchLocalCandidates({ job_id: job.id, q: query || undefined });
      setLocalCandidates(result.candidates);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "读取候选人失败"); }
    finally { setCandidateLoading(false); }
  };

  const runSync = async () => {
    const startedAt = new Date().toISOString();
    setSyncing(true); setError(null); setSyncDebug({ phase: "sync.start", mode: "normal", scope: "all", started_at: startedAt });
    try {
      const result = await syncLocal();
      setDiagnosticLogPath(result.diagnostic_log ?? null);
      setSyncing(false);
      setSyncDebug({ phase: "sync.complete", mode: "normal", scope: result.scope, started_at: startedAt, finished_at: new Date().toISOString(), response: result });
      message.success(`同步完成：写入 ${result.records_written} 条`);
      await loadOverview();
    }
    catch (reason) {
      const errorText = syncErrorText(reason);
      setSyncDebug({ phase: "sync.failed", mode: "normal", scope: "all", started_at: startedAt, finished_at: new Date().toISOString(), error: errorText });
      setError(errorText);
      setSyncing(false);
      await refreshDebug();
    }
    finally { setSyncing(false); }
  };

  const runDiagnosticSync = async () => {
    const startedAt = new Date().toISOString();
    setDiagnosing(true); setError(null); setDiagnosticLogPath(null); setSyncDebug({ phase: "sync.start", mode: "diagnostic", scope: "all", started_at: startedAt });
    try {
      const result = await syncLocal("all", { diagnostic: true });
      setDiagnosing(false);
      const logPath = result.diagnostic_log ?? "data/diagnostics";
      setDiagnosticLogPath(logPath);
      setSyncDebug({ phase: "sync.complete", mode: "diagnostic", scope: result.scope, started_at: startedAt, finished_at: new Date().toISOString(), response: result });
      message.success("诊断完成，日志已保存");
      await loadOverview();
    } catch (reason) {
      const errorText = syncErrorText(reason);
      const logPath = diagnosticPathFromError(reason);
      if (logPath) setDiagnosticLogPath(logPath);
      setSyncDebug({ phase: "sync.failed", mode: "diagnostic", scope: "all", started_at: startedAt, finished_at: new Date().toISOString(), error: errorText, diagnostic_log: logPath });
      setError(errorText);
      setDiagnosing(false);
      await refreshDebug();
    }
    finally { setDiagnosing(false); }
  };

  const selectCandidate = async (candidate: LocalCandidate) => {
    try { setSelectedCandidate(await fetchCandidateDetail(candidate.id)); setMatch(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "读取候选人详情失败"); }
  };

  const changeStage = async (candidate: LocalCandidate, stage: string) => {
    try { const updated = await updateCandidate(candidate.id, { stage, reason: "看板人工更新" }); setLocalCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, stage: updated.stage, updated_at: updated.updated_at } : item)); if (selectedCandidate?.id === candidate.id) setSelectedCandidate(updated); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "阶段更新失败"); }
  };

  const runMatch = async () => {
    if (!selectedCandidate || !selectedJob || !("remote_id" in selectedJob)) return;
    try { setMatch(await matchCandidate(selectedCandidate.id, selectedJob.id)); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "匹配分析失败"); }
  };

  const draftMessage = async () => {
    if (!selectedCandidate) return;
    try { setAction(await createAction({ action_type: "send_message", candidate_id: selectedCandidate.id, job_id: "remote_id" in (selectedJob ?? {}) ? selectedJob?.id : undefined, payload: { text: "您好，感谢您关注这个岗位。方便补充一份简历吗？" } })); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "创建草稿失败"); }
  };

  const confirmDraft = async () => {
    if (!action) return;
    try { setAction(await confirmAction(action.id)); }
    catch (reason) { message.error(reason instanceof Error ? reason.message : "确认失败"); }
  };

  const localColumns = [
    { title: "候选人", dataIndex: "name", key: "name", render: (value: string, row: LocalCandidate) => <Button type="link" onClick={() => void selectCandidate(row)}>{value}</Button> },
    { title: "阶段", key: "stage", render: (_: unknown, row: LocalCandidate) => <Select size="small" value={row.stage} options={stageOptions.map((stage) => ({ value: stage, label: stage }))} onChange={(stage) => void changeStage(row, stage)} /> },
    { title: "标签", key: "tags", render: (_: unknown, row: LocalCandidate) => row.tags.map((tag) => <Tag key={tag}>{tag}</Tag>) },
    { title: "未读", dataIndex: "unread_count", key: "unread_count" },
    { title: "最近沟通", dataIndex: "latest_time", key: "latest_time" },
    { title: "最近消息", dataIndex: "latest_message", key: "latest_message", ellipsis: true },
  ];

  return <Layout className="app-shell">
    <Header className="app-header"><div className="brand-mark">AI Recruiter</div><Space><Tag color="blue">Stage 7 · 本地可控</Tag><Tag icon={<SafetyOutlined />} color={policy?.writes_enabled ? "orange" : "green"}>{policy?.writes_enabled ? "BOSS 写入已开启" : "BOSS 写入默认关闭"}</Tag></Space></Header>
    <Content className="app-content">
      <div className="hero-copy"><Typography.Title level={1}>招聘工作台</Typography.Title><Typography.Paragraph>先同步到本地，再在候选人详情中做标注、匹配和人工确认动作。</Typography.Paragraph></div>
      {error && <Alert closable onClose={() => setError(null)} message={error} type="warning" showIcon />}
      {(syncing || diagnosing) && <Alert message="正在同步岗位和候选人，读取岗位后还需要读取沟通列表，请稍候…" description={activeStage ? `${timingLabels[activeStage.stage] ?? activeStage.stage} · 已等待 ${activeStage.elapsed_seconds.toFixed(1)} 秒` : "详细进度会自动更新到下方调试信息。"} type="info" showIcon />}
      {diagnosticLogPath && <Alert closable onClose={() => setDiagnosticLogPath(null)} message="诊断日志已保存" description={diagnosticLogPath} type="info" showIcon />}
      <Row gutter={[20, 20]}>
        <Col xs={24} lg={8}><Card title="岗位" extra={<Space><Button size="small" icon={<SyncOutlined />} loading={syncing} disabled={diagnosing} onClick={() => void runSync()}>同步</Button><Button size="small" icon={<BugOutlined />} loading={diagnosing} disabled={syncing} onClick={() => void runDiagnosticSync()}>诊断同步</Button><Button size="small" icon={<ReloadOutlined />} onClick={() => void loadOverview()}>刷新</Button></Space>}>
          <Typography.Paragraph type="secondary">显示上次同步的数据；点击“同步”获取 BOSS 最新数据。</Typography.Paragraph>
          {loading ? <Spin /> : localJobs.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="本地暂无岗位，请点击同步" /> : <List<LocalJob> dataSource={localJobs} renderItem={(job) => <List.Item className={selectedJob && selectedJob.id === job.id ? "job-item job-item-selected" : "job-item"} onClick={() => void selectJob(job)}><Space direction="vertical" size={2}><Typography.Text strong>{job.title}</Typography.Text><Typography.Text type="secondary">{job.status}{job.label ? ` · ${job.label}` : ""}</Typography.Text></Space></List.Item>} />}
        </Card></Col>
        <Col xs={24} lg={16}><Card title="运行状态" extra={<SafetyOutlined />}><Row gutter={24}><Col><Statistic title="后端" value={health?.status === "ok" ? "正常" : "未知"} prefix={<CheckCircleOutlined />} /></Col><Col><Statistic title="岗位" value={localJobs.length} /></Col><Col><Statistic title="本地候选人" value={localCandidates.length} /></Col></Row><Typography.Text type="secondary">{health ? `${health.service} · v${health.version}` : "正在连接…"}</Typography.Text></Card></Col>
        <Col xs={24}><Card title={selectedJob ? `${selectedJob.title} · 候选人` : "候选人列表"} extra={selectedJob && <Input.Search placeholder="搜索姓名或负责人" allowClear value={query} onChange={(event) => setQuery(event.target.value)} onSearch={() => selectedJob && void selectJob(selectedJob)} style={{ width: 220 }} />}>
          {!selectedJob ? <Empty description="请选择一个岗位" /> : candidateLoading ? <Spin tip="正在读取候选人…" /> : <Table<LocalCandidate> rowKey="id" columns={localColumns} dataSource={localCandidates} locale={{ emptyText: "本地暂无候选人，请点击同步" }} pagination={{ pageSize: 10 }} scroll={{ x: 820 }} />}
        </Card></Col>
        {selectedCandidate && <Col xs={24} lg={10}><Card title={`${selectedCandidate.name} · 候选人详情`} extra={<Tag color="blue">{selectedCandidate.stage}</Tag>}><Descriptions column={1} size="small"><Descriptions.Item label="岗位">{selectedCandidate.job_titles.join("、") || "未绑定"}</Descriptions.Item><Descriptions.Item label="负责人">{selectedCandidate.owner || "未分配"}</Descriptions.Item><Descriptions.Item label="标签">{selectedCandidate.tags.join("、") || "暂无"}</Descriptions.Item><Descriptions.Item label="最近消息">{selectedCandidate.latest_message || "暂无"}</Descriptions.Item></Descriptions><Space wrap><Button onClick={() => void runMatch()} disabled={!selectedJob || !("remote_id" in selectedJob)}>生成匹配建议</Button><Button onClick={() => void draftMessage()}>生成消息草稿</Button></Space>{match && <Alert className="detail-alert" message={`匹配分 ${match.score} · ${match.recommendation}`} description={<Space direction="vertical"><Typography.Text>优势：{match.strengths.join("；") || "暂无充分证据"}</Typography.Text><Typography.Text>风险：{match.risks.join("；") || "暂无"}</Typography.Text><Typography.Text>待确认：{match.questions.join("；") || "暂无"}</Typography.Text></Space>} type="info" showIcon />}{action && <Alert className="detail-alert" message={`动作草稿：${action.status}`} description={<Space direction="vertical"><Typography.Text>{String(action.payload.text ?? "")}</Typography.Text><Button size="small" type="primary" disabled={action.status !== "pending_confirmation"} onClick={() => void confirmDraft()}>人工确认</Button></Space>} type={action.status === "blocked" ? "warning" : "success"} />}</Card></Col>}
        <Col xs={24}><Card title="安全边界"><Space direction="vertical"><Typography.Text>✓ 同步、标签、备注、阶段和匹配结果保存在本地数据库</Typography.Text><Typography.Text>✓ AI 输出标注证据与未知项，只作为人工参考</Typography.Text><Typography.Text>✓ BOSS 写动作必须先生成草稿，再人工确认；默认开关关闭</Typography.Text></Space></Card></Col>
        <Col xs={24}><Card title="调试信息" extra={<Button size="small" icon={<ReloadOutlined />} loading={debugLoading} onClick={() => void refreshDebug()}>刷新调试状态</Button>}>
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="前端同步状态">{String(syncDebug?.phase ?? "idle")}</Descriptions.Item>
            <Descriptions.Item label="后端进程">{debugStatus ? `PID ${debugStatus.runtime.pid} · Python ${debugStatus.runtime.python}` : "未知"}</Descriptions.Item>
            <Descriptions.Item label="当前执行命令">{debugStatus?.active_cli ? `${debugStatus.active_cli.command} · ${debugStatus.active_cli.command_id} · 已执行 ${debugStatus.active_cli.elapsed_seconds.toFixed(1)} 秒` : "空闲"}</Descriptions.Item>
            <Descriptions.Item label="当前命令日志">{debugStatus?.active_cli?.diagnostic_log ?? "无"}</Descriptions.Item>
            <Descriptions.Item label="后端版本">{health?.version ?? "未知"}</Descriptions.Item>
            <Descriptions.Item label="BOSS CLI">{debugStatus ? `${debugStatus.config.boss_cli_command} · ${debugStatus.config.boss_cli_entrypoint_exists ? "入口存在" : "入口不存在"}` : "未知"}</Descriptions.Item>
            <Descriptions.Item label="工作目录">{debugStatus?.runtime.cwd ?? "未知"}</Descriptions.Item>
            <Descriptions.Item label="最近同步">{debugStatus?.latest_sync ? `${debugStatus.latest_sync.status} · 已看 ${debugStatus.latest_sync.records_seen} · 写入 ${debugStatus.latest_sync.records_written}` : "暂无"}</Descriptions.Item>
            <Descriptions.Item label="诊断日志">{debugStatus?.diagnostics.latest_log ?? diagnosticLogPath ?? "暂无"}</Descriptions.Item>
            <Descriptions.Item label="最近错误">{debugStatus?.latest_sync?.error_summary || "无"}</Descriptions.Item>
          </Descriptions>
          {timingRows.length > 0 && <>
            <Typography.Paragraph type="secondary">本次同步各步骤耗时（秒）。总耗时包含子步骤，各行不能直接相加。同步期间每两秒自动刷新。</Typography.Paragraph>
            <Table size="small" pagination={false} dataSource={timingRows.map((row, key) => ({ ...row, key }))} columns={[
              { title: "命令", dataIndex: "command", render: (value: string) => value === "positions" ? "岗位" : value === "list" ? "候选人" : "同步" },
              { title: "步骤", dataIndex: "stage", render: (value: string) => timingLabels[value] ?? value },
              { title: "状态", dataIndex: "status", render: (value: string) => ({ running: "执行中", complete: "完成", failed: "失败", interrupted: "中断" })[value] ?? value },
              { title: "耗时（秒）", dataIndex: "elapsed_seconds", render: (value: number) => value.toFixed(3), sorter: (a, b) => a.elapsed_seconds - b.elapsed_seconds },
            ]} />
          </>}
          <pre className="debug-output">{JSON.stringify({ sync: syncDebug, backend: debugStatus }, null, 2)}</pre>
        </Card></Col>
      </Row>
    </Content><Footer className="app-footer">AI Recruiter · 本地数据可追踪 · {new Date().getFullYear()}</Footer>
  </Layout>;
}

export default App;
