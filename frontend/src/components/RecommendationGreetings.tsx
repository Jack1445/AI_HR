import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Progress, Select, Space, Table, Tag } from 'antd';
import { MessageOutlined } from '@ant-design/icons';
import type { RecommendedPerson } from '../api';
import type { RecommendationActivity } from '../recommendationBatch';
import './RecommendationGreetings.css';

interface GreetingItem { candidate_id: string; name: string; base_info: string; status: string; detail: string }
interface GreetingBatch { id: string; job_key: string; job_label: string; status: string; total: number; completed: number; sent: number; already: number; items: GreetingItem[]; created_at: string }
interface DailyGreetingCount { date: string; count: number; limit: number }
const active = (batch?: GreetingBatch | null) => !!batch && ['queued', 'running'].includes(batch.status);
const statusLabels: Record<string, string> = { pending: '等待中', executing: '处理中', sent: '已发送', already: '已招呼 · 跳过', clicked: '已点击 · 待核实', unknown: '结果待核实', not_found: '未找到', mismatch: '信息不符', blocked: 'BOSS 限制', skipped: '未执行' };
async function request<T>(method = 'GET', body?: unknown, path = ''): Promise<T> {
  const response = await fetch(`${import.meta.env.VITE_API_BASE_URL ?? ''}/api/recommendation-greetings${path}`, { method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(typeof data.detail === 'string' ? data.detail : `请求失败（${response.status}）`);
  }
  return response.json();
}

export function useRecommendationGreetings(jobKey: string, jobLabel: string, setBusy: (busy: boolean) => void) {
  const [batches, setBatches] = useState<GreetingBatch[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [pollError, setPollError] = useState('');
  const [dismissedResultId, setDismissedResultId] = useState('');
  const [dailyCount, setDailyCount] = useState<DailyGreetingCount | null>(null);
  const [dailyError, setDailyError] = useState('');
  const [draft, setDraft] = useState<{ request_id: string; job_key: string; job_label: string; people: RecommendedPerson[] } | null>(null);
  const [starting, setStarting] = useState(false);
  const [details, setDetails] = useState(false);
  const [historyId, setHistoryId] = useState('');
  const ownedBusy = useRef(false);
  const submitting = useRef(false);
  const sequence = useRef(0);
  const lastCountPoll = useRef(0);
  const wasRunning = useRef(false);
  const current = batches.find(active) ?? batches.find(b => b.job_key === jobKey);
  const running = active(current);
  useEffect(() => {
    if (!current || running || dismissedResultId === current.id) return;
    const timer = window.setTimeout(() => setDismissedResultId(current.id), 10_000);
    return () => window.clearTimeout(timer);
  }, [current?.id, running, dismissedResultId]);
  useEffect(() => {
    if (!error) return;
    const timer = window.setTimeout(() => setError(''), 10_000);
    return () => window.clearTimeout(timer);
  }, [error]);
  const chosen = batches.find(b => b.id === historyId) ?? current;
  const greetedIds = useMemo(() => new Set(batches.filter(b => b.job_key === jobKey).flatMap(b => b.items.filter(i => i.status === 'sent').map(i => i.candidate_id))), [batches, jobKey]);
  // Polling is read-only; only the final confirmation below creates a task.
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const seq = sequence.current;
      try {
        const data = await request<GreetingBatch[]>();
        if (!disposed && seq === sequence.current) { setBatches(data); setReady(true); setPollError(''); }
        const activeNow = data.some(active);
        if (activeNow || wasRunning.current || Date.now() - lastCountPoll.current >= 30_000) {
          lastCountPoll.current = Date.now();
          try {
            const count = await request<DailyGreetingCount>('GET', undefined, '/daily-count');
            if (!disposed && seq === sequence.current) { setDailyCount(count); setDailyError(''); }
          } catch (reason) {
            if (!disposed && seq === sequence.current) setDailyError(reason instanceof Error ? reason.message : '今日打招呼次数暂不可用');
          }
        }
        wasRunning.current = activeNow;
      } catch (reason) { if (!disposed) { setReady(false); setPollError(`无法更新打招呼任务：${reason instanceof Error ? reason.message : '连接失败'}。请恢复连接后查看，勿重复发送。`); } }
      if (!disposed) timer = setTimeout(poll, 2000);
    };
    void poll();
    return () => { disposed = true; clearTimeout(timer); };
  }, []);
  useEffect(() => {
    if (running || starting) { ownedBusy.current = true; setBusy(true); }
    else if (ownedBusy.current) { ownedBusy.current = false; setBusy(false); }
  }, [running, starting, setBusy]);
  const activity = useMemo<RecommendationActivity | null>(() => current && (running || dismissedResultId !== current.id) ? {
    kind: 'greet', running, job: current.job_label,
    progress: { total: current.total, completed: current.completed, failed: current.items.filter(i => !['sent', 'already', 'pending', 'executing'].includes(i.status)).length, currentName: current.items.find(i => i.status === 'executing')?.name ?? null },
    error: pollError || (current.items.some(i => !['sent', 'already', 'pending', 'executing'].includes(i.status)) ? '部分人选需查看结果' : null),
  } : null, [current, running, pollError, dismissedResultId]);
  const submit = async () => {
    if (!draft || submitting.current || running) return;
    submitting.current = true; setStarting(true); setError(''); sequence.current++;
    try {
      const batch = await request<GreetingBatch>('POST', { request_id: draft.request_id, job_key: draft.job_key, candidate_ids: draft.people.map(p => p.id), confirmed: true });
      sequence.current++;
      setBatches(previous => [batch, ...previous.filter(b => b.id !== batch.id)]);
      setDraft(null); setHistoryId(batch.id); setDetails(true);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '提交失败，请查看任务状态');
      // A lost response must not trigger another POST. A manual retry uses the same request ID.
    } finally { submitting.current = false; setStarting(false); }
  };
  const columns = [
    { title: '人选', key: 'person', width: 210, render: (_: unknown, i: GreetingItem) => <div><strong>{i.name}</strong><div className="muted">{i.base_info}</div></div> },
    { title: '状态', key: 'status', width: 145, render: (_: unknown, i: GreetingItem) => <Tag color={['sent', 'already'].includes(i.status) ? 'success' : i.status === 'executing' ? 'processing' : ['unknown', 'clicked', 'blocked'].includes(i.status) ? 'warning' : 'default'}>{statusLabels[i.status] ?? i.status}</Tag> },
    { title: '执行结果', dataIndex: 'detail', key: 'detail' },
  ];
  return {
    ready, activity, greetedIds, dailyCount, dailyError,
    select: (people: RecommendedPerson[]) => { setError(''); setDraft({ request_id: crypto.randomUUID(), job_key: jobKey, job_label: jobLabel, people: [...people] }); },
    panel: <>
      {error && <Alert className="greeting-feedback" type="warning" showIcon message={error} />}
      {pollError && <Alert className="greeting-feedback" type="warning" showIcon message={pollError} />}
      {current && (running || dismissedResultId !== current.id) && <div className="greeting-progress" role="status" aria-live="polite"><div className="greeting-progress-heading"><Space><MessageOutlined /><strong>{running ? '正在逐一打招呼' : current.status === 'interrupted' ? '打招呼任务已中断' : '本次打招呼结果'}</strong><Tag>{current.completed}/{current.total} 人</Tag></Space><Button size="small" type="link" onClick={() => { setHistoryId(current.id); setDetails(true); }}>查看明细</Button></div><div className="muted">{current.job_label}</div><Progress percent={current.total ? Math.round(current.completed / current.total * 100) : 0} size="small" showInfo={false} status={running ? 'active' : 'normal'} /><span>已发送 {current.sent} 人 · 已招呼跳过 {current.already} 人 · 其他 {current.completed - current.sent - current.already} 人{running ? ' · 切换页面后仍会继续，进度自动保存' : ''}</span></div>}
      <Modal title={<Space><MessageOutlined />确认批量打招呼</Space>} open={!!draft} width={700} onCancel={() => { if (!starting) setDraft(null); }} maskClosable={!starting} closable={!starting} cancelButtonProps={{ disabled: starting }} confirmLoading={starting} okButtonProps={{ disabled: running }} okText={`确认向 ${draft?.people.length ?? 0} 人打招呼`} cancelText="取消" onOk={() => void submit()}>
        <p className="greeting-confirm-job">对应岗位：<strong>{draft?.job_label}</strong></p>
        <Alert type="info" showIcon message="确认后将向以下人选发送 BOSS 打招呼，可能消耗平台招呼额度。" description="逐人核对 ID、姓名、基本信息和岗位；列表已刷新且无法找到的人会跳过。已招呼和发送结果未确认的人不会自动重发。" />
        <Table className="greeting-confirm-list" rowKey="id" size="small" dataSource={draft?.people ?? []} columns={[{ title: '姓名', dataIndex: 'name', width: 140 }, { title: '基本信息', dataIndex: 'baseInfo' }]} pagination={false} scroll={{ y: 280 }} />
        {error && <Alert type="warning" showIcon message={error} />}
      </Modal>
      <Modal title="打招呼 · 执行明细" open={details} onCancel={() => setDetails(false)} width={880} footer={<Button onClick={() => setDetails(false)}>关闭</Button>}>
        <Select aria-label="查看打招呼任务" className="greeting-history" value={chosen?.id} onChange={setHistoryId} options={batches.map(b => ({ value: b.id, label: `${new Date(/Z$|[+-]\d{2}:\d{2}$/.test(b.created_at) ? b.created_at : `${b.created_at}Z`).toLocaleString('zh-CN')} · ${b.total} 人 · ${b.job_label}` }))} />
        {chosen && <><p className="muted">已处理 {chosen.completed}/{chosen.total} 人 · 已发送 {chosen.sent} 人 · 已招呼跳过 {chosen.already} 人</p><Table<GreetingItem> rowKey="candidate_id" size="small" dataSource={chosen.items} columns={columns} pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: 660 }} /></>}
      </Modal>
    </>,
  };
}
