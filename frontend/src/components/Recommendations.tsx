import { useEffect, useRef, useState } from 'react';
import { Alert, Avatar, Button, Empty, Image, Input, Modal, Popconfirm, Progress, Space, Table, Tag, Tooltip } from 'antd';
import { DeleteOutlined, DownloadOutlined, EyeOutlined, FileImageOutlined, ReloadOutlined, SearchOutlined, TeamOutlined, UndoOutlined } from '@ant-design/icons';
import { allowRecommendationAgain, captureRecommendedResume, deleteRecommendation, fetchRecommendationRecycleBin, fetchRecommendations, readRecommendations, resumeScreenshotUrl, type OnlineResumeScreenshot, type RecommendedPerson, type RecommendationSnapshot, type RecycledRecommendation } from '../api';
import { captureRecommendationBatch, type ResumeBatchProgress } from '../recommendationBatch';

const savedTime = (value: string) => new Date(/Z$|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });

export function Recommendations({ busy, setBusy }: { busy: boolean; setBusy: (busy: boolean) => void }) {
  const [snapshot, setSnapshot] = useState<RecommendationSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [trash, setTrash] = useState<RecycledRecommendation[]>([]);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashLoading, setTrashLoading] = useState(false);
  const [trashError, setTrashError] = useState<string | null>(null);
  const [trashQuery, setTrashQuery] = useState('');
  const [restoring, setRestoring] = useState<string | null>(null);
  const [trashNotice, setTrashNotice] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [reading, setReading] = useState(false);
  const [batchProgress, setBatchProgress] = useState<ResumeBatchProgress | null>(null);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ name: string; screenshot: OnlineResumeScreenshot } | null>(null);
  const locked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    Promise.all([fetchRecommendations(controller.signal), fetchRecommendationRecycleBin(controller.signal)]).then(([library, bin]) => {
      setSnapshot(library); setTrash(bin.candidates);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(String(reason.message ?? reason));
    }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const openTrash = async () => {
    setTrashOpen(true); setTrashQuery(''); setTrashLoading(true); setTrashError(null); setTrashNotice(null);
    try { setTrash((await fetchRecommendationRecycleBin()).candidates); }
    catch (reason) { setTrashError(reason instanceof Error ? reason.message : '读取回收站失败'); }
    finally { setTrashLoading(false); }
  };
  const allowAgain = async (person: RecycledRecommendation) => {
    if (locked.current || busy || trashLoading) return;
    locked.current = true; setRestoring(person.id); setBusy(true); setTrashError(null); setTrashNotice(null);
    try {
      await allowRecommendationAgain(person.id);
      setTrash(current => current.filter(item => item.id !== person.id));
      setTrashNotice(`已允许重新读取“${person.name}”。下次点击“新增 10 人”并在 BOSS 列表遇到此人时，会重新入库和截图。`);
    } catch (reason) { setTrashError(reason instanceof Error ? reason.message : '操作失败，请重试'); }
    finally { locked.current = false; setRestoring(null); setBusy(false); }
  };
  const read = async () => {
    if (locked.current || busy) return;
    locked.current = true; setReading(true); setBusy(true); setError(null); setBatchProgress(null);
    try {
      const next = await readRecommendations();
      setSnapshot(next); setPage(1);
      const failures = await captureRecommendationBatch(next.candidates.filter(person => next.added_ids.includes(person.id)), async person => {
        setCapturing(person.id);
        return captureRecommendedResume(person.geekId, person.id);
      }, (person, screenshot) => {
        setSnapshot(current => current && ({ ...current, candidates: current.candidates.map(item => item.id === person.id ? { ...item, online_resume: screenshot } : item) }));
      }, setBatchProgress);
      if (failures.length) setError(failures.join('；'));
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : '读取失败，请重试'); }
    finally { locked.current = false; setCapturing(null); setReading(false); setBusy(false); }
  };
  const capture = async (person: RecommendedPerson) => {
    if (locked.current || busy || !person.geekId) return;
    locked.current = true; setCapturing(person.id); setBusy(true); setError(null); setBatchProgress(null);
    try {
      const screenshot = await captureRecommendedResume(person.geekId, person.id);
      setSnapshot(current => current && ({ ...current, candidates: current.candidates.map(item => item.id === person.id ? { ...item, online_resume: screenshot } : item) }));
    } catch (reason) { setError(`${person.name}：${reason instanceof Error ? reason.message : '截图失败，请重试'}`); }
    finally { locked.current = false; setCapturing(null); setBusy(false); }
  };
  const remove = async (person: RecommendedPerson) => {
    if (locked.current || busy) return;
    locked.current = true; setDeleting(person.id); setBusy(true); setError(null); setBatchProgress(null);
    try {
      await deleteRecommendation(person.id);
      setSnapshot(current => current && ({ ...current, candidates: current.candidates.filter(item => item.id !== person.id) }));
      setPage(1);
      setPreview(null);
      setTrash((await fetchRecommendationRecycleBin()).candidates);
    } catch (reason) { setError(reason instanceof Error ? reason.message : '删除失败，请重试'); }
    finally { locked.current = false; setDeleting(null); setBusy(false); }
  };
  const columns = [
    { title: '姓名', key: 'name', width: 150, fixed: 'left' as const, render: (_: unknown, person: RecommendedPerson) => <div className="recommendation-name"><Avatar size={30}>{person.name.slice(0, 1)}</Avatar><div><strong>{person.name}</strong>{person.advantage && <Tooltip title={person.advantage}><span className="recommendation-intro">个人介绍</span></Tooltip>}</div></div> },
    { title: '基本信息', dataIndex: 'baseInfo', key: 'base', width: 175, render: (value: string) => <div className="recommendation-cell">{value || '—'}</div> },
    { title: '期望职位', dataIndex: 'expect', key: 'expect', width: 180, render: (value: string) => <div className="recommendation-cell">{value || '—'}</div> },
    { title: '期望薪资', dataIndex: 'salary', key: 'salary', width: 100, render: (value: string) => <span className="recommendation-salary">{value || '—'}</span> },
    { title: '契合程度', key: 'fit', width: 110, render: () => null },
    { title: '标签', key: 'tags', width: 180, render: (_: unknown, person: RecommendedPerson) => <Space size={[0, 4]} wrap>{person.highlights.map((label, i) => <Tag key={`${label}-${i}`}>{label}</Tag>)}{person.hasHistoryChat && <Tag>同事沟通过</Tag>}{person.hasViewed && <Tag>已看过</Tag>}{!person.highlights.length && !person.hasHistoryChat && !person.hasViewed && '—'}</Space> },
    { title: '在线简历', key: 'resume', width: 185, fixed: 'right' as const, render: (_: unknown, person: RecommendedPerson) => person.online_resume ? <div className="resume-table-cell">
      <button className="resume-thumbnail" aria-label={`查看${person.name}的在线简历截图`} onClick={() => setPreview({ name: person.name, screenshot: person.online_resume! })}><img src={resumeScreenshotUrl(person.online_resume)} alt={`${person.name}的在线简历截图`} loading="lazy" /></button>
      <div><Button type="link" size="small" icon={<EyeOutlined />} onClick={() => setPreview({ name: person.name, screenshot: person.online_resume! })}>查看截图</Button><time>{savedTime(person.online_resume.captured_at)}</time><Button type="text" size="small" icon={<ReloadOutlined />} loading={capturing === person.id} disabled={busy} onClick={() => void capture(person)}>重新读取</Button></div>
    </div> : <div className="resume-table-empty"><Button size="small" icon={<FileImageOutlined />} loading={capturing === person.id} disabled={busy || !person.geekId} onClick={() => void capture(person)}>读取在线简历</Button><span>{!person.geekId ? '缺少ID，请重新读取列表' : capturing === person.id ? '正在打开简历并截图…' : '点击后保存此人的截图'}</span></div> },
    { title: '', key: 'actions', width: 48, fixed: 'right' as const, render: (_: unknown, person: RecommendedPerson) => <Popconfirm title={`删除“${person.name}”？`} description="移入回收站，只保留姓名和基本信息；清理其余资料及截图，后续不再拉取。" okText="删除" cancelText="取消" onConfirm={() => remove(person)} disabled={busy}><Button className="recommendation-delete" type="text" size="small" danger icon={<DeleteOutlined />} aria-label={`删除${person.name}`} title="删除人选" loading={deleting === person.id} disabled={busy} /></Popconfirm> },
  ];

  return <section className="recommendations-page panel">
    <div className="recommendations-heading"><div><div className="section-kicker">本地人才库</div><h2><TeamOutlined /> 推荐牛人</h2><p>持续积累推荐人选，按姓名与基本信息查重，保留每次读取的简历截图。</p></div><Space wrap><Button icon={<DeleteOutlined />} disabled={busy || loading} onClick={() => void openTrash()}>回收站{trash.length ? `（${trash.length}）` : ''}</Button><Button type="primary" icon={<SearchOutlined />} loading={reading} disabled={busy || loading} onClick={() => void read()}>{reading ? batchProgress ? `简历截图 ${batchProgress.completed}/${batchProgress.total}` : '正在查重并寻找新人…' : '新增 10 人（含简历）'}</Button></Space></div>
    <div className="recommendations-notice">每次新增最多 10 人 · 姓名＋基本信息联合查重（含回收站） · 只为本次新人截图 · 历史记录持续保留</div>
    {(reading || batchProgress) && <div className="recommendation-batch" role="status" aria-live="polite"><div className="recommendation-batch-title"><strong>{reading ? batchProgress ? `正在读取${batchProgress.currentName ? `：${batchProgress.currentName}` : '在线简历'}…` : '正在获取推荐列表…' : batchProgress?.total ? '本次读取完成' : '本次没有找到新的人选，原有名单已保留'}</strong><span>{batchProgress ? `已处理 ${batchProgress.completed}/${batchProgress.total} 人 · 截图成功 ${batchProgress.completed - batchProgress.failed} 人${batchProgress.failed ? ` · 失败 ${batchProgress.failed} 人，可单独重试` : ''}` : '先查重，随后只为新增人选打开简历并截图'}</span></div>{batchProgress && batchProgress.total > 0 && <Progress percent={Math.round(batchProgress.completed / batchProgress.total * 100)} size="small" showInfo={false} status={reading ? 'active' : batchProgress.failed ? 'normal' : 'success'} strokeColor="#398e70" />}<span className="muted">{reading ? '请保持此页面打开，完成的截图会逐行显示。' : batchProgress && batchProgress.completed > batchProgress.failed ? '成功的截图已保存在本地，可点击缩略图查看。' : '暂无新截图，失败项可使用行内按钮单独重试。'}</span></div>}
    {batchProgress && !reading && snapshot?.stop_reason === 'scan_limit' && <Alert className="recommendation-error" type="info" showIcon message="已达到本次查找上限，已保存找到的新人；可再次点击继续查找。" />}
    {error && <Alert className="recommendation-error" closable onClose={() => setError(null)} type="warning" showIcon message={error} />}
    <div className="recommendations-meta"><strong>最近读取岗位：{snapshot?.job_label || '读取后显示'}</strong><span>{snapshot?.captured_at ? `${snapshot.candidates.length} 人累计 · 最近读取于 ${savedTime(snapshot.captured_at)}` : '尚未读取推荐列表'}</span></div>
    <Table<RecommendedPerson> className="recommendation-table" rowKey="id" columns={columns} dataSource={snapshot?.candidates ?? []} loading={loading} pagination={{ current: page, onChange: setPage, pageSize: 10, showSizeChanger: false, hideOnSinglePage: true, showTotal: total => `共 ${total} 人` }} scroll={{ x: 1200 }} size="middle" locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={snapshot?.captured_at ? '本地暂无推荐人选' : '先在 BOSS 推荐页选择岗位，再点击“新增10人（含简历）”'} /> }} />
    <div className="recommendation-table-footer"><FileImageOutlined /> 在线简历列保存页面截图；点击缩略图可放大查看。刷新网页只读取本地已保存内容。</div>
    <Modal title={<Space><DeleteOutlined /><span>推荐牛人回收站</span><Tag>{trash.length} 人</Tag></Space>} open={trashOpen} onCancel={() => setTrashOpen(false)} width={760} footer={<Button onClick={() => setTrashOpen(false)}>关闭</Button>}>
      <div className="recycle-bin-notice">只保留姓名和基本信息用于查重。两个字段都相同的人选，后续新增时会自动跳过；同名但基本信息不同的人选仍可新增。点击“允许重新读取”后，下次在 BOSS 遇到此人时可重新入库；已删除的资料和截图需重新读取。</div>
      <Input className="recycle-bin-search" prefix={<SearchOutlined />} placeholder="搜索姓名或基本信息" aria-label="搜索回收站" allowClear value={trashQuery} onChange={event => setTrashQuery(event.target.value)} />
      {trashNotice && <Alert className="recycle-bin-feedback" type="success" showIcon message={trashNotice} />}
      {trashError && <Alert type="warning" showIcon message={trashError} action={<Button size="small" onClick={() => void openTrash()}>重试</Button>} />}
      <Table<RecycledRecommendation> rowKey="id" size="middle" loading={trashLoading} dataSource={trash.filter(person => `${person.name} ${person.baseInfo}`.toLowerCase().includes(trashQuery.trim().toLowerCase()))} columns={[{ title: '姓名', dataIndex: 'name', width: 160 }, { title: '基本信息', dataIndex: 'baseInfo', render: (value: string) => <span className="recommendation-cell">{value || '—'}</span> }, { title: '操作', key: 'restore', width: 160, render: (_: unknown, person: RecycledRecommendation) => <Button type="link" size="small" icon={<UndoOutlined />} loading={restoring === person.id} disabled={busy || trashLoading} onClick={() => void allowAgain(person)}>允许重新读取</Button> }]} pagination={{ pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={trashQuery ? '没有匹配的回收站记录' : '回收站为空，删除的人选会记录在这里'} /> }} />
    </Modal>
    <Modal title={`${preview?.name ?? ''} · 在线简历截图`} open={!!preview} onCancel={() => setPreview(null)} width={1000} footer={preview ? <Button icon={<DownloadOutlined />} href={resumeScreenshotUrl(preview.screenshot)} download={`${preview.name}-在线简历.png`}>保存图片</Button> : null} destroyOnClose>
      {preview && <><p className="muted">保存于 {savedTime(preview.screenshot.captured_at)} · 在线简历页面截图</p><div className="resume-image-viewer"><Image key={preview.screenshot.id} src={resumeScreenshotUrl(preview.screenshot)} alt={`${preview.name}的在线简历截图`} width="100%" preview={{ mask: '放大查看' }} /></div></>}
    </Modal>
  </section>;
}
