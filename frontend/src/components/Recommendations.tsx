import { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Button, Checkbox, Empty, Image, Input, InputNumber, Modal, Progress, Select, Space, Table, Tag, Tooltip } from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, FileImageOutlined, FilterOutlined, ReloadOutlined, SearchOutlined, TeamOutlined, UndoOutlined, MessageOutlined, RobotOutlined } from '@ant-design/icons';
import { useRecommendationGreetings } from './RecommendationGreetings';
import { fetchRecommendationJobs, readRecommendationJobs, type RecommendationJob, allowRecommendationAgain, captureRecommendedResume, fetchRecommendationRecycleBin, fetchRecommendations, readRecommendations, resumeScreenshotUrl, type OnlineResumeScreenshot, type RecommendedPerson, type RecommendationSnapshot, type RecycledRecommendation } from '../api';
import { ManagedTable, type ManagedField } from './ManagedTable';
import { ResumeThumbnail } from './ResumeThumbnail';
import { restoreRecycleRecords } from '../recycleBatch';
import { beijingDate } from '../tableModel';
import { captureRecommendationBatch, type ResumeBatchProgress, type RecommendationActivity } from '../recommendationBatch';
import { aiRequest, type AIConfig, type AIJobPrompt, type AIRecommendationResult, type AIRun, type AISelection } from '../aiApi';
import { loadRecommendationReadConditions, RecommendationReadConditionsDrawer } from './RecommendationReadConditions';

