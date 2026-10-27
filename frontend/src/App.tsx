import { useEffect, useMemo, useRef, useState } from "react";
import { Alert, Avatar, Badge, Button, ConfigProvider, Descriptions, Drawer, Empty, Input, Progress, Space, Spin, Tag, Tooltip, message } from "antd";
import zhCN from "antd/locale/zh_CN";
import { ArrowRightOutlined, CheckOutlined, ClockCircleOutlined, ReloadOutlined, SafetyOutlined, SearchOutlined, SyncOutlined, TeamOutlined } from "@ant-design/icons";
import { confirmAction, createAction, fetchCandidateDetail, fetchDebugStatus, fetchHealth, fetchAllLocalCandidates, updateCandidateTags, fetchLocalJobs, fetchPolicy, matchCandidate, syncLocal, updateCandidate,
  type ActionResponse, type AgentPolicy, type CandidateDetail, type DebugStatus, type HealthResponse, type LocalCandidate, type LocalJob, type MatchResult } from "./api";
import { DiagnosticsPanel, timingLabels } from "./components/DiagnosticsPanel";
import { Recommendations } from './components/Recommendations';
import type { RecommendationActivity } from './recommendationBatch';
import { ManagedTable, type ManagedField } from './components/ManagedTable';
import { CommunicationRecycleBin } from './components/CommunicationRecycleBin';
import { beijingDate, type CellValue } from './tableModel';
import { verifyCommunications } from './api';
import { selectVerificationCandidates, verifyCommunicationBatch, type CommunicationProgress, type CommunicationResult } from './communicationBatch';

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
  const [recommendationActivity, setRecommendationActivity] = useState<RecommendationActivity | null>(null);
  const [syncSince, setSyncSince] = useState(() => localStorage.getItem('ai-hr.communication-since') ?? '');
  const [syncNotice, setSyncNotice] = useState('');
  const [verificationRange, setVerificationRange] = useState('');
  const today = beijingDate(new Date().toISOString());
  const [verificationProgress, setVerificationProgress] = useState<CommunicationProgress | null>(null);
  const [verificationResult, setVerificationResult] = useState<CommunicationResult | null>(null);
  const [syncPhase, setSyncPhase] = useState<"sync" | "verify">("sync");
  const [candidateLoadedToken, setCandidateLoadedToken] = useState(-1);
  const loadedJobId = useRef<string | null>(null);
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
    return j.status === "fulfilled";
  };
  useEffect(() => { void loadOverview(); }, []);

  useEffect(() => {
    const controller = new AbortController();
    candidateLoadGeneration.current += 1;
    if (loadedJobId.current !== (selectedJob?.id ?? null)) { setCandidates([]); setCandidateTotal(0); }
    loadedJobId.current = selectedJob?.id ?? null;
    setCandidateError(null);
    setDrawerOpen(false); setSelectedCandidate(null); setMatch(null); setAction(null); setDetailBusy(false);
    detailRequest.current += 1;
    if (!selectedJob) { setCandidateLoading(false); return () => controller.abort(); }
    const id = selectedJob.id;
    setCandidateLoading(true);
    const timer = setTimeout(() => {
      void fetchAllLocalCandidates({ job_id: id }, controller.signal)
        .then((result) => { if (!controller.signal.aborted) { setCandidates(result.candidates); setCandidateTotal(result.total); setCandidateLoadedToken(refreshToken); } })
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
  const verifyAllCommunications = async (ids: string[]) => {
    // The backend returns every in-range ID across all jobs, after recycle exclusions.
    const people = await fetchAllLocalCandidates();
    const result = await verifyCommunicationBatch(selectVerificationCandidates(people.candidates, ids), verifyCommunications, updated => {
      setCandidates(rows => rows.map(row => updated.find(item => item.id === row.id) ?? row));
      setSelectedCandidate(current => {
        const update = updated.find(item => item.id === current?.id);
        return current && update ? { ...current, ...update } : current;
      });
    }, progress => {
      setVerificationProgress(progress);
      setSyncDebug(current => ({ ...current, phase: 'communication.verify.all', verification: progress }));
    });
    setVerificationResult(result);
    setSyncDebug(current => ({ ...current, phase: result.failed ? 'communication.verify.partial' : 'communication.verify.complete', finished_at: new Date().toISOString(), verification: result }));
    return result;
  };
  const runSync = async (diagnostic = false) => {
    if (syncLock.current || manualBusy) return;
    if (syncSince && syncSince > today) { messageApi.error('起始日期不能晚于今天'); return; }
    syncLock.current = true;
    setSyncNotice('');
    setVerificationRange(syncSince ? `${syncSince} 至今（含当天）` : '全部历史');
    let synced = false;
    const startedAt = new Date().toISOString();
    setSyncMode(diagnostic ? "diagnostic" : "normal"); setSyncPhase("sync"); setError(null); setDiagnosticLogPath(null);
    setVerificationProgress(null); setVerificationResult(null);
    setSyncDebug({ phase: "sync.start", diagnostic, started_at: startedAt });
    try {
      const result = await syncLocal("all", { diagnostic, since: syncSince || undefined });
      synced = true;
      const summary = result.history_summary;
      const notices = [
        summary?.scanned !== undefined ? `已遍历 ${summary.scanned} 个历史会话，本次范围内 ${summary.in_range} 人` : '',
        summary?.undated ? `${summary.undated} 人日期无法识别，已纳入核验` : '',
        summary?.unmatched ? `${summary.unmatched} 人的来源岗位无法匹配当前岗位，未入库，需检查来源岗位` : '',
        summary?.unidentified ? `${summary.unidentified} 组会话缺少 BOSS 编号，已跳过并继续其他人` : '',
        summary?.ambiguous_legacy ? `${summary.ambiguous_legacy} 条旧记录遇到同名会话，已保留原标注并标为待确认；新会话分别入库` : '',
      ].filter(Boolean);
      setSyncNotice(notices.join('；'));
      setDiagnosticLogPath(result.diagnostic_log ?? null);
      setSyncPhase("verify"); setCandidateError(null);
      setSyncDebug({ phase: "communication.verify.all", started_at: startedAt, response: result });
      await loadOverview();
      const verified = await verifyAllCommunications(result.verification_ids);
      // Re-read after all batches so a concurrent local render cannot retain old status.
      setRefreshToken(value => value + 1);
      if (verified.failed || summary?.unmatched || summary?.unidentified || summary?.ambiguous_legacy) messageApi.warning(`本次核验已处理 ${verified.total} 人，${verified.failed} 人失败；其他需确认项请查看同步提示`);
      else messageApi.success(`本次范围更新完成，已核验 ${verified.total} 人：${verified.classified} 人已分类，${verified.unknown} 人待确认`);
    } catch (reason) {
      const text = errorText(reason);
      setError(synced ? `数据已同步保存，本次范围核验未完成：${text}。可点击“重新同步核验”重试。` : text);
      if (!synced) setDiagnosticLogPath(text.match(/诊断日志：(.+)$/)?.[1]?.trim() ?? null);
      setSyncDebug(current => ({ ...current, phase: synced ? "communication.verify.failed" : "sync.failed", started_at: startedAt, error: text }));
      await refreshDebug();
    } finally { setSyncMode(null); setSyncPhase("sync"); syncLock.current = false; }
  };

  const closeDrawer = () => { detailRequest.current += 1; setDrawerOpen(false); setDetailBusy(false); };
  const selectCandidate = async (candidate: LocalCandidate) => {
    const request = ++detailRequest.current;
    setDrawerOpen(true); setDetailLoading(true); setSelectedCandidate(null); setMatch(null); setAction(null); setDetailBusy(false);
    try { const detail = await fetchCandidateDetail(candidate.id); if (request === detailRequest.current) setSelectedCandidate(detail); }
    catch (reason) { if (request === detailRequest.current) { messageApi.error(errorText(reason)); setDrawerOpen(false); } }
    finally { if (request === detailRequest.current) setDetailLoading(false); }
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
    { title: '沟通状态', key: 'communication', width: 175, render: (_: unknown, row: LocalCandidate) => <Tooltip title={row.communication_error || (row.communication_checked_at ? `核验于 ${formatTime(row.communication_checked_at)}` : '同步数据后自动核验日期范围内候选人，也可点击“重新同步核验”')}><Tag color={row.communication_status === 'mutual' ? 'green' : row.communication_status === 'incoming' ? 'blue' : undefined}>{communicationLabels[row.communication_status ?? 'unknown']}</Tag></Tooltip> },
    { title: "招聘阶段", key: "stage", width: 132, render: (_: unknown, row: LocalCandidate) => <Tag>{stageLabels[row.stage] ?? row.stage}</Tag> },
    { title: "最近消息", dataIndex: "latest_message", key: "message", ellipsis: true, render: (value: string) => <span className="message-preview">{value || "暂无消息"}</span> },
    { title: "最近沟通", dataIndex: "latest_time", key: "time", width: 100, render: (value: string) => value || "—" },
    { title: "未读", dataIndex: "unread_count", key: "unread", width: 64, render: (value: number) => value ? <Badge count={value} color="#16846c" /> : <span className="muted">—</span> },
    { title: "标签", key: "tags", width: 110, render: (_: unknown, row: LocalCandidate) => row.tags.length ? <Space size={[0, 4]} wrap>{row.tags.map((tag) => <Tag key={tag}>{tag}</Tag>)}</Space> : <span className="muted">—</span> },
  ];
  const candidateValues: Record<string, (r: LocalCandidate) => CellValue> = {
    name: r => r.name, communication: r => communicationLabels[r.communication_status ?? 'unknown'],
    stage: r => stageLabels[r.stage] ?? r.stage, message: r => r.latest_message, time: r => r.latest_time,
    unread: r => r.unread_count, tags: r => r.tags,
  };
  const managedFields: ManagedField<LocalCandidate>[] = columns.map(c => ({
    id: c.key, name: c.title, width: c.width, fixed: c.key === 'name' ? 'left' : undefined,
    type: c.key === 'unread' ? 'number' : c.key === 'tags' ? 'multi' : c.key === 'stage' || c.key === 'communication' ? 'select' : 'text',
    options: c.key === 'stage' ? Object.values(stageLabels) : c.key === 'communication' ? Object.values(communicationLabels).filter(v => v !== '全部') : c.key === 'tags' ? [...new Set(candidates.flatMap(r => r.tags))] : undefined,
    editable: ['stage', 'tags'].includes(c.key), get: candidateValues[c.key], render: row => c.render?.(candidateValues[c.key](row) as never, row),
  }));
  managedFields.push({ id: 'synced', name: '首次同步日期', type: 'date', width: 140, get: row => beijingDate(row.created_at) }, { id: 'owner', name: '负责人', type: 'text', defaultHidden: true, width: 130, editable: true, get: row => row.owner }, { id: 'notes', name: '本地备注', type: 'multiline', defaultHidden: true, width: 200, editable: true, get: () => null });
  const saveLocalCells = async (ids: string[], field: string, value: CellValue) => {
    let saved = 0;
    try {
      for (const id of ids) {
        const stage = Object.entries(stageLabels).find(([, label]) => label === value)?.[0];
        if (field === 'stage' && !stage) throw new Error('请选择招聘阶段');
        const updated = field === 'tags' ? await updateCandidateTags(id, Array.isArray(value) ? value : []) : await updateCandidate(id, field === 'stage' ? { stage, reason: '表格人工更新' } : { owner: String(value ?? '') });
        saved += 1;
        setCandidates(items => items.map(item => item.id === id ? updated : item));
        setSelectedCandidate(current => current?.id === id ? updated : current);
      }
    } catch (e) { throw new Error(`已保存 ${saved}/${ids.length} 人：${errorText(e)}`); }
  };
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
        <nav className="workspace-navigation" aria-label="工作区"><button aria-pressed={activePage === 'communications'} onClick={() => setActivePage('communications')}>沟通候选人</button><button aria-pressed={activePage === 'recommendations'} onClick={() => setActivePage('recommendations')}>推荐牛人</button></nav>
        <div className="page-alerts">
          {error && <Alert closable onClose={() => setError(null)} message={error} type="warning" showIcon />}
          {busy && syncPhase === "sync" && <Alert type="info" showIcon icon={<SyncOutlined spin />} message={activeStage ? `${timingLabels[activeStage.stage] ?? activeStage.stage} · ${activeStage.elapsed_seconds.toFixed(1)} 秒` : "正在同步岗位与候选人…"} />}
          {(syncPhase === 'verify' && busy) && <Alert type="info" showIcon icon={<SyncOutlined spin />} message={verificationProgress ? `正在核验日期范围内候选人 · ${verificationProgress.completed} / ${verificationProgress.total} 人` : '正在读取所有岗位的沟通候选人…'} description={<><Progress size="small" percent={verificationProgress?.total ? Math.round(verificationProgress.completed / verificationProgress.total * 100) : 0} showInfo={false} /><span>不受岗位、筛选和分页限制 · 已核验 {verificationProgress?.verified ?? 0} 人 · 失败 {verificationProgress?.failed ?? 0} 人</span></>} />}
          {!busy && verificationResult && <Alert showIcon type={verificationResult.failed || verificationResult.unknown ? 'warning' : 'success'} message={`范围核验（${verificationRange}）：共 ${verificationResult.total} 人，已核验 ${verificationResult.verified} 人 · 已分类 ${verificationResult.classified} 人 · 待确认 ${verificationResult.unknown} 人 · 失败 ${verificationResult.failed} 人`} description={verificationResult.failures.length ? <details><summary>查看失败明细（可点击“重新同步核验”重试）</summary>{verificationResult.failures.map((failure, index) => <p key={index}>{failure.names.join('、')}：{failure.error}</p>)}</details> : undefined} />}
        </div>
        {activePage !== 'recommendations' && recommendationActivity && <div className="workspace-task-progress" role="status" aria-live="polite"><div className="workspace-task-heading"><strong>{recommendationActivity.running ? recommendationActivity.progress ? '推荐牛人 · 正在读取在线简历' : '推荐牛人 · 正在查重并寻找新人' : recommendationActivity.error ? '推荐牛人 · 读取结束，有失败项' : '推荐牛人 · 读取完成'}</strong><Button size="small" type="link" onClick={() => setActivePage('recommendations')}>查看任务</Button></div><div className="muted">{recommendationActivity.job}</div>{recommendationActivity.progress && <><Progress size="small" percent={recommendationActivity.progress.total ? Math.round(recommendationActivity.progress.completed / recommendationActivity.progress.total * 100) : 100} status={recommendationActivity.running ? 'active' : recommendationActivity.progress.failed ? 'normal' : 'success'} showInfo={false} /><span>已处理 {recommendationActivity.progress.completed}/{recommendationActivity.progress.total} 人 · 截图成功 {recommendationActivity.progress.completed - recommendationActivity.progress.failed} 人 · 失败 {recommendationActivity.progress.failed} 人{recommendationActivity.progress.currentName ? ` · 当前：${recommendationActivity.progress.currentName}` : ''}</span></>}{!recommendationActivity.progress && <span>{recommendationActivity.running ? '任务继续进行中，完成的截图会保存到本地。' : recommendationActivity.error ? '读取未完成，请返回推荐牛人查看错误明细。' : '本次没有新增人选。'}</span>}</div>}
        <div hidden={activePage !== 'communications'}>
        <section className="page-heading"><div><div className="eyebrow">RECRUITMENT WORKSPACE</div><h1>找到合适的人，推进每一步</h1><p>按岗位查看候选人，管理沟通与招聘进度。</p></div>
          <div className="heading-actions"><div className="sync-range-control"><label htmlFor="communication-since">同步起始日期</label><Input id="communication-since" aria-label="同步起始日期" type="date" max={today} value={syncSince} disabled={busy || manualBusy} onChange={e => { setSyncSince(e.target.value); localStorage.setItem('ai-hr.communication-since', e.target.value); }} /><span>至今 · 含当天</span><Button size="small" type="text" disabled={busy || manualBusy || !syncSince} onClick={() => { setSyncSince(''); localStorage.removeItem('ai-hr.communication-since'); }}>全部历史</Button></div><span className="sync-meta"><ClockCircleOutlined /> {syncLabel}</span><Space><Tooltip title="刷新本地数据"><Button aria-label="刷新本地数据" icon={<ReloadOutlined />} loading={loading} disabled={busy || manualBusy} onClick={() => void loadOverview()} /></Tooltip><Button type="primary" icon={<SyncOutlined />} loading={busy} disabled={loading || manualBusy} onClick={() => void runSync()}>{busy ? syncPhase === "verify" ? "正在核验范围内候选人" : "正在同步数据" : "同步 BOSS 数据"}</Button></Space></div>
        </section>
        {syncNotice && <Alert className="sync-range-notice" showIcon type="info" message={syncNotice} />}
        <div className="workspace-grid">
          <aside className="jobs-panel panel" aria-label="岗位列表">
            <div className="panel-heading"><h2>招聘岗位 <span className="count-pill">{jobs.length}</span></h2><span className="muted">选择岗位查看候选人</span></div>
            <div className="job-filters"><div className="status-tabs" role="group" aria-label="岗位状态筛选">{jobStatuses.map((status) => <button key={status} type="button" disabled={busy || manualBusy} aria-pressed={jobStatus === status} className={jobStatus === status ? "status-tab active" : "status-tab"} onClick={() => { setJobStatus(status); setCandidateQuery(""); }}><span>{status}</span><span className="tab-count">{counts[status]}</span></button>)}</div>
              <Input disabled={busy || manualBusy} aria-label="搜索岗位" placeholder="搜索岗位名称" prefix={<SearchOutlined />} allowClear value={jobQuery} onChange={(event) => { setJobQuery(event.target.value); setCandidateQuery(""); }} />
            </div>
            <div className="jobs-scroll" aria-busy={loading}>
              {loading ? <div className="panel-loading"><Spin /><span>正在读取岗位</span></div> : visibleJobs.length === 0 ? <div className="jobs-empty"><Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={jobs.length === 0 ? "还没有同步岗位" : jobQuery ? "没有找到匹配的岗位" : `暂无${jobStatus}岗位`} />{jobs.length === 0 ? <Button type="primary" loading={busy} onClick={() => void runSync()}>立即同步</Button> : <Button type="link" onClick={() => { setJobStatus("全部"); setJobQuery(""); }}>查看全部岗位</Button>}</div> : visibleJobs.map((job) => <button key={job.id} type="button" disabled={busy || manualBusy} className={`job-item ${selectedJob?.id === job.id ? "job-item-selected" : ""}`} aria-pressed={selectedJob?.id === job.id} onClick={() => { setSelectedJobId(job.id); setCandidateQuery(""); }}><div className="job-item-title"><span>{job.title}</span>{selectedJob?.id === job.id && <ArrowRightOutlined />}</div><div className="job-item-meta"><Tag color={statusColor(job.status.trim())} bordered={false}>{job.status}</Tag>{job.label && <span>{job.label}</span>}</div><div className="job-item-description">{job.meta.slice(0, 3).join(" · ") || "点击查看该岗位候选人"}</div></button>)}
            </div>
            <div className="panel-footnote">显示 {visibleJobs.length} / {jobs.length} 个岗位 · 本地同步数据</div>
          </aside>
          <section className="candidates-panel panel" aria-label="候选人列表">
            <div className="candidate-heading"><div><div className="section-kicker">{selectedJob ? "当前岗位" : "候选人工作区"}</div><h2>{selectedJob?.title ?? "选择岗位，开始筛选"}</h2>{selectedJob && <div className="candidate-summary"><Tag bordered={false} color={statusColor(selectedJob.status.trim())}>{selectedJob.status}</Tag><span>{candidateLoading ? "正在加载候选人…" : `已载入 ${candidateTotal} 位候选人`}</span></div>}</div><div className="candidate-heading-icon"><TeamOutlined /></div></div>

            {selectedJob && <div className="communication-controls">
              <div className="communication-tabs" role="group" aria-label="沟通状态筛选">{(Object.keys(communicationLabels) as CommunicationFilter[]).map(key => <button key={key} disabled={busy || manualBusy} aria-pressed={communicationFilter === key} onClick={() => { setCommunicationFilter(key); }}>{communicationLabels[key]} <span>{communicationCounts[key]}</span></button>)}</div>
              <div className="communication-help"><span>双方已沟通后可申请附件简历，仍需对方提供。待核验人员不计入三类。</span><Tooltip title="按上方日期重新同步所有岗位的会话并核验，不受当前表格筛选限制"><Button size="small" loading={busy} disabled={busy || manualBusy} onClick={() => void runSync()}>重新同步核验</Button></Tooltip></div>
              <div className="communication-read-note"><span>同步会自动加载历史，并核验所选日期至今的全部岗位会话；本地历史仍全部展示。打开会话可能将消息标为已读。</span><CommunicationRecycleBin disabled={busy || manualBusy} /></div>
            </div>}
            {candidateError && <Alert type="warning" showIcon message={candidateError} action={<Button size="small" onClick={() => setRefreshToken((value) => value + 1)}>重试</Button>} />}
            {!selectedJob ? <div className="candidate-empty"><TeamOutlined /><h3>{jobs.length ? "没有符合筛选条件的岗位" : "从同步第一个岗位开始"}</h3><p>{jobs.length ? "调整左侧筛选条件，即可查看对应候选人。" : "点击上方同步按钮，读取你的岗位与候选人。"}</p></div> : <ManagedTable<LocalCandidate> scope="communications" showAll rows={filteredCandidates} fields={managedFields} loading={candidateLoading || candidateLoadedToken !== refreshToken} busy={busy || manualBusy} contextKey={`${selectedJob.id}:${communicationFilter}`} onLocalSave={saveLocalCells} onDeleted={ids => { setCandidates(items => items.filter(i => !ids.includes(i.id))); setCandidateTotal(count => count - ids.length); if (selectedCandidate && ids.includes(selectedCandidate.id)) closeDrawer(); }} emptyText="该岗位暂无此类沟通候选人" />}
            <div className="candidate-footnote"><CheckOutlined /> 本地标注会保留，不会被后续同步覆盖</div>
          </section>
        </div>
        </div>
        <div hidden={activePage !== 'recommendations'}><Recommendations busy={busy || manualBusy} setBusy={setManualBusy} onActivity={setRecommendationActivity} /></div>
        <DiagnosticsPanel status={debugStatus} health={health} loading={debugLoading} busy={busy || manualBusy} diagnosing={syncMode === "diagnostic"} logPath={diagnosticLogPath} sync={syncDebug} onRefresh={() => void refreshDebug()} onDiagnose={() => void runSync(true)} />
        <footer className="app-footer"><span>AI Recruiter · 让招聘更有序</span><span><SafetyOutlined /> 外部操作需人工确认 · 匹配建议仅供参考</span></footer>
      </main>
      <Drawer title="候选人详情" open={drawerOpen} onClose={closeDrawer} width={560} className="candidate-drawer" destroyOnClose>
        {detailLoading ? <div className="panel-loading"><Spin /><span>正在读取详情</span></div> : selectedCandidate && <>
          <div className="profile-heading"><Avatar size={52}>{selectedCandidate.name.slice(0, 1)}</Avatar><div><h2>{selectedCandidate.name}</h2><Tag color="green">{stageLabels[selectedCandidate.stage] ?? selectedCandidate.stage}</Tag></div></div>
          <Descriptions column={1} size="small" className="profile-info"><Descriptions.Item label="关联岗位">{selectedCandidate.job_titles.join("、") || "未绑定"}</Descriptions.Item><Descriptions.Item label="负责人">{selectedCandidate.owner || "未分配"}</Descriptions.Item><Descriptions.Item label="标签">{selectedCandidate.tags.join("、") || "暂无"}</Descriptions.Item><Descriptions.Item label="最近消息">{selectedCandidate.latest_message || "暂无"}</Descriptions.Item></Descriptions>
          <div className="communication-detail"><h3>{communicationLabels[selectedCandidate.communication_status ?? 'unknown']}</h3><p>{selectedCandidate.communication_error || (selectedCandidate.communication_checked_at ? `核验时间：${formatTime(selectedCandidate.communication_checked_at)}` : '同步数据后会自动核验日期范围内候选人，也可点击列表上方“重新同步核验”。')}</p>{selectedCandidate.communication_evidence && <><p>我方消息：{selectedCandidate.communication_evidence.recruiter_sent ? '已检测到' : '当前记录未检测到'} · 对方消息：{selectedCandidate.communication_evidence.candidate_sent ? '已检测到' : '当前记录未检测到'}</p><p>申请附件入口：{selectedCandidate.communication_evidence.request_resume_enabled === true ? '可用' : selectedCandidate.communication_evidence.request_resume_enabled === false ? '不可用' : '未识别'} · 附件卡片：{selectedCandidate.communication_evidence.attachment_present ? '已检测到（未下载）' : '当前记录未检测到'}</p></>}</div>
          <Space wrap><Button type="primary" loading={detailBusy} onClick={() => void detailOperation("match")}>生成匹配建议</Button><Button disabled={detailBusy} onClick={() => void detailOperation("draft")}>生成消息草稿</Button></Space>
          {match && <Alert className="detail-alert" message={`匹配分 ${match.score} · ${match.recommendation}`} description={<Space direction="vertical"><span>优势：{match.strengths.join("；") || "暂无充分证据"}</span><span>待补充：{match.risks.join("；") || "暂无"}</span><span>待确认：{match.questions.join("；") || "暂无"}</span></Space>} type="info" showIcon />}
          {action && <Alert className="detail-alert" message={`消息草稿 · ${({ pending_confirmation: "待确认", success: "已完成", blocked: "未执行", failed: "失败", cancelled: "已取消" })[action.status] ?? action.status}`} description={<Space direction="vertical"><span>{String(action.payload.text ?? "")}</span>{Boolean(action.result.reason) && <span>{String(action.result.reason)}</span>}<Button size="small" type="primary" loading={detailBusy} disabled={action.status !== "pending_confirmation"} onClick={() => void detailOperation("confirm")}>人工确认</Button></Space>} type={action.status === "blocked" ? "warning" : "info"} />}
        </>}
      </Drawer>
    </div>
  </ConfigProvider>;
}

export default App;
