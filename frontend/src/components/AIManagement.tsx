import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Collapse, Empty, Form, Input, InputNumber, Progress, Select, Space, Spin, Switch, Tag, message } from 'antd';
import { ApiOutlined, CheckCircleOutlined, HistoryOutlined, ReloadOutlined, RobotOutlined, SafetyCertificateOutlined, SaveOutlined } from '@ant-design/icons';
import { aiRequest, type AIConfig, type AIRun, type AIModelList, type AIJobPrompt } from '../aiApi';
import { fetchRecommendationJobs, type RecommendationJob } from '../api';
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
  const [promptJobId, setPromptJobId] = useState('');
  const [promptJobs, setPromptJobs] = useState<RecommendationJob[]>([]);
  const [promptText, setPromptText] = useState('');
  const [scoreText, setScoreText] = useState('');
  const [jobJd, setJobJd] = useState('');
  const [promptCustom, setPromptCustom] = useState(false);
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptLoading, setPromptLoading] = useState(false);
  const [promptRefresh, setPromptRefresh] = useState(0);
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [models, setModels] = useState<{ id: string }[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [modelsError, setModelsError] = useState('');
  const [manualModel, setManualModel] = useState(false);
  const modelVersion = useRef(0);
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
    const refreshSavedPrompt = () => {
      if (!dirty && initialized.current) void aiRequest<AIConfig>('/config').then(setConfig).catch(() => {});
    };
    window.addEventListener('ai-config-saved', refreshSavedPrompt);
    return () => window.removeEventListener('ai-config-saved', refreshSavedPrompt);
  }, [dirty]);
  useEffect(() => {
    const refresh = () => setPromptRefresh(value => value + 1);
    window.addEventListener('ai-prompt-saved', refresh);
    return () => window.removeEventListener('ai-prompt-saved', refresh);
  }, []);
  useEffect(() => {
    if (!active || !config) return;
    const controller = new AbortController();
    void fetchRecommendationJobs(controller.signal).then(value => { if (!controller.signal.aborted) setPromptJobs(value.jobs); })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); });
    return () => controller.abort();
  }, [active, !!config]);
  useEffect(() => {
    if (!config || promptDirty) return;
    setPromptText(config.prompt);
    if (!promptJobId) { setScoreText(''); setJobJd(''); setPromptCustom(false); setPromptLoading(false); return; }
    const controller = new AbortController();
    setPromptLoading(true); setScoreText(''); setJobJd(''); setPromptCustom(false);
    void aiRequest<AIJobPrompt>(`/prompts/${encodeURIComponent(promptJobId)}`, 'GET', undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) { setScoreText(value.prompt); setJobJd(value.jd); setPromptCustom(value.custom); } })
      .catch(e => { if (!controller.signal.aborted) setError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setPromptLoading(false); });
    return () => controller.abort();
  }, [promptJobId, config?.prompt, promptDirty, promptRefresh]);
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
  async function savePrompt() {
    if (!promptText.trim()) throw new Error('请先填写提示词');
    await persist({ prompt: promptText });
    if (promptJobId) {
      const saved = await aiRequest<AIJobPrompt>(`/prompts/${encodeURIComponent(promptJobId)}`, 'PUT', { ...(scoreText.trim() ? { prompt: scoreText } : {}), jd: jobJd });
      setScoreText(saved.prompt); setJobJd(saved.jd); setPromptCustom(saved.custom);
    }
    setPromptDirty(false);
    window.dispatchEvent(new Event('ai-prompt-saved'));
  }
  function choosePromptJob(next: string) {
    if (promptDirty) { toast.warning('请先保存当前提示词，再切换岗位'); return false; }
    setPromptJobId(next);
    return true;
  }
  async function action(kind: string, operation: () => Promise<void>) {
    if (working) return;
    setWorking(kind); setError('');
    try { await operation(); } catch (e) { setError(errorText(e)); } finally { setWorking(''); }
  }
  const item = current?.items?.find(i => i.candidate_id === resultId) ?? current?.items?.[0];

  return <>{context}
    {!active && task && <div className="workspace-task-progress" role="status"><div className="workspace-task-heading"><strong><RobotOutlined /> AI 分析正在后台进行 · {task.completed}/{task.total} 人</strong><Button type="link" onClick={onOpen}>查看 AI 任务</Button></div><Progress percent={Math.round(task.completed / task.total * 100)} size="small" showInfo={false} /></div>}
    <div hidden={!active} className="ai-page">
      <div className="ai-hero"><div><div className="eyebrow">YOUR LOCAL TALENT, WITH AI</div><h1><RobotOutlined /> AI 管理</h1><p>配置模型、岗位要求和打分标准；在推荐牛人页面发起评估。</p></div><div className="ai-mode"><SafetyCertificateOutlined /><span>结果保存到本地</span></div></div>
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
                <Form.Item label="同时评估人数" extra="允许 1–10 人并行；默认 3 人。受模型平台限流影响，人数越高越可能遇到请求受限。"><InputNumber aria-label="同时评估人数" min={1} max={10} step={1} precision={0} value={config.max_concurrency} onChange={v => edit('max_concurrency', v ?? 3)} /></Form.Item>
              </> }]} />
              <Button block icon={<ApiOutlined />} disabled={busy || !config.model.trim()} loading={working === 'test'} onClick={() => void action('test', async () => { await persist(); const r = await aiRequest<{ elapsed_seconds: number }>('/test', 'POST'); setConnection(`连接成功 · ${r.elapsed_seconds} 秒`); })}>保存并测试连接</Button>
              <div className="ai-small-note">测试只发送简短文字，不包含候选人资料；会产生少量 API 用量。图片能力以实际分析为准。</div>
              {connection && <div className="ai-connected"><CheckCircleOutlined /> {connection}</div>}
            </Form>
          </section>
          <div className="ai-main">
            <section className="ai-card">
              <div className="ai-card-title"><span className="ai-step">02</span><div><h2>告诉 AI 如何分析</h2><p>通用提示词与岗位 JD、打分标准会一起用于评估。</p></div><Tag bordered={false}>{promptDirty || dirty ? '有未保存修改' : '已保存'}</Tag></div>
              <label className="recommendation-ai-label">通用提示词 · 所有评估共用</label>
              <Input.TextArea aria-label="通用提示词" className="ai-prompt" value={promptText} onChange={e => { setPromptText(e.target.value); setPromptDirty(true); }} disabled={busy} autoSize={{ minRows: 7, maxRows: 16 }} maxLength={20000} showCount placeholder="写下统一的分析要求和回答格式…" />
              <div className="ai-prompt-job"><span>岗位 JD 与打分标准</span><Select aria-label="选择打分标准岗位" showSearch optionFilterProp="label" value={promptJobId} disabled={busy || promptLoading} onChange={choosePromptJob} options={[{ value: '', label: '请选择岗位' }, ...promptJobs.map(job => ({ value: job.id, label: `${job.label}${job.available ? '' : '（历史岗位）'}` }))]} /><small>岗位暂时下线时配置会保留，再次出现时自动恢复。</small></div>
              {promptJobId && <><label className="recommendation-ai-label">岗位 JD（可选）</label><Input.TextArea aria-label="岗位 JD" value={jobJd} onChange={e => { setJobJd(e.target.value); setPromptDirty(true); }} disabled={busy || promptLoading} autoSize={{ minRows: 3, maxRows: 9 }} maxLength={10000} placeholder="填写该岗位的职责、要求或完整 JD" /><label className="recommendation-ai-label">打分标准 · 此岗位专属</label><Input.TextArea aria-label="岗位打分标准" value={scoreText} onChange={e => { setScoreText(e.target.value); setPromptDirty(true); }} disabled={busy || promptLoading} autoSize={{ minRows: 4, maxRows: 12 }} maxLength={20000} placeholder="填写这个岗位如何判断契合程度；未填写则只使用通用提示词和 JD" /></>}
              <div className="ai-prompt-footer"><span>通用提示词、岗位 JD 和打分标准分别保存，评估时组合发送。</span><Space><Button disabled={busy} onClick={() => void action('open-storage', async () => { await aiRequest('/prompts/open-storage', 'POST'); })}>打开存储位置</Button>{promptJobId && promptCustom && <Button disabled={busy || promptLoading || promptDirty} onClick={() => void action('reset-prompt', async () => { const saved = await aiRequest<AIJobPrompt>(`/prompts/${encodeURIComponent(promptJobId)}`, 'DELETE'); setScoreText(saved.prompt); setPromptCustom(false); window.dispatchEvent(new Event('ai-prompt-saved')); toast.success('已清除此岗位打分标准'); })}>清除打分标准</Button>}<Button icon={<SaveOutlined />} disabled={busy || promptLoading || !promptText.trim()} loading={working === 'save'} onClick={() => void action('save', async () => { await savePrompt(); toast.success('提示词与岗位配置已保存'); })}>保存设置</Button></Space></div>
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
          </> : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="还没有分析记录；请到推荐牛人页面选择人选并发起评估" />}
        </section>
      </>}
    </div>
  </>;
}
