import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Empty, Form, Image, Input, InputNumber, Modal, Progress, Select, Space, Spin, Switch, Table, Tag, Tooltip, message } from 'antd';
import { ApiOutlined, CheckCircleOutlined, DatabaseOutlined, EyeOutlined, HistoryOutlined, PlayCircleOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined, SaveOutlined } from '@ant-design/icons';
import { aiImage, aiRequest, type AICatalog, type AIConfig, type AIItem, type AIRun, type AISelection, type AIModelList } from '../aiApi';
import './AIManagement.css';

const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重试';
const running = (run?: AIRun | null) => !!run && ['queued', 'running'].includes(run.status);
const statuses: Record<string, string> = { queued: '排队中', running: '分析中', success: '已完成', partial: '部分完成', failed: '未完成' };
const timeText = (value: string) => new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`).toLocaleString('zh-CN', { hour12: false });

export function AIManagement({ active, onOpen }: { active: boolean; onOpen: () => void }) {
  const [toast, context] = message.useMessage();
  const [config, setConfig] = useState<AIConfig | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [manualModel, setManualModel] = useState(false);
  const modelVersion = useRef(0);
  const [source, setSource] = useState<AISelection['source']>('recommendations');
  const [jobId, setJobId] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const [includeImages, setIncludeImages] = useState(false);
  const [jobContext, setJobContext] = useState('');
  const [catalog, setCatalog] = useState<AICatalog>({ jobs: [], candidates: [] });
  const [dataLoading, setDataLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [preview, setPreview] = useState<AIItem[] | null>(null);
  const [history, setHistory] = useState<AIRun[]>([]);
  const [current, setCurrent] = useState<AIRun | null>(null);
  const [pollError, setPollError] = useState('');
  const [resultId, setResultId] = useState('');
  const resultVersion = useRef(0);
  const currentId = useRef('');
  const initialized = useRef(false);
  const isRunning = history.some(running) || running(current);
  const task = history.find(running) ?? (running(current) ? current : null);
  const busy = !!working || modelsLoading;

  function clearModels() {
    modelVersion.current++; setModels([]); setModelsLoaded(false); setModelsError('');
  }
  async function loadModels() {
    const version = ++modelVersion.current;
    setModelsLoading(true); setModelsError(''); setModelsLoaded(false); setModels([]);
    try {
      const result = await aiRequest<AIModelList>('/models', 'POST', undefined, AbortSignal.timeout(40000));
      if (version === modelVersion.current) { setModels(result.models); setModelsLoaded(true); }
    } catch (e) { if (version === modelVersion.current) setModelsError(errorText(e)); }
    finally { setModelsLoading(false); }
  }

  async function showRun(id: string) {
    const version = ++resultVersion.current;
    const row = await aiRequest<AIRun>(`/runs/${id}`);
    if (version === resultVersion.current) { setCurrent(row); currentId.current = id; }
  }
  async function load() {
    setError('');
    try {
      const [settings, runs] = await Promise.all([aiRequest<AIConfig>('/config'), aiRequest<AIRun[]>('/runs')]);
      setConfig(settings); setHistory(runs); initialized.current = true;
      if (settings.has_key || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/.test(settings.base_url)) void loadModels();
      if (runs[0]) await showRun(runs[0].id);
    } catch (e) { setError(errorText(e)); }
  }
  useEffect(() => { if (active && !initialized.current) void load(); }, [active]);
  useEffect(() => {
    if (!config) return;
    const abort = new AbortController();
    setDataLoading(true);
    void aiRequest<AICatalog>(`/data?source=${source}&job_id=${encodeURIComponent(jobId)}`, 'GET', undefined, abort.signal)
      .then(value => { setCatalog(value); setSelected(ids => ids.filter(id => value.candidates.some(c => c.id === id))); })
      .catch(e => { if (!abort.signal.aborted) setError(errorText(e)); })
      .finally(() => { if (!abort.signal.aborted) setDataLoading(false); });
    return () => abort.abort();
  }, [!!config, source, jobId, refresh]);
  useEffect(() => {
    if (!config) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const runs = await aiRequest<AIRun[]>('/runs', 'GET', undefined, AbortSignal.timeout(10000));
        if (stopped) return;
        setHistory(runs); setPollError('');
        if (currentId.current && runs.some(r => r.id === currentId.current)) {
          const id = currentId.current;
          const row = await aiRequest<AIRun>(`/runs/${id}`, 'GET', undefined, AbortSignal.timeout(10000));
          if (!stopped && currentId.current === id) {
            setCurrent(row);
            setHistory(rows => rows.map(value => value.id === id ? { ...value, status: row.status, completed: row.completed, failed: row.failed, error: row.error } : value));
          }
        }
      } catch { if (!stopped) setPollError('进度暂时连接不上，后台任务可能仍在继续；正在重新连接。'); }
      finally { if (!stopped) timer = setTimeout(() => void poll(), isRunning ? 2000 : 10000); }
    };
    timer = setTimeout(() => void poll(), 2000);
    return () => { stopped = true; clearTimeout(timer); };
  }, [!!config, isRunning]);

  function edit<K extends keyof AIConfig>(key: K, value: AIConfig[K]) {
    if (key === 'base_url') clearModels();
    setConfig(c => c ? { ...c, ...(key === 'base_url' ? { send_session_id: false } : {}), [key]: value } : c); setDirty(true); setConnection('');
  }
  async function persist(changes: Partial<AIConfig> = {}) {
    if (!config) throw new Error('配置尚未加载');
    const { has_key: _hasKey, ...fields } = { ...config, ...changes };
    const saved = await aiRequest<AIConfig>('/config', 'PUT', { ...fields, api_key: apiKey.trim() || null, clear_key: clearKey });
    setConfig(saved); setApiKey(''); setClearKey(false); setDirty(false);
    return saved;
  }
  async function action(kind: string, operation: () => Promise<void>) {
    if (working) return;
    setWorking(kind); setError('');
    try { await operation(); } catch (e) { setError(errorText(e)); } finally { setWorking(''); }
  }
  const selection: AISelection = { source, job_id: jobId, candidate_ids: selected, include_images: source === 'recommendations' && includeImages, job_context: jobContext };
  const visible = catalog.candidates.filter(c => `${c.name} ${c.summary} ${c.job}`.toLowerCase().includes(query.trim().toLowerCase()));
  const imageCount = includeImages && source === 'recommendations' ? catalog.candidates.filter(c => selected.includes(c.id) && c.has_image).length : 0;
  const item = current?.items?.find(i => i.candidate_id === resultId) ?? current?.items?.[0];

  return <>{context}
    {!active && task && <div className="workspace-task-progress" role="status"><div className="workspace-task-heading"><strong><RobotOutlined /> AI 分析正在后台进行 · {task.completed}/{task.total} 人</strong><Button type="link" onClick={onOpen}>查看 AI 任务</Button></div><Progress percent={Math.round(task.completed / task.total * 100)} size="small" showInfo={false} /></div>}
    <div hidden={!active} className="ai-page">
      <div className="ai-hero"><div><div className="eyebrow">YOUR LOCAL TALENT, WITH AI</div><h1><RobotOutlined /> AI 管理</h1><p>连接你的模型，让本地人才资料成为分析的依据。</p></div><div className="ai-mode"><SafetyCertificateOutlined /><span>手动运行 · 结果保存到本地</span></div></div>
      {error && <Alert type="error" showIcon message={error} closable onClose={() => setError('')} />}
      {!config ? <div className="ai-loading"><Spin /><span>正在加载 AI 工作区</span>{error && <Button onClick={() => void load()}>重新加载</Button>}</div> : <>
        <div className="ai-layout">
          <section className="ai-card ai-connection">
            <div className="ai-card-title"><span className="ai-step">01</span><div><h2>接入模型</h2><p>支持 New API 等 OpenAI 兼容服务</p></div><ApiOutlined /></div>
            <Form layout="vertical" disabled={busy}>
              <Form.Item label="API 基础地址 · Base URL" extra="填写实际服务地址，如 https://你的服务域名/v1。只填域名会补充 /v1，已有路径会保留。"><Input aria-label="API 基础地址" value={config.base_url} onChange={e => edit('base_url', e.target.value)} placeholder="https://你的服务域名/v1" /></Form.Item>
              <Form.Item label={<Space>API Key {config.has_key && !clearKey && <Tag color="green">已保存</Tag>}</Space>} extra="New API 可填平台生成的 API 密钥（令牌）。本机加密保存，留空保留已有密钥。"><Input.Password aria-label="API Key" autoComplete="new-password" value={apiKey} onChange={e => { clearModels(); setApiKey(e.target.value); setDirty(true); setConnection(''); }} placeholder={config.has_key ? '已配置，输入新密钥可替换' : '粘贴 API 密钥（本机免密模型可留空）'} />{config.has_key && <Checkbox className="ai-clear-key" checked={clearKey} onChange={e => { clearModels(); setClearKey(e.target.checked); setDirty(true); }}>清除已保存密钥</Checkbox>}</Form.Item>
              <div className="ai-model-fetch"><Button block icon={<ReloadOutlined />} loading={modelsLoading || working === 'models'} disabled={busy || !config.base_url.trim()} onClick={() => void action('models', async () => { await persist(); await loadModels(); })}>{modelsLoaded ? '刷新模型列表' : '保存并获取模型列表'}</Button><div className="ai-small-note">仅获取平台模型目录，不发送候选人资料。已保存连接下次打开时会自动读取列表。</div></div>
              <Form.Item label="选择模型 · Model ID" extra="选择后自动保存。列表由平台提供，读取截图需选择支持图片的模型。">
                {manualModel ? <Input aria-label="手动模型 ID" value={config.model} onChange={e => edit('model', e.target.value)} placeholder="填写平台提供的模型 ID，随后保存设置" /> : <Select aria-label="选择 AI 模型" showSearch optionFilterProp="label" loading={modelsLoading} value={config.model || undefined} placeholder={modelsLoading ? '正在获取模型…' : '获取列表后选择模型'} options={[...models.map(m => ({ value: m.id, label: m.id })), ...(config.model && !models.some(m => m.id === config.model) ? [{ value: config.model, label: `${config.model}（当前配置${modelsLoaded ? '，列表未返回' : ''}）` }] : [])]} notFoundContent={modelsLoaded ? '平台未返回可用模型' : '请先获取模型列表'} onChange={value => { edit('model', value); void action('model', async () => { await persist({ model: value }); toast.success('模型选择已保存'); }); }} />}
                <div className="ai-model-tools"><span>{modelsLoading ? '正在连接平台…' : modelsLoaded ? `已获取 ${models.length} 个模型` : '支持搜索模型名称'}</span><Button type="link" size="small" onClick={() => setManualModel(value => !value)}>{manualModel ? '返回下拉选择' : '手动填写模型'}</Button></div>
                {modelsError && <Alert className="ai-model-error" type="warning" showIcon message={modelsError} />}
                {modelsLoaded && !models.length && <div className="ai-small-note">当前密钥未返回可用模型，可确认平台权限或手动填写。</div>}
              </Form.Item>
              <Collapse ghost className="ai-advanced" items={[{ key: 'advanced', label: '高级参数', children: <>
                <Form.Item label="发送会话标识" extra="平台提示 MissingSessionID 时开启。自动生成 x-opencode-session，每人使用独立标识；更换服务地址后默认关闭。"><Switch aria-label="发送会话标识" checked={config.send_session_id ?? false} onChange={v => edit('send_session_id', v)} /></Form.Item>
                <Form.Item label="温度 · Temperature" extra="留空采用模型默认值；部分推理模型不支持自定义温度。"><InputNumber min={0} max={2} step={0.1} value={config.temperature} onChange={v => edit('temperature', v)} placeholder="模型默认" /></Form.Item>
                <Form.Item label="最大输出 Token"><InputNumber min={128} max={65536} step={512} value={config.max_tokens} onChange={v => edit('max_tokens', v ?? 4096)} /></Form.Item>
                <Form.Item label="Token 参数名" extra="多数旧版兼容接口使用 max_tokens；按服务商文档选择。"><Select value={config.token_parameter} onChange={v => edit('token_parameter', v)} options={[{ value: 'max_completion_tokens', label: 'max_completion_tokens' }, { value: 'max_tokens', label: 'max_tokens' }]} /></Form.Item>
                <Form.Item label="单人请求超时（秒）"><InputNumber min={15} max={600} value={config.timeout_seconds} onChange={v => edit('timeout_seconds', v ?? 120)} /></Form.Item>
              </> }]} />
              <Button block icon={<ApiOutlined />} disabled={busy || !config.model.trim()} loading={working === 'test'} onClick={() => void action('test', async () => { await persist(); const r = await aiRequest<{ elapsed_seconds: number }>('/test', 'POST'); setConnection(`连接成功 · ${r.elapsed_seconds} 秒`); })}>保存并测试连接</Button>
              <div className="ai-small-note">测试只发送简短文字，不包含候选人资料；会产生少量 API 用量。图片能力以实际分析为准。</div>
              {connection && <div className="ai-connected"><CheckCircleOutlined /> {connection}</div>}
            </Form>
          </section>
          <div className="ai-main">
            <section className="ai-card">
              <div className="ai-card-title"><span className="ai-step">02</span><div><h2>告诉 AI 如何分析</h2><p>每次分析都会向模型发送这份提示词和对应人选的本地资料。</p></div><Tag bordered={false}>{dirty ? '有未保存修改' : '已保存'}</Tag></div>
              <Input.TextArea aria-label="AI 分析提示词" className="ai-prompt" value={config.prompt} onChange={e => edit('prompt', e.target.value)} disabled={busy} autoSize={{ minRows: 7, maxRows: 16 }} maxLength={20000} showCount placeholder="写下分析目的、岗位要求、评价维度，以及你希望的输出格式…" />
              <div className="ai-prompt-footer"><span>可写入分析维度、证据要求、输出格式。</span><Button icon={<SaveOutlined />} disabled={busy} loading={working === 'save'} onClick={() => void action('save', async () => { await persist(); toast.success('配置与提示词已保存'); })}>保存设置与提示词</Button></div>
            </section>
            <section className="ai-card">
              <div className="ai-card-title"><span className="ai-step">03</span><div><h2>选择本地资料</h2><p>仅发送勾选的人选，每次最多 20 人，逐人分析。</p></div><Tooltip title="刷新本地数据库列表"><Button aria-label="刷新本地资料" icon={<ReloadOutlined />} disabled={dataLoading || busy} onClick={() => setRefresh(x => x + 1)} /></Tooltip></div>
              <div className="ai-data-controls"><Select aria-label="资料来源" value={source} disabled={busy} onChange={value => { setSource(value); setJobId(''); setSelected([]); setQuery(''); setIncludeImages(false); setCatalog({ jobs: [], candidates: [] }); }} options={[{ value: 'recommendations', label: '推荐牛人' }, { value: 'communications', label: '沟通候选人' }]} /><Select aria-label="分析岗位" showSearch optionFilterProp="label" value={jobId} disabled={busy || dataLoading} onChange={value => { setJobId(value); setSelected([]); }} options={[{ value: '', label: '全部本地岗位' }, ...catalog.jobs.map(j => ({ value: j.id, label: `${j.label}（${j.count}）` }))]} /></div>
              <Input.TextArea aria-label="本次岗位补充要求" value={jobContext} disabled={busy} onChange={e => setJobContext(e.target.value)} autoSize={{ minRows: 2, maxRows: 5 }} maxLength={10000} placeholder="本次岗位补充要求（可选）：粘贴 JD、关键技能或项目要求，让分析更有依据。" />
              <div className="ai-table-toolbar"><Input.Search aria-label="搜索待分析人选" allowClear placeholder="搜索姓名、基本信息或岗位" value={query} onChange={e => setQuery(e.target.value)} /><Button type="text" disabled={busy || dataLoading} onClick={() => setSelected(visible.slice(0, 20).map(c => c.id))}>选择前 20 人</Button><Button type="text" disabled={busy || !selected.length} onClick={() => setSelected([])}>清空</Button></div>
              <Table size="small" rowKey="id" className="ai-people-table" scroll={{ x: 580 }} loading={dataLoading} dataSource={visible} pagination={{ pageSize: 5, showSizeChanger: false, hideOnSinglePage: true, showTotal: total => `${total} 人` }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无本地资料，请先在对应页面读取候选人" /> }} rowSelection={{ selectedRowKeys: selected, onChange: ids => { if (ids.length > 20) { toast.info('每次最多选择 20 人'); return; } setSelected(ids.map(String)); }, getCheckboxProps: row => ({ disabled: busy || (selected.length >= 20 && !selected.includes(row.id)) }) }} columns={[
                { title: '候选人', key: 'person', render: (_, row) => <div><strong>{row.name}</strong><div className="ai-person-info">{row.summary}</div></div> },
                { title: '来源岗位', dataIndex: 'job', ellipsis: true, width: '35%' },
                { title: '简历资料', key: 'resume', width: 106, render: (_, row) => <Tag bordered={false} color={row.has_image ? 'green' : 'default'}>{row.has_image ? '截图已保存' : source === 'recommendations' ? '仅列表文字' : '本地文字'}</Tag> },
              ]} />
              {source === 'recommendations' && <div className="ai-image-option"><Switch checked={includeImages} disabled={busy} onChange={setIncludeImages} /><div><strong>附带在线简历截图</strong><p>需要模型支持图片。未保存截图的人选仅发送文字资料。</p></div></div>}
              <div className="ai-send-summary"><DatabaseOutlined /><div>本次发送 <strong>{selected.length}</strong> 人的文字资料{imageCount > 0 && <>及 <strong>{imageCount}</strong> 张简历截图</>}<small>发往 {config.base_url || '尚未填写 API 地址'} · 结果供人工参考</small></div></div>
              <div className="ai-run-actions"><Button icon={<EyeOutlined />} disabled={busy || !selected.length || dataLoading} loading={working === 'preview'} onClick={() => void action('preview', async () => { const value = await aiRequest<{ items: AIItem[] }>('/preview', 'POST', selection); setPreview(value.items); })}>预览发送资料</Button><Button type="primary" icon={<PlayCircleOutlined />} disabled={busy || isRunning || !selected.length || !config.model.trim() || !config.prompt.trim() || dataLoading} loading={working === 'start'} onClick={() => void action('start', async () => { await persist(); const run = await aiRequest<AIRun>('/runs', 'POST', selection); setCurrent(run); currentId.current = run.id; setResultId(''); setHistory(rows => [run, ...rows]); toast.success('AI 分析已开始，可切换页面，进度会持续保留'); })}>保存并开始分析</Button></div>
            </section>
          </div>
        </div>
        <section className="ai-card ai-results">
          <div className="ai-card-title"><span className="ai-step"><HistoryOutlined /></span><div><h2>分析记录</h2><p>保存每次的提示词、资料快照、模型和结果，可随时回看。</p></div>{history.length > 0 && <Select aria-label="选择历史分析任务" value={current?.id} className="ai-history-select" onChange={id => { setResultId(''); void showRun(id).catch(e => setError(errorText(e))); }} options={history.map(r => ({ value: r.id, label: `${timeText(r.created_at)} · ${r.total} 人 · ${statuses[r.status]}` }))} />}</div>
          {pollError && <Alert message={pollError} type="warning" showIcon />}
          {current ? <>
            <div className="ai-run-meta"><Tag color={running(current) ? 'processing' : current.status === 'success' ? 'green' : 'orange'}>{statuses[current.status]}</Tag><span>{current.model} · 已处理 {current.completed}/{current.total} · 失败 {current.failed}</span><span>{timeText(current.created_at)}</span></div>
            {running(current) && <Progress percent={Math.round(current.completed / current.total * 100)} status="active" />}
            {current.error && <Alert type="warning" message={current.error} showIcon />}
            <div className="ai-result-layout"><div className="ai-result-people">{current.items?.map(i => <button key={i.candidate_id} aria-pressed={item?.candidate_id === i.candidate_id} onClick={() => setResultId(i.candidate_id)}><span>{i.name}</span><small>{statuses[i.status] ?? i.status}</small></button>)}</div><div className="ai-result-content">{item && <><div className="ai-answer-heading"><h3>{item.name}</h3><Space><span>{item.elapsed_seconds !== null && `${item.elapsed_seconds} 秒`}{item.usage.total_tokens ? ` · ${item.usage.total_tokens} Tokens` : ''}</span>{item.output && <Button size="small" onClick={() => void navigator.clipboard.writeText(item.output).then(() => toast.success('已复制分析结果')).catch(() => toast.error('复制失败，请手动选中文本复制'))}>复制结果</Button>}</Space></div>{item.error && <Alert message={item.error} type="warning" showIcon />}{item.truncated && <Alert message="输出达到 Token 上限，内容可能不完整。可提高上限后重新分析。" type="warning" />}{item.output ? <div className="ai-answer">{item.output}</div> : !item.error && <div className="ai-answer-pending">{item.status === 'running' ? <><Spin size="small" /> 正在阅读资料并生成分析…</> : '等待分析此人'}</div>}<Collapse ghost items={[{ key: 'input', label: '查看本次提示词与资料依据', children: <><h4>实际使用的提示词</h4><pre className="ai-json">{current.config?.prompt}</pre><h4>本地文字快照</h4><pre className="ai-json">{JSON.stringify(item.data, null, 2)}</pre>{item.image_id && <p>本次附带了该候选人的在线简历截图。</p>}</> }]} /></>}</div></div>
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分析记录，配置模型并选择本地资料即可开始" />}
        </section>
      </>}
      <Modal title="发送资料预览" open={preview !== null} onCancel={() => setPreview(null)} footer={<Button onClick={() => setPreview(null)}>关闭预览</Button>} width={820}>
        <p className="ai-small-note">以下为本地资料，不会在预览时调用模型。正式运行时使用已保存的提示词，并读取当时的本地资料。</p>
        <Collapse items={preview?.map(i => ({ key: i.candidate_id, label: `${i.name}${i.image_id ? ' · 含在线简历截图' : ' · 文字资料'}`, children: <><pre className="ai-json">{JSON.stringify(i.data, null, 2)}</pre>{i.image_id && <Image width={180} src={aiImage(i.image_id)} />}</> }))} />
      </Modal>
    </div>
  </>;
}
