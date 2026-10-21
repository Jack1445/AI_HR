import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Avatar, Badge, Button, ConfigProvider, Descriptions, Drawer, Empty, Input, Select, Space, Spin, Table, Tag, Tooltip, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ArrowRightOutlined, CheckOutlined, ClockCircleOutlined, ReloadOutlined, SafetyOutlined, SearchOutlined, SyncOutlined, TeamOutlined } from "@ant-design/icons";
import { confirmAction, createAction, fetchCandidateDetail, fetchDebugStatus, fetchHealth, fetchLocalCandidates, fetchLocalJobs, fetchPolicy, matchCandidate, syncLocal, updateCandidate,
  type ActionResponse, type AgentPolicy, type CandidateDetail, type DebugStatus, type HealthResponse, type LocalCandidate, type LocalJob, type MatchResult } from "./api";
import { DiagnosticsPanel, timingLabels } from "./components/DiagnosticsPanel";
import { Recommendations } from './components/Recommendations';
import { verifyCommunications } from './api';

const communicationLabels = { all: '全部', outgoing: '我已招呼 · 对方未回', incoming: '对方招呼 · 我未回', mutual: '双方已沟通', unknown: '待核验' };
type CommunicationFilter = keyof typeof communicationLabels;

const jobStatuses = ["开放中", "待开放", "已关闭", "全部"];
const stageLabels: Record<string, string> = { new: "新候选人", contacted: "已联系", communicating: "沟通中", interview_pending: "待面试", interviewing: "面试中", decision: "待决定", offer: "已发录用", hired: "已入职", rejected: "已淘汰", archived: "已归档" };
const statusColor = (status: string) => status === "开放中" ? "green" : status === "待开放" ? "gold" : "default";
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : "操作失败，请重试";
function formatTime(value?: string | null) {
  if (!value) return "尚未同步";
  const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
}