const savedTime = (value: string) => new Date(/Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function Recommendations({ active, busy, setBusy, onActivity }: { active: boolean; busy: boolean; setBusy: (busy: boolean) => void; onActivity: (activity: RecommendationActivity | null) => void }) {
  const [snapshot, setSnapshot] = useState<RecommendationSnapshot | null>(null);
  const [jobs, setJobs] = useState<RecommendationJob[]>([]);
  const [jobKey, setJobKey] = useState('');
  const [jobsLoading, setJobsLoading] = useState(false);
  const selectedJob = jobs.find(job => job.id === jobKey);
  const [loading, setLoading] = useState(true);
  const [trash, setTrash] = useState<RecycledRecommendation[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashQuery, setTrashQuery] = useState('');
  const [trashSelection, setTrashSelection] = useState<string[]>([]);
  const [restoreProgress, setRestoreProgress] = useState<{ completed: number; total: number } | null>(null);
  const filteredTrash = trash.filter(person => `${person.name} ${person.baseInfo}`.toLowerCase().includes(trashQuery.trim().toLowerCase()));
  const [restoring, setRestoring] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [readConditionsOpen, setReadConditionsOpen] = useState(false);
  const [, refreshReadConditions] = useState(0);
  const readConditionCount = loadRecommendationReadConditions(jobKey).groups.reduce((sum, group) => sum + group.filters.length, 0);
  const [readLimit, setReadLimit] = useState<number | null>(() => {
    const saved = typeof window === 'undefined' ? 20 : Number(window.localStorage.getItem('ai-hr-recommendation-read-limit'));
    return Number.isInteger(saved) && saved >= 1 && saved <= 50 ? saved : 20;
  });
  const [readAttempted, setReadAttempted] = useState(false);
  const [batchProgress, setBatchProgress] = useState<ResumeBatchProgress | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; screenshot: OnlineResumeScreenshot } | null>(null);
  const [evaluations, setEvaluations] = useState<Record<string, AIRecommendationResult>>({});
  const [evaluationModal, setEvaluationModal] = useState(false);
  const [evaluationPeople, setEvaluationPeople] = useState<RecommendedPerson[]>([]);
  const [evaluationConfig, setEvaluationConfig] = useState<AIConfig | null>(null);
  const [evaluationPrompt, setEvaluationPrompt] = useState('');
  const [evaluationPromptCustom, setEvaluationPromptCustom] = useState(false);
  const [evaluationPromptDirty, setEvaluationPromptDirty] = useState(false);
  const [evaluationContext, setEvaluationContext] = useState('');
  const [evaluationImages, setEvaluationImages] = useState(true);
  const [evaluationWorking, setEvaluationWorking] = useState(false);
  const [evaluationRun, setEvaluationRun] = useState<AIRun | null>(null);
  const [evaluationDetail, setEvaluationDetail] = useState<AIRecommendationResult | null>(null);
  const [evaluationError, setEvaluationError] = useState('');
  const locked = useRef(false);
  const greeting = useRecommendationGreetings(jobKey, selectedJob?.label ?? '', setBusy);
  useEffect(() => {
    if (!readAttempted || reading) return;
    const timer = window.setTimeout(() => setReadAttempted(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [readAttempted, reading]);
  useEffect(() => {
    if (!batchProgress || reading) return;
    const timer = window.setTimeout(() => setBatchProgress(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [batchProgress, reading]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(null), 10_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  useEffect(() => { if (readLimit !== null && Number.isInteger(readLimit) && readLimit >= 1 && readLimit <= 50) window.localStorage.setItem('ai-hr-recommendation-read-limit', String(readLimit)); }, [readLimit]);
  useEffect(() => {
    setSnapshot(current => {
      if (!current?.candidates.some(p => !p.greeted && greeting.greetedIds.has(p.id))) return current;
      // Keep confirmed successes in the local view even after later batches finish.
      return { ...current, candidates: current.candidates.map(p => greeting.greetedIds.has(p.id) ? { ...p, greeted: true } : p) };
    });
  }, [greeting.greetedIds, snapshot]);
  useEffect(() => {
    onActivity(greeting.activity?.running ? greeting.activity : readAttempted ? { running: reading, job: selectedJob?.label ?? '', progress: batchProgress, error } : greeting.activity);
  }, [greeting.activity, readAttempted, reading, selectedJob?.label, batchProgress, error, onActivity]);
  useEffect(() => {
    const controller = new AbortController();
    fetchRecommendationJobs(controller.signal).then(result => { setJobs(result.jobs); setJobKey(result.jobs.find(j => j.count > 0)?.id ?? result.jobs[0]?.id ?? ''); }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    setReadAttempted(false); setSnapshot(null); setTrash([]); setPreview(null); setBatchProgress(null); setError(null); setTrashOpen(false); setTrashSelection([]); setRestoreProgress(null);
    if (!jobKey) return () => controller.abort();
    setLoading(true);
    Promise.all([fetchRecommendations(controller.signal, jobKey), fetchRecommendationRecycleBin(controller.signal, jobKey)]).then(([library, bin]) => {
      if (!controller.signal.aborted) { setSnapshot(library); setTrash(bin.candidates); }
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [jobKey]);
  // Communication deletion can remove a linked recommendation while this page
  // is hidden. Refresh local snapshots when returning to this tab.
  useEffect(() => {
    if (!active || busy || !jobKey) return;
    const controller = new AbortController();
    Promise.all([fetchRecommendations(controller.signal, jobKey), fetchRecommendationRecycleBin(controller.signal, jobKey), fetchRecommendationJobs(controller.signal)]).then(([library, bin, availableJobs]) => {
      if (!controller.signal.aborted) { setSnapshot(library); setTrash(bin.candidates); setJobs(availableJobs.jobs); }
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason.message ?? reason)); });
    return () => controller.abort();
  }, [active, busy, jobKey]);
  useEffect(() => {
    if (!jobKey) { setEvaluations({}); setEvaluationRun(null); return; }
    if (!active) return;
    const controller = new AbortController();
    void Promise.all([
      aiRequest<AIRecommendationResult[]>(`/recommendation-results?job_id=${encodeURIComponent(jobKey)}`, 'GET', undefined, controller.signal),
      aiRequest<AIRun[]>('/runs', 'GET', undefined, controller.signal),
    ]).then(([results, runs]) => {
      if (controller.signal.aborted) return;
      setEvaluations(Object.fromEntries(results.map(result => [result.candidate_id, result])));
      const current = runs.find(run => ['queued', 'running'].includes(run.status) && run.selection.source === 'recommendations');
      setEvaluationRun(current ?? null);
    }).catch(reason => { if (!controller.signal.aborted) setEvaluationError(reason instanceof Error ? reason.message : '读取 AI 评估失败'); });
    return () => controller.abort();
  }, [jobKey, active]);
  useEffect(() => {
    if (!evaluationRun || !['queued', 'running'].includes(evaluationRun.status)) return;
    let stopped = false;
    const timer = setInterval(() => {
      void aiRequest<AIRun>(`/runs/${evaluationRun.id}`).then(async run => {
        if (stopped) return;
        if (run.completed !== evaluationRun.completed || !['queued', 'running'].includes(run.status)) {
          const results = await aiRequest<AIRecommendationResult[]>(`/recommendation-results?job_id=${encodeURIComponent(jobKey)}`);
          if (stopped) return;
          setEvaluations(Object.fromEntries(results.map(result => [result.candidate_id, result])));
        }
        setEvaluationRun(run);
      }).catch(reason => { if (!stopped) setEvaluationError(reason instanceof Error ? reason.message : '读取 AI 进度失败'); });
    }, 2000);
    return () => { stopped = true; clearInterval(timer); };
  }, [evaluationRun?.id, evaluationRun?.status, evaluationRun?.completed, jobKey]);
  const openEvaluation = async (people: RecommendedPerson[]) => {
    setEvaluationPeople(people); setEvaluationModal(true); setEvaluationError(''); setEvaluationConfig(null); setEvaluationPromptDirty(false); setEvaluationImages(true); setEvaluationContext('');
    try {
      const [config, savedPrompt] = await Promise.all([aiRequest<AIConfig>('/config'), aiRequest<AIJobPrompt>(`/prompts/${encodeURIComponent(jobKey)}`)]);
      setEvaluationConfig(config); setEvaluationPrompt(savedPrompt.prompt); setEvaluationContext(savedPrompt.jd); setEvaluationPromptCustom(savedPrompt.custom);
    } catch (reason) { setEvaluationError(reason instanceof Error ? reason.message : '读取 AI 配置失败'); }
  };
  const saveEvaluationFields = async () => {
    const saved = await aiRequest<AIJobPrompt>(`/prompts/${encodeURIComponent(jobKey)}`, 'PUT', { ...(evaluationPrompt.trim() ? { prompt: evaluationPrompt } : {}), jd: evaluationContext });
    setEvaluationPrompt(saved.prompt); setEvaluationContext(saved.jd); setEvaluationPromptCustom(saved.custom); setEvaluationPromptDirty(false);
    window.dispatchEvent(new Event('ai-prompt-saved'));
  };
  const startEvaluation = async (saveOnly = false) => {
    if (!evaluationConfig || !evaluationPeople.length || evaluationWorking) return;
    setEvaluationWorking(true); setEvaluationError('');
    try {
      if (evaluationPromptDirty) await saveEvaluationFields();
      if (saveOnly) return;
      const selection: AISelection = { source: 'recommendations', job_id: jobKey, candidate_ids: evaluationPeople.map(person => person.id), include_images: evaluationImages, job_context: '' };
      const run = await aiRequest<AIRun>('/runs', 'POST', selection);
      setEvaluationRun(run); setEvaluationModal(false);
    } catch (reason) { setEvaluationError(reason instanceof Error ? reason.message : '启动 AI 评估失败'); }
    finally { setEvaluationWorking(false); }
  };
  const openEvaluationDetail = async (person: RecommendedPerson) => {
    setEvaluationError('');
    try { setEvaluationDetail(await aiRequest<AIRecommendationResult>(`/recommendation-results/${encodeURIComponent(person.id)}?job_id=${encodeURIComponent(jobKey)}`)); }
    catch (reason) { setEvaluationError(reason instanceof Error ? reason.message : '读取 AI 回答失败'); }
  };
  const refreshJobs = async () => {
    if (locked.current || busy) return;
    locked.current = true; setJobsLoading(true); setBusy(true); setError(null);
    try {
      const result = await readRecommendationJobs();
      setJobs(result.jobs);
      if (!jobKey || !result.jobs.some(j => j.id === jobKey)) setJobKey(result.current_job_key && result.jobs.some(j => j.id === result.current_job_key) ? result.current_job_key : result.jobs[0]?.id ?? '');
    } catch (reason) { setError(reason instanceof Error ? reason.message : '刷新推荐岗位失败'); }
    finally { locked.current = false; setJobsLoading(false); setBusy(false); }
  };

  const openTrash = async () => {
    setTrashOpen(true); setTrashQuery(''); setTrashSelection([]); setRestoreProgress(null); setTrashLoading(true); setTrashError(null); setTrashNotice(null);
    try { setTrash((await fetchRecommendationRecycleBin(undefined, jobKey)).candidates); }
    catch (reason) { setTrashError(reason instanceof Error ? reason.message : '读取回收站失败'); }
    finally { setTrashLoading(false); }
  };
  const allowAgain = async (people: RecycledRecommendation[]) => {
    if (locked.current || busy || trashLoading || !people.length) return;
    locked.current = true; setRestoring(people.length === 1 ? people[0].id : 'batch'); setBusy(true); setTrashError(null); setTrashNotice(null);
    try {
      const result = await restoreRecycleRecords(people, allowRecommendationAgain, id => {
        setTrash(current => current.filter(item => item.id !== id));
        setTrashSelection(current => current.filter(key => key !== id));
      }, (completed, total) => setRestoreProgress({ completed, total }));
      if (result.restored) setTrashNotice(`已允许 ${result.restored} 人重新读取。下次点击“新增 ${readLimit} 人”并在 BOSS 列表遇到他们时，会重新入库和截图。`);
      if (result.failures.length) setTrashError(`有 ${result.failures.length} 人未处理成功，仍保留在回收站并保持选中，可重试：${result.failures.join('；')}`);
    } finally { locked.current = false; setRestoring(null); setBusy(false); }
  };
  const read = async () => {
    if (readLimit === null || !Number.isInteger(readLimit) || readLimit < 1 || readLimit > 50) { setError('本次新增人数须为 1 到 50 的整数'); return; }
    if (locked.current || busy || !selectedJob?.available || loading) return;
    locked.current = true; setReadAttempted(true); setReading(true); setBusy(true); setError(null); setBatchProgress(null);
    try {
      const next = await readRecommendations(jobKey, readLimit, loadRecommendationReadConditions(jobKey));
      setSnapshot(next);
      const failures = await captureRecommendationBatch(next.candidates.filter(person => next.added_ids.includes(person.id)), async person => {
        setCapturing(person.id);
        return captureRecommendedResume(person.geekId, person.id);
      }, (person, screenshot) => {
        setSnapshot(current => current && ({ ...current, candidates: current.candidates.map(item => item.id === person.id ? { ...item, online_resume: screenshot, first_retrieved_at: item.first_retrieved_at ?? screenshot.captured_at } : item) }));
      }, setBatchProgress);
      if (failures.length) setError(failures.join('；'));
      setJobs((await fetchRecommendationJobs()).jobs);
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败，请重试'); }
    finally { locked.current = false; setCapturing(null); setReading(false); setBusy(false); }
  };
  const capture = async (person: RecommendedPerson) => {
    if (locked.current || busy || !person.geekId) return;
    locked.current = true; setCapturing(person.id); setBusy(true); setError(null); setBatchProgress(null);
    try {
      const screenshot = await captureRecommendedResume(person.geekId, person.id);
      setSnapshot(current => current && ({ ...current, candidates: current.candidates.map(item => item.id === person.id ? { ...item, online_resume: screenshot, first_retrieved_at: item.first_retrieved_at ?? screenshot.captured_at } : item) }));
    } catch (reason) { setError(`${person.name}：${reason instanceof Error ? reason.message : '截图失败，请重试'}`); }
    finally { locked.current = false; setCapturing(null); setBusy(false); }
  };
  const columns = [
    { title: '姓名', key: 'name', width: 150, fixed: 'left' as const, render: (_: unknown, person: RecommendedPerson) => <div className="recommendation-name"><Avatar size={30}>{person.name.slice(0, 1)}</Avatar><div><strong>{person.name}</strong>{person.advantage && <Tooltip title={person.advantage}><span className="recommendation-intro">个人介绍</span></Tooltip>}</div></div> },
    { title: '基本信息', dataIndex: 'baseInfo', key: 'base', width: 175, render: (value: string) => <div className="recommendation-cell">{value || '—'}</div> },
    { title: '期望职位', dataIndex: 'expect', key: 'expect', width: 180, render: (value: string) => <div className="recommendation-cell">{value || '—'}</div> },
    { title: '期望薪资', dataIndex: 'salary', key: 'salary', width: 100, render: (value: string) => <span className="recommendation-salary">{value || '—'}</span> },
    { title: '契合程度', key: 'fit', width: 125, render: (_: unknown, person: RecommendedPerson) => <div className="recommendation-fit"><span className="recommendation-stars" aria-label={evaluations[person.id]?.stars ? `${evaluations[person.id].stars} 星` : '尚无星级'}>{evaluations[person.id]?.stars ? '★'.repeat(evaluations[person.id].stars) : '—'}</span>{evaluations[person.id] && <Button type="link" size="small" className="recommendation-fit-detail" onClick={() => void openEvaluationDetail(person)}>查看详情</Button>}</div> },
    { title: '已打招呼', key: 'greeted', width: 100, render: (_: unknown, person: RecommendedPerson) => <span className={`greeting-status ${person.greeted ? 'is-yes' : 'is-no'}`} title="仅记录通过本平台确认发送成功的招呼">{person.greeted ? '是' : '否'}</span> },
    { title: '标签', key: 'tags', width: 180, render: (_: unknown, person: RecommendedPerson) => <Space size={[0, 4]} wrap>{person.highlights.map((label, i) => <Tag key={`${label}-${i}`}>{label}</Tag>)}{person.hasHistoryChat && <Tag>同事沟通过</Tag>}{person.hasViewed && <Tag>已看过</Tag>}{!person.highlights.length && !person.hasHistoryChat && !person.hasViewed && '—'}</Space> },
    { title: '在线简历', key: 'resume', width: 185, fixed: 'right' as const, render: (_: unknown, person: RecommendedPerson) => person.online_resume ? <div className="resume-table-cell">
      <ResumeThumbnail key={person.online_resume.id} src={resumeScreenshotUrl(person.online_resume)} name={person.name} onPreview={() => setPreview({ name: person.name, screenshot: person.online_resume! })} />
      <div><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setPreview({ name: person.name, screenshot: person.online_resume! })}>查看截图</Button><time>{savedTime(person.online_resume.captured_at)}</time><Button type="text" size="small" icon={<ReloadOutlined />} loading={capturing === person.id} disabled={busy} onClick={() => void capture(person)}>重新读取</Button></div>
    </div> : <div className="resume-table-empty"><Button size="small" icon={<FileImageOutlined />} loading={capturing === person.id} disabled={busy || !person.geekId} onClick={() => void capture(person)}>读取在线简历</Button><span>{!person.geekId ? '缺少ID，请重新读取列表' : capturing === person.id ? '正在打开简历并截图…' : '点击后保存此人的截图'}</span></div> },
  ];

  const values: Record<string, (p: RecommendedPerson) => string | string[]> = {
    name: p => p.name, base: p => p.baseInfo, expect: p => p.expect, salary: p => p.salary,
    fit: p => evaluations[p.id]?.stars ? '★'.repeat(evaluations[p.id].stars) : '', tags: p => [...p.highlights, ...(p.hasHistoryChat ? ['同事沟通过'] : []), ...(p.hasViewed ? ['已看过'] : [])],
    resume: p => p.online_resume ? '已读取' : '未读取', greeted: p => p.greeted ? '是' : '否',
  };
  const managedFields: ManagedField<RecommendedPerson>[] = columns.map(c => ({
    id: c.key, name: c.title, width: c.width, fixed: c.key === 'name' ? 'left' : c.key === 'resume' ? 'right' : undefined,
    type: c.key === 'tags' ? 'multi' : c.key === 'greeted' ? 'select' : 'text', options: c.key === 'greeted' ? ['是', '否'] : undefined, get: values[c.key],
    render: p => c.render?.(values[c.key]?.(p) as never, p),
  }));
  managedFields.splice(5, 0, { id: 'retrieved', name: '检索日期', type: 'date', width: 130, get: p => beijingDate(p.first_retrieved_at), render: p => <span className={p.first_retrieved_at ? 'retrieval-date' : 'muted'}>{beijingDate(p.first_retrieved_at) || '未读取'}</span> });
  managedFields.push({ id: 'source_job', name: '来源岗位', type: 'text', defaultHidden: true, width: 200, get: p => p.source_job }, { id: 'notes', name: '本地备注', type: 'multiline', defaultHidden: true, width: 200, editable: true, get: () => null });
  const evaluationRunning = !!evaluationRun && ['queued', 'running'].includes(evaluationRun.status);
  const currentEvaluation = evaluationRun?.items?.find(item => item.status === 'running');
  const currentEvaluationNumber = evaluationRun ? Math.min(evaluationRun.completed + 1, evaluationRun.total) : 0;

  return <section className="recommendations-page panel">
    <div className="recommendations-heading"><div><div className="section-kicker">本地人才库</div><h2><TeamOutlined /> 推荐牛人</h2><p>按岗位积累推荐人选，在当前岗位内查重、保存简历与本地标注。</p></div><Space wrap><Tooltip title={greeting.dailyError || '所有岗位合计；只统计本平台当天确认发送成功的招呼，已招呼跳过及失败不计'}><div className="recommendation-daily-count" role="status" aria-live="polite"><MessageOutlined /><span>{(greeting.dailyCount?.date ?? beijingDate(new Date().toISOString())).replace(/-/g, '/')}打招呼次数：</span><strong>{greeting.dailyCount?.count ?? '—'}/{greeting.dailyCount?.limit ?? 200}</strong></div></Tooltip><Button icon={<DeleteOutlined />} disabled={busy || loading || !jobKey} onClick={() => void openTrash()}>回收站{trash.length ? `（${trash.length}）` : ''}</Button><span className="recommendation-read-count"><span>本次新增</span><Tooltip title="请输入 1 到 50 的整数"><InputNumber aria-label="本次新增人数（1到50的整数）" min={1} max={50} step={1} precision={0} controls disabled={busy || reading} status={readLimit === null || !Number.isInteger(readLimit) || readLimit < 1 || readLimit > 50 ? 'error' : undefined} value={readLimit} onChange={setReadLimit} /></Tooltip><span>人</span></span><Button icon={<FilterOutlined />} disabled={busy || loading || !jobKey} onClick={() => setReadConditionsOpen(true)}>读取条件{readConditionCount ? `（${readConditionCount}）` : ''}</Button><Button type="primary" icon={<SearchOutlined />} loading={reading} disabled={busy || loading || !selectedJob?.available || readLimit === null || !Number.isInteger(readLimit) || readLimit < 1 || readLimit > 50} onClick={() => void read()}>{reading ? batchProgress ? `简历截图 ${batchProgress.completed}/${batchProgress.total}` : '正在查重并寻找新人…' : `新增 ${readLimit ?? '—'} 人（含简历）`}</Button></Space></div>
    {evaluationRunning && evaluationRun && <div className="recommendation-ai-progress" role="status" aria-live="polite"><div className="recommendation-ai-progress-heading"><strong><RobotOutlined /> {evaluationRun.status === 'queued' ? 'AI 评估排队中' : 'AI 正在评估'} · 当前 {evaluationRun.status === 'queued' ? `0/${evaluationRun.total}` : `${currentEvaluationNumber}/${evaluationRun.total}`}</strong><span>已完成 {evaluationRun.completed}/{evaluationRun.total}{evaluationRun.failed ? ` · 失败 ${evaluationRun.failed}` : ''}{currentEvaluation?.name ? ` · 正在分析：${currentEvaluation.name}` : ''}</span></div><Progress percent={evaluationRun.total ? Math.round(evaluationRun.completed / evaluationRun.total * 100) : 0} size="small" showInfo={false} status="active" strokeColor="#398e70" /><span className="muted">评估在后台继续进行，完成一人后会自动更新契合星级。</span></div>}
    <div className="recommendation-job-bar"><div className="recommendation-job-picker"><span className="section-kicker">推荐岗位</span><Select aria-label="选择推荐岗位" showSearch optionFilterProp="label" placeholder="先刷新 BOSS 岗位，再选择岗位" value={jobKey || undefined} disabled={busy || jobsLoading || loading} onChange={setJobKey} options={jobs.map(job => ({ value: job.id, label: `${job.label} · ${job.count} 人${job.available ? '' : '（本地历史）'}` }))} /></div><Button icon={<ReloadOutlined />} loading={jobsLoading} disabled={busy && !jobsLoading} onClick={() => void refreshJobs()}>刷新 BOSS 岗位</Button><span className="recommendation-job-hint">{selectedJob?.available ? '新增时自动切换并核对 BOSS 对应岗位' : '刷新只读取岗位选项；选择可用岗位后才能新增人选'}</span></div>
    <div className="recommendations-notice">每次新增人数须为 1–50 的整数 · {readConditionCount ? `已设置 ${readConditionCount} 条读取条件，向下查找直到新增够人数、到达列表末尾或扫描上限` : `未设置读取条件，仅检查列表前 ${readLimit ?? '—'} 人`} · 当前岗位内按姓名＋基本信息查重（含回收站） · 只为本次新人截图</div>
    <RecommendationReadConditionsDrawer open={readConditionsOpen} jobKey={jobKey} jobLabel={selectedJob?.label ?? ''} disabled={busy} onClose={() => setReadConditionsOpen(false)} onSave={() => refreshReadConditions(value => value + 1)} />
    {(reading || batchProgress) && <div className="recommendation-batch" role="status" aria-live="polite"><div className="recommendation-batch-title"><strong>{reading ? batchProgress ? `正在读取${batchProgress.currentName ? `：${batchProgress.currentName}` : '在线简历'}…` : '正在获取推荐列表…' : batchProgress?.total ? '本次读取完成' : '本次没有找到新的人选，原有名单已保留'}</strong><span>{batchProgress ? `已处理 ${batchProgress.completed}/${batchProgress.total} 人 · 截图成功 ${batchProgress.completed - batchProgress.failed} 人${batchProgress.failed ? ` · 失败 ${batchProgress.failed} 人，可单独重试` : ''}` : '先查重，随后只为新增人选打开简历并截图'}</span></div>{batchProgress && batchProgress.total > 0 && <Progress percent={Math.round(batchProgress.completed / batchProgress.total * 100)} size="small" showInfo={false} status={reading ? 'active' : batchProgress.failed ? 'normal' : 'success'} strokeColor="#398e70" />}<span className="muted">{reading ? '请保持此页面打开，完成的截图会逐行显示。' : batchProgress && batchProgress.completed > batchProgress.failed ? '成功的截图已保存在本地，可点击缩略图查看。' : '暂无新截图，失败项可使用行内按钮单独重试。'}</span></div>}
    {batchProgress && !reading && snapshot?.stop_reason === 'scan_limit' && <Alert className="recommendation-error" type="info" showIcon message="已达到本次查找上限，已保存找到的新人；可再次点击继续查找。" />}
    {error && <Alert className="recommendation-error" closable onClose={() => setError(null)} type="warning" showIcon message={error} />}
    {evaluationError && !evaluationModal && <Alert className="recommendation-error" closable onClose={() => setEvaluationError('')} type="warning" showIcon message={evaluationError} />}
    <div className="recommendations-meta"><strong>当前岗位：{selectedJob?.label || '请选择推荐岗位'}</strong><span>{snapshot?.captured_at ? `${snapshot.candidates.length} 人累计 · 最近读取于 ${savedTime(snapshot.captured_at)}` : '尚未读取推荐列表'}</span></div>
    {greeting.panel}
    <ManagedTable<RecommendedPerson> scope="recommendations" showAll contextKey={jobKey} rows={snapshot?.candidates ?? []} fields={managedFields} loading={loading} busy={busy} selectionActions={(people, disabled) => <Space size={6}><Button size="small" icon={<RobotOutlined />} disabled={disabled || people.length > 20 || !!evaluationRun && ['queued', 'running'].includes(evaluationRun.status)} onClick={() => void openEvaluation(people)}>批量 AI 评估（{people.length}）</Button><Button type="primary" size="small" icon={<MessageOutlined />} disabled={disabled || !greeting.ready || !selectedJob?.available || people.length > 200} onClick={() => { setReadAttempted(false); greeting.select(people); }}>一键打招呼（{people.length}）</Button></Space>} emptyText={selectedJob ? selectedJob.available ? `这个岗位还没有本地人选，点击新增 ${readLimit} 人开始读取` : "此历史岗位暂无本地人选，请刷新岗位列表或切换可用岗位" : "点击刷新 BOSS 岗位，选择岗位后读取推荐人选"} onDeleted={async ids => {
      setSnapshot(current => current && ({ ...current, candidates: current.candidates.filter(p => !ids.includes(p.id)) }));
      setPreview(null); setTrash((await fetchRecommendationRecycleBin(undefined, jobKey)).candidates); setJobs((await fetchRecommendationJobs()).jobs);
    }} />
    <div className="recommendation-table-footer"><FileImageOutlined /> 在线简历列保存页面截图；点击缩略图可放大查看。刷新网页只读取本地已保存内容。</div>
    <Modal title={<Space><DeleteOutlined /><span>人选共享回收站 · {selectedJob?.label}</span><Tag>{trash.length} 人</Tag></Space>} open={trashOpen} onCancel={() => { if (!restoring) setTrashOpen(false); }} closable={!restoring} maskClosable={!restoring} width={840} footer={<Button disabled={!!restoring} onClick={() => setTrashOpen(false)}>关闭</Button>}>
      <div className="recycle-bin-notice">推荐页未打招呼的人选删除后进入回收站；已打招呼的人选只从推荐页隐藏，本地资料和后续沟通同步资格保留。沟通候选人页面删除才会正式进入回收站。回收站只保留姓名和基本信息用于查重，点击“允许重新读取”后下次在 BOSS 遇到此人时可重新入库。</div>
      <Input className="recycle-bin-search" prefix={<SearchOutlined />} placeholder="搜索姓名或基本信息" aria-label="搜索回收站" allowClear disabled={busy || trashLoading} value={trashQuery} onChange={event => { setTrashQuery(event.target.value); setTrashSelection([]); }} />
      <div className="recycle-batch-toolbar"><Checkbox disabled={busy || trashLoading || !filteredTrash.length} checked={!!filteredTrash.length && filteredTrash.every(person => trashSelection.includes(person.id))} indeterminate={trashSelection.length > 0 && !filteredTrash.every(person => trashSelection.includes(person.id))} onChange={event => setTrashSelection(event.target.checked ? filteredTrash.map(person => person.id) : [])}>{trashQuery.trim() ? '全选搜索结果' : '全选全部'}（{filteredTrash.length} 人）</Checkbox><Space wrap><span className="muted">已选 {trashSelection.length} 人 · 可跨页选择</span><Button type="primary" size="small" icon={<UndoOutlined />} loading={!!restoring} disabled={busy || trashLoading || !trashSelection.length} onClick={() => void allowAgain(trash.filter(person => trashSelection.includes(person.id)))}>批量允许重新读取</Button></Space></div>
      {restoring && restoreProgress && <Progress size="small" percent={Math.round(restoreProgress.completed / restoreProgress.total * 100)} format={() => `${restoreProgress.completed}/${restoreProgress.total}`} />}
      {trashNotice && <Alert className="recycle-bin-feedback" type="success" showIcon message={trashNotice} />}
      {trashError && <Alert type="warning" showIcon message={trashError} action={<Button size="small" onClick={() => void openTrash()}>重试</Button>} />}
      <Table<RecycledRecommendation> rowKey="id" size="middle" loading={trashLoading} dataSource={filteredTrash} rowSelection={{ selectedRowKeys: trashSelection, preserveSelectedRowKeys: true, onChange: keys => setTrashSelection(keys.map(String)), getCheckboxProps: () => ({ disabled: busy || trashLoading }), columnWidth: 42 }} columns={[{ title: '姓名', dataIndex: 'name', width: 160 }, { title: '基本信息', dataIndex: 'baseInfo', render: (value: string) => <span className="recommendation-cell">{value || '—'}</span> }, { title: '排除范围', dataIndex: 'scope_label', width: 110 }, { title: '操作', key: 'restore', width: 160, render: (_: unknown, person: RecycledRecommendation) => <Button type="link" size="small" icon={<UndoOutlined />} loading={restoring === person.id} disabled={busy || trashLoading} onClick={() => void allowAgain([person])}>允许重新读取</Button> }]} pagination={{ disabled: !!restoring, pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={trashQuery ? '没有匹配的回收站记录' : '回收站为空，删除的人选会记录在这里'} /> }} />
    </Modal>
    <Modal title={`${preview?.name ?? ''} · 在线简历截图`} open={!!preview} onCancel={() => setPreview(null)} width={1000} footer={preview ? <Button icon={<DownloadOutlined />} href={resumeScreenshotUrl(preview.screenshot)} download={`${preview.name}-在线简历.png`}>保存图片</Button> : null} destroyOnClose>
      {preview && <><p className="muted">保存于 {savedTime(preview.screenshot.captured_at)} · 在线简历页面截图</p><div className="resume-image-viewer"><Image key={preview.screenshot.id} src={resumeScreenshotUrl(preview.screenshot)} alt={`${preview.name}的在线简历截图`} width="100%" preview={{ mask: '放大查看' }} /></div></>}
    </Modal>
    <Modal title={<Space><RobotOutlined /> 批量 AI 评估 <Tag>{evaluationPeople.length} 人</Tag></Space>} open={evaluationModal} onCancel={() => { if (!evaluationWorking) setEvaluationModal(false); }} onOk={() => void startEvaluation()} okText={evaluationPromptDirty ? '保存并开始评估' : '开始评估'} okButtonProps={{ disabled: !evaluationConfig?.model || !evaluationConfig.prompt.trim() || evaluationPeople.length > 20 }} confirmLoading={evaluationWorking} footer={(_, { OkBtn, CancelBtn }) => <Space><Button disabled={evaluationWorking || !evaluationConfig || !evaluationPromptDirty} onClick={() => void startEvaluation(true)}>仅保存 JD 与打分标准</Button><CancelBtn /><OkBtn /></Space>} closable={!evaluationWorking} width={760}>
      {evaluationError && <Alert type="warning" showIcon message={evaluationError} style={{ marginBottom: 16 }} />}
      <p className="muted">当前岗位：{selectedJob?.label} · 逐人发送已保存的本地资料；每次最多 20 人，使用 AI 管理中已配置的模型。</p>
      <div className="recommendation-ai-option"><Checkbox checked={evaluationImages} disabled={evaluationWorking} onChange={event => setEvaluationImages(event.target.checked)}>附带在线简历图片</Checkbox><span className="muted">所选 {evaluationPeople.filter(person => !!person.online_resume).length} 人已有截图；无截图的人只发送文字。模型需支持图片。</span></div>
      <label className="recommendation-ai-label">通用提示词 · 在 AI 管理中编辑</label><div className="recommendation-ai-answer">{evaluationConfig?.prompt || '正在读取通用提示词…'}</div>
      <label className="recommendation-ai-label" htmlFor="recommendation-ai-context">当前岗位 JD（可选）</label><Input.TextArea id="recommendation-ai-context" value={evaluationContext} disabled={evaluationWorking} maxLength={10000} autoSize={{ minRows: 2, maxRows: 4 }} onChange={event => { setEvaluationContext(event.target.value); setEvaluationPromptDirty(true); }} placeholder="可粘贴完整 JD 或岗位要求；保存后与 AI 管理同步" />
      <label className="recommendation-ai-label" htmlFor="recommendation-ai-prompt">当前岗位打分标准 · {evaluationPromptCustom ? '已保存' : '尚未设置'}</label><Input.TextArea id="recommendation-ai-prompt" value={evaluationPrompt} disabled={evaluationWorking || !evaluationConfig} maxLength={20000} autoSize={{ minRows: 5, maxRows: 11 }} onChange={event => { setEvaluationPrompt(event.target.value); setEvaluationPromptDirty(true); }} placeholder="写下当前岗位的打分规则；通用回答格式仍由通用提示词决定" />
      {!evaluationConfig?.model && <p className="muted">请先到 AI 管理页面选择模型并保存配置。</p>}
    </Modal>
    <Modal title={`${evaluationDetail?.candidate_id ? snapshot?.candidates.find(person => person.id === evaluationDetail.candidate_id)?.name ?? '候选人' : ''} · AI 评估详情`} open={!!evaluationDetail} onCancel={() => setEvaluationDetail(null)} footer={<Button onClick={() => setEvaluationDetail(null)}>关闭</Button>} width={800}>
      {evaluationDetail && <><p className="muted">{evaluationDetail.model} · {savedTime(evaluationDetail.created_at)}</p><div className="recommendation-ai-answer">{evaluationDetail.output}</div></>}
    </Modal>
  </section>;
}