function App() {
  const [messageApi, messageContext] = message.useMessage();
  const [activePage, setActivePage] = useState<'communications' | 'recommendations'>('communications');
  const [manualBusy, setManualBusy] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const verifyLock = useRef(false);
  const [communicationFilter, setCommunicationFilter] = useState<CommunicationFilter>('all');
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthFailed, setHealthFailed] = useState(false);
  const [policy, setPolicy] = useState<AgentPolicy | null>(null);
  const [jobs, setJobs] = useState<LocalJob[]>([]);
  const [jobStatus, setJobStatus] = useState("开放中");
  const [jobQuery, setJobQuery] = useState("");
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<LocalCandidate[]>([]);
  const [candidateTotal, setCandidateTotal] = useState(0);
  const [candidateQuery, setCandidateQuery] = useState("");
  const [candidatePage, setCandidatePage] = useState(1);
  const [candidateError, setCandidateError] = useState<string | null>(null);
  const [candidateLoading, setCandidateLoading] = useState(false);
  const [selectedCandidate, setSelectedCandidate] = useState<CandidateDetail | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [action, setAction] = useState<ActionResponse | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);
  const detailRequest = useRef(0);
  const candidateLoadGeneration = useRef(0);
  const [loading, setLoading] = useState(true);
  const [refreshToken, setRefreshToken] = useState(0);
  const [syncMode, setSyncMode] = useState<"normal" | "diagnostic" | null>(null);
  const syncLock = useRef(false);
  const [diagnosticLogPath, setDiagnosticLogPath] = useState<string | null>(null);
  const [debugStatus, setDebugStatus] = useState<DebugStatus | null>(null);
  const [debugLoading, setDebugLoading] = useState(false);
  const [syncDebug, setSyncDebug] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = syncMode !== null;

  const counts = useMemo(() => Object.fromEntries(jobStatuses.map((status) => [status, status === "全部" ? jobs.length : jobs.filter((job) => job.status.trim() === status).length])), [jobs]);
  const visibleJobs = useMemo(() => jobs.filter((job) => (jobStatus === "全部" || job.status.trim() === jobStatus) && job.title.toLowerCase().includes(jobQuery.trim().toLowerCase())), [jobs, jobStatus, jobQuery]);
  const selectedJob = visibleJobs.find((job) => job.id === selectedJobId) ?? visibleJobs[0] ?? null;
  const communicationCounts = useMemo(() => Object.fromEntries(Object.keys(communicationLabels).map(key => [key, key === 'all' ? candidates.length : candidates.filter(row => (row.communication_status ?? 'unknown') === key).length])), [candidates]);
  const filteredCandidates = useMemo(() => candidates.filter(row => communicationFilter === 'all' || (row.communication_status ?? 'unknown') === communicationFilter), [candidates, communicationFilter]);
  const timingRows = debugStatus?.diagnostics.sync_id === debugStatus?.latest_sync?.id ? debugStatus?.diagnostics.timings ?? [] : [];
  const activeStage = [...timingRows].reverse().find((row) => row.status === "running");

  // All dashboard reads use local snapshots. Only the sync action contacts BOSS.
  const loadOverview = async () => {
    setLoading(true); setError(null);
    const results = await Promise.allSettled([fetchHealth(), fetchLocalJobs(), fetchPolicy(), fetchDebugStatus()] as const);
    const [h, j, p, d] = results;
    setHealthFailed(h.status === "rejected");
    setHealth(h.status === "fulfilled" ? h.value : null);
    if (j.status === "fulfilled") { setJobs(j.value.jobs); setRefreshToken((value) => value + 1); }
    if (p.status === "fulfilled") setPolicy(p.value);
    if (d.status === "fulfilled") setDebugStatus(d.value);
    const failed = results.find((result) => result.status === "rejected");
    if (failed?.status === "rejected") setError(errorText(failed.reason));
    setLoading(false);
  };
  useEffect(() => { void loadOverview(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    candidateLoadGeneration.current += 1;
    setCandidates([]); setCandidateTotal(0); setCandidatePage(1); setCandidateError(null);
    setDrawerOpen(false); setSelectedCandidate(null); setMatch(null); setAction(null); setDetailBusy(false);
    detailRequest.current += 1;
    if (!selectedJob) { setCandidateLoading(false); return () => controller.abort(); }
    const id = selectedJob.id;
    setCandidateLoading(true);
    const timer = setTimeout(() => {
      void fetchLocalCandidates({ job_id: id, q: candidateQuery.trim() || undefined, limit: '500' }, controller.signal)
        .then((result) => { if (!controller.signal.aborted) { setCandidates(result.candidates); setCandidateTotal(result.total); } })
        .catch((reason) => { if (!controller.signal.aborted) setCandidateError(errorText(reason)); })
        .finally(() => { if (!controller.signal.aborted) setCandidateLoading(false); });
    }, candidateQuery ? 250 : 0);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [selectedJob?.id, candidateQuery, refreshToken]);

  useEffect(() => {
    if (!busy) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { const result = await fetchDebugStatus(AbortSignal.timeout(8000)); if (!stopped) setDebugStatus(result); }
      catch (reason) { if (!stopped) setSyncDebug((current) => ({ ...current, debug_refresh_error: errorText(reason) })); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), 2000); }
    };
    void poll();
    return () => { stopped = true; clearTimeout(timer); };
  }, [busy]);

  const refreshDebug = async () => {
    setDebugLoading(true);
    try { setDebugStatus(await fetchDebugStatus()); }
    catch (reason) { messageApi.error(errorText(reason)); }
    finally { setDebugLoading(false); }
  };
  const runSync = async (diagnostic = false) => {
    if (syncLock.current || manualBusy) return;
    syncLock.current = true;
    const startedAt = new Date().toISOString();
    setSyncMode(diagnostic ? "diagnostic" : "normal"); setError(null); setDiagnosticLogPath(null);
    setSyncDebug({ phase: "sync.start", diagnostic, started_at: startedAt });
    try {
      const result = await syncLocal("all", { diagnostic });
      setDiagnosticLogPath(result.diagnostic_log ?? null);
      setSyncDebug({ phase: "sync.complete", started_at: startedAt, finished_at: new Date().toISOString(), response: result });
      messageApi.success("同步完成，已更新岗位和候选人");
      setSyncMode(null);
      await loadOverview();
    } catch (reason) {
      const text = errorText(reason);
      setError(text); setDiagnosticLogPath(text.match(/诊断日志：(.+)$/)?.[1]?.trim() ?? null);
      setSyncDebug({ phase: "sync.failed", started_at: startedAt, error: text });
      setSyncMode(null); await refreshDebug();
    } finally { setSyncMode(null); syncLock.current = false; }
  };

  const verifyPage = async () => {
    if (verifyLock.current || busy || manualBusy) return;
    const ids = filteredCandidates.slice((candidatePage - 1) * 10, candidatePage * 10).map(row => row.id);
    if (!ids.length) return;
    verifyLock.current = true; setVerifying(true); setManualBusy(true);
    const request = candidateLoadGeneration.current;
    try {
      const result = await verifyCommunications(ids);
      if (request === candidateLoadGeneration.current) {
        setCandidates(rows => rows.map(row => result.candidates.find(item => item.id === row.id) ?? row));
        setCandidatePage(1);
      }
      const known = result.candidates.filter(row => row.communication_status !== 'unknown').length;
      messageApi.info(`已核验 ${result.total} 人，${known} 人已分类，${result.total - known} 人待确认`);
    } catch (reason) { messageApi.error(errorText(reason)); }
    finally { verifyLock.current = false; setVerifying(false); setManualBusy(false); }
  };

  const closeDrawer = () => { detailRequest.current += 1; setDrawerOpen(false); setDetailBusy(false); };
  const selectCandidate = async (candidate: LocalCandidate) => {
    const request = ++detailRequest.current;
    setDrawerOpen(true); setDetailLoading(true); setSelectedCandidate(null); setMatch(null); setAction(null); setDetailBusy(false);
    try { const detail = await fetchCandidateDetail(candidate.id); if (request === detailRequest.current) setSelectedCandidate(detail); }
    catch (reason) { if (request === detailRequest.current) { messageApi.error(errorText(reason)); setDrawerOpen(false); } }
    finally { if (request === detailRequest.current) setDetailLoading(false); }
  };
  const changeStage = async (candidate: LocalCandidate, stage: string) => {
    try {
      const updated = await updateCandidate(candidate.id, { stage, reason: "看板人工更新" });
      setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, stage: updated.stage, updated_at: updated.updated_at } : item));
      setSelectedCandidate((current) => current?.id === candidate.id ? updated : current);
      messageApi.success("招聘阶段已更新");
    } catch (reason) { messageApi.error(errorText(reason)); }
  };
  const detailOperation = async (kind: "match" | "draft" | "confirm") => {
    if (!selectedCandidate || !selectedJob || detailBusy) return;
    const request = detailRequest.current;
    setDetailBusy(true);
    try {
      if (kind === "match") {
        const result = await matchCandidate(selectedCandidate.id, selectedJob.id);
        if (request === detailRequest.current) setMatch(result);
      } else if (kind === "draft") {
        const result = await createAction({ action_type: "send_message", candidate_id: selectedCandidate.id, job_id: selectedJob.id, payload: { text: "您好，感谢您关注这个岗位。方便补充一份简历吗？" } });
        if (request === detailRequest.current) setAction(result);
      } else if (action) {
        const result = await confirmAction(action.id);
        if (request === detailRequest.current) setAction(result);
      }
    } catch (reason) { messageApi.error(errorText(reason)); }
    finally { if (request === detailRequest.current) setDetailBusy(false); }
  };

  const columns = [
    { title: "候选人", key: "name", width: 160, render: (_: unknown, row: LocalCandidate) => <button className="candidate-name" onClick={() => void selectCandidate(row)}><Avatar size={30}>{row.name.slice(0, 1)}</Avatar><span>{row.name}</span></button> },
    { title: '沟通状态', key: 'communication', width: 175, render: (_: unknown, row: LocalCandidate) => <Tooltip title={row.communication_error || (row.communication_checked_at ? `核验于 ${formatTime(row.communication_checked_at)}` : '点击“核验当前页”读取双方沟通状态')}><Tag color={row.communication_status === 'mutual' ? 'green' : row.communication_status === 'incoming' ? 'blue' : undefined}>{communicationLabels[row.communication_status ?? 'unknown']}</Tag></Tooltip> },
    { title: "招聘阶段", key: "stage", width: 132, render: (_: unknown, row: LocalCandidate) => <Select aria-label={`${row.name}的招聘阶段`} size="small" value={row.stage} style={{ width: 108 }} options={Object.entries(stageLabels).map(([value, label]) => ({ value, label }))} onChange={(stage) => void changeStage(row, stage)} /> },
    { title: "最近消息", dataIndex: "latest_message", key: "message", ellipsis: true, render: (value: string) => <span className="message-preview">{value || "暂无消息"}</span> },
    { title: "最近沟通", dataIndex: "latest_time", key: "time", width: 100, render: (value: string) => value || "—" },
    { title: "未读", dataIndex: "unread_count", key: "unread", width: 64, render: (value: number) => value ? <Badge count={value} color="#16846c" /> : <span className="muted">—</span> },
    { title: "标签", key: "tags", width: 110, render: (_: unknown, row: LocalCandidate) => row.tags.length ? <Space size={[0, 4]} wrap>{row.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <span className="muted">—</span> },
  ];
  const healthy = health?.status === "ok";
  const lastSync = debugStatus?.latest_sync;
  const syncLabel = lastSync?.status === "success" ? `最近同步 ${formatTime(lastSync.finished_at)}` : lastSync?.status === "running" ? "同步进行中" : lastSync?.status === "failed" ? "最近同步未完成" : "尚未同步";

  return <ConfigProvider locale={zhCN} theme={{ token: { colorPrimary: "#147d68", colorInfo: "#147d68", colorSuccess: "#16846c", borderRadius: 9, fontFamily: '"Inter", "PingFang SC", "Microsoft YaHei", sans-serif', colorText: "#263d38", colorTextSecondary: "#71817c", colorBorder: "#dde6e1" }, components: { Table: { headerBg: "#f6f8f7", headerColor: "#71817c", rowHoverBg: "#f4faf7" } } }}>
    {messageContext}
    <div className="app-shell">
      <header className="app-header"><a href="#" className="brand"><span className="brand-icon"><TeamOutlined /></span><span>AI Recruiter</span><span className="brand-divider" /><span className="brand-subtitle">招聘工作台</span></a>
        <div className="header-status"><Tooltip title={health ? `后端 v${health.version}` : "连接状态"}><span role="status" className="connection-status"><span className={`status-dot ${healthy ? "is-online" : healthFailed ? "is-offline" : "is-pending"}`} />{healthy ? "服务正常" : healthFailed ? "连接异常" : "连接中"}</span></Tooltip><span className="header-separator" /><Tooltip title="所有外部写入操作均需人工确认"><span className={`policy-status ${policy?.writes_enabled ? "writes-enabled" : ""}`}><SafetyOutlined /> {policy ? policy.writes_enabled ? "外部写入已开启" : "只读连接" : "权限检查中"}</span></Tooltip></div>
      </header>
      <main className="app-content">
        <nav className="workspace-navigation" aria-label="工作区"><button aria-pressed={activePage === 'communications'} disabled={manualBusy} onClick={() => setActivePage('communications')}>沟通候选人</button><button aria-pressed={activePage === 'recommendations'} disabled={manualBusy} onClick={() => setActivePage('recommendations')}>推荐牛人</button></nav>
        <div hidden={activePage !== 'communications'}>
        <section className="page-heading"><div><div className="eyebrow">RECRUITMENT WORKSPACE</div><h1>找到合适的人，推进每一步</h1><p>按岗位查看候选人，管理沟通与招聘进度。</p></div>
          <div className="heading-actions"><span className="sync-meta"><ClockCircleOutlined /> {syncLabel}</span><Space><Tooltip title="刷新本地数据"><Button aria-label="刷新本地数据" icon={<ReloadOutlined />} loading={loading} disabled={busy || manualBusy} onClick={() => void loadOverview()} /></Tooltip><Button type="primary" icon={<SyncOutlined />} loading={busy} disabled={loading || manualBusy} onClick={() => void runSync()}>同步 BOSS 数据</Button></Space></div>
        </section>
        <div className="page-alerts">
          {error && <Alert closable onClose={() => setError(null)} message={error} type="warning" showIcon />}
          {busy && <Alert type="info" showIcon icon={<SyncOutlined spin />} message={activeStage ? `${timingLabels[activeStage.stage] ?? activeStage.stage} · ${activeStage.elapsed_seconds.toFixed(1)} 秒` : "正在同步岗位与候选人…"} />}
        </div>
        <div className="workspace-grid">
          <aside className="jobs-panel panel" aria-label="岗位列表">
            <div className="panel-heading"><h2>招聘岗位 <span className="count-pill">{jobs.length}</span></h2><span className="muted">选择岗位查看候选人</span></div>
            <div className="job-filters"><div className="status-tabs" role="group" aria-label="岗位状态筛选">{jobStatuses.map((status) => <button key={status} type="button" aria-pressed={jobStatus === status} className={jobStatus === status ? "status-tab active" : "status-tab"} onClick={() => { setJobStatus(status); setCandidateQuery(""); }}><span>{status}</span><span className="tab-count">{counts[status]}</span></button>)}</div>
              <Input aria-label="搜索岗位" placeholder="搜索岗位名称" prefix={<SearchOutlined />} allowClear value={jobQuery} onChange={(event) => { setJobQuery(event.target.value); setCandidateQuery(""); }} />
            </div>
            <div className="jobs-scroll" aria-busy={loading}>
              {loading ? <div className="panel-loading"><Spin /><span>正在读取岗位</span></div> : visibleJobs.length === 0 ? <div className="jobs-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={jobs.length === 0 ? "还没有同步岗位" : jobQuery ? "没有找到匹配的岗位" : `暂无${jobStatus}岗位`} />{jobs.length === 0 ? <Button type="primary" loading={busy} onClick={() => void runSync()}>立即同步</Button> : <Button type="link" onClick={() => { setJobStatus("全部"); setJobQuery(""); }}>查看全部岗位</Button>}</div> : visibleJobs.map((job) => <button key={job.id} type="button" className={`job-item ${selectedJob?.id === job.id ? "job-item-selected" : ""}`} aria-pressed={selectedJob?.id === job.id} onClick={() => { setSelectedJobId(job.id); setCandidateQuery(""); }}><div className="job-item-title"><span>{job.title}</span>{selectedJob?.id === job.id && <ArrowRightOutlined />}</div><div className="job-item-meta"><Tag color={statusColor(job.status.trim())} bordered={false}>{job.status}</Tag>{job.label && <span>{job.label}</span>}</div><div className="job-item-description">{job.meta.slice(0, 3).join(" · ") || "点击查看该岗位候选人"}</div></button>)}
            </div>
            <div className="panel-footnote">显示 {visibleJobs.length} / {jobs.length} 个岗位 · 本地同步数据</div>
          </aside>
          <section className="candidates-panel panel" aria-label="候选人列表">
            <div className="candidate-heading"><div><div className="section-kicker">{selectedJob ? "当前岗位" : "候选人工作区"}</div><h2>{selectedJob?.title ?? "选择岗位，开始筛选"}</h2>{selectedJob && <div className="candidate-summary"><Tag bordered={false} color={statusColor(selectedJob.status.trim())}>{selectedJob.status}</Tag><span>{candidateLoading ? "正在加载候选人…" : `已载入 ${candidateTotal} 位候选人`}</span></div>}</div><div className="candidate-heading-icon"><TeamOutlined /></div></div>
            {selectedJob && <div className="candidate-toolbar"><h3>候选人 <span className="count-pill">{candidateTotal}</span></h3><Input aria-label="搜索候选人" prefix={<SearchOutlined />} placeholder="搜索姓名或负责人" allowClear value={candidateQuery} onChange={(event) => setCandidateQuery(event.target.value)} /></div>}
            {selectedJob && <div className="communication-controls">
              <div className="communication-tabs" role="group" aria-label="沟通状态筛选">{(Object.keys(communicationLabels) as CommunicationFilter[]).map(key => <button key={key} aria-pressed={communicationFilter === key} onClick={() => { setCommunicationFilter(key); setCandidatePage(1); }}>{communicationLabels[key]} <span>{communicationCounts[key]}</span></button>)}</div>
              <div className="communication-help"><span>双方已沟通后可申请附件简历，仍需对方提供。待核验人员不计入三类。</span><Tooltip title="读取当前页最多10人的会话状态，BOSS可能标记为已读；不会发送消息或请求附件"><Button size="small" loading={verifying} disabled={busy || manualBusy || candidateLoading || !filteredCandidates.length} onClick={() => void verifyPage()}>核验当前页（最多10人）</Button></Tooltip></div>
              <div className="communication-read-note">核验会打开 BOSS 会话，可能将消息标记为已读。</div>
            </div>}
            {candidateError && <Alert type="warning" showIcon message={candidateError} action={<Button size="small" onClick={() => setRefreshToken((value) => value + 1)}>重试</Button>} />}
            {!selectedJob ? <div className="candidate-empty"><TeamOutlined /><h3>{jobs.length ? "没有符合筛选条件的岗位" : "从同步第一个岗位开始"}</h3><p>{jobs.length ? "调整左侧筛选条件，即可查看对应候选人。" : "点击上方同步按钮，读取你的岗位与候选人。"}</p></div> : <Table<LocalCandidate> className="candidate-table" size="middle" rowKey="id" columns={columns} dataSource={filteredCandidates} loading={candidateLoading} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={candidateError ? "候选人读取失败，请重试" : (candidateQuery || communicationFilter !== "all") ? "当前分类没有候选人，可切回全部或核验待确认人员" : "该岗位暂无已同步的沟通候选人"} /> }} pagination={{ current: candidatePage, onChange: setCandidatePage, pageSize: 10, showSizeChanger: false, hideOnSinglePage: true, showTotal: (total) => `共 ${total} 位` }} scroll={{ x: 915, y: 380 }} />}
            <div className="candidate-footnote"><CheckOutlined /> 本地标注会保留，不会被后续同步覆盖</div>
          </section>
        </div>
        </div>
        {activePage === 'recommendations' && <Recommendations busy={busy || manualBusy} setBusy={setManualBusy} />}
        <DiagnosticsPanel status={debugStatus} health={health} loading={debugLoading} busy={busy || manualBusy} diagnosing={syncMode === "diagnostic"} logPath={diagnosticLogPath} sync={syncDebug} onRefresh={() => void refreshDebug()} onDiagnose={() => void runSync(true)} />
        <footer className="app-footer"><span>AI Recruiter · 让招聘更有序</span><span><SafetyOutlined /> 外部操作需人工确认 · 匹配建议仅供参考</span></footer>
      </main>
      <Drawer title="候选人详情" open={drawerOpen} onClose={closeDrawer} width={560} className="candidate-drawer" destroyOnClose>
        {detailLoading ? <div className="panel-loading"><Spin /><span>正在读取详情</span></div> : selectedCandidate && <>
          <div className="profile-heading"><Avatar size={52}>{selectedCandidate.name.slice(0, 1)}</Avatar><div><h2>{selectedCandidate.name}</h2><Tag color="green">{stageLabels[selectedCandidate.stage] ?? selectedCandidate.stage}</Tag></div></div>
          <Descriptions column={1} size="small" className="profile-info"><Descriptions.Item label="关联岗位">{selectedCandidate.job_titles.join("、") || "未绑定"}</Descriptions.Item><Descriptions.Item label="负责人">{selectedCandidate.owner || "未分配"}</Descriptions.Item><Descriptions.Item label="标签">{selectedCandidate.tags.join("、") || "暂无"}</Descriptions.Item><Descriptions.Item label="最近消息">{selectedCandidate.latest_message || "暂无"}</Descriptions.Item></Descriptions>
          <div className="communication-detail"><h3>{communicationLabels[selectedCandidate.communication_status ?? 'unknown']}</h3><p>{selectedCandidate.communication_error || (selectedCandidate.communication_checked_at ? `核验时间：${formatTime(selectedCandidate.communication_checked_at)}` : '尚未核验。关闭详情后，可点击列表上方“核验当前页”。')}</p>{selectedCandidate.communication_evidence && <><p>我方消息：{selectedCandidate.communication_evidence.recruiter_sent ? '已检测到' : '当前记录未检测到'} · 对方消息：{selectedCandidate.communication_evidence.candidate_sent ? '已检测到' : '当前记录未检测到'}</p><p>申请附件入口：{selectedCandidate.communication_evidence.request_resume_enabled === true ? '可用' : selectedCandidate.communication_evidence.request_resume_enabled === false ? '不可用' : '未识别'} · 附件卡片：{selectedCandidate.communication_evidence.attachment_present ? '已检测到（未下载）' : '当前记录未检测到'}</p></>}</div>
          <Space wrap><Button type="primary" loading={detailBusy} onClick={() => void detailOperation("match")}>生成匹配建议</Button><Button disabled={detailBusy} onClick={() => void detailOperation("draft")}>生成消息草稿</Button></Space>
          {match && <Alert className="detail-alert" message={`匹配分 ${match.score} · ${match.recommendation}`} description={<Space direction="vertical"><span>优势：{match.strengths.join("；") || "暂无充分证据"}</span><span>待补充：{match.risks.join("；") || "暂无"}</span><span>待确认：{match.questions.join("；") || "暂无"}</span></Space>} type="info" showIcon />}
          {action && <Alert className="detail-alert" message={`消息草稿 · ${({ pending_confirmation: "待确认", success: "已完成", blocked: "未执行", failed: "失败", cancelled: "已取消" })[action.status] ?? action.status}`} description={<Space direction="vertical"><span>{String(action.payload.text ?? "")}</span>{Boolean(action.result.reason) && <span>{String(action.result.reason)}</span>}<Button size="small" type="primary" loading={detailBusy} disabled={action.status !== "pending_confirmation"} onClick={() => void detailOperation("confirm")}>人工确认</Button></Space>} type={action.status === "blocked" ? "warning" : "info"} />}
        </>}
      </Drawer>
    </div>
  </ConfigProvider>;
}

export default App;
