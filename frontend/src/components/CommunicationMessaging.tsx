import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Input, Modal, Select, Space, Tag, Tooltip } from 'antd';
import { CloseOutlined, PlusOutlined } from '@ant-design/icons';
import { createMessageTemplate, deleteMessageTemplate, fetchConversation, fetchMessageTemplates, sendConversation, updateMessageTemplate, type ConversationMessage, type LocalCandidate, type MessageTemplate } from '../api';

const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败';

export function ConversationPanel({ candidate, jobId }: { candidate: LocalCandidate; jobId: string }) {
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  const refresh = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    try { setMessages((await fetchConversation(candidate.id, jobId)).messages); setError(''); }
    catch (reason) { setError(errorText(reason)); }
    finally { inFlight.current = false; setLoading(false); }
  };
  useEffect(() => { setMessages([]); setError(''); void refresh(); const timer = window.setInterval(() => void refresh(), 10000); return () => window.clearInterval(timer); }, [candidate.id, jobId]);
  const send = () => {
    const content = text.trim();
    if (!content || sending || inFlight.current) return;
    Modal.confirm({ title: `向 ${candidate.name} 发送消息？`, content, okText: '确认发送', cancelText: '取消', onOk: async () => {
      inFlight.current = true; setSending(true); setError('');
      const id = requestId.current ?? crypto.randomUUID(); requestId.current = id;
      try {
        const result = await sendConversation(candidate.id, jobId, content, id);
        if (result.status !== 'success') throw new Error(result.error || `发送状态：${result.status}`);
        setMessages(result.messages); setText(''); requestId.current = null;
      } catch (reason) { setError(`${errorText(reason)}。发送结果不明确时请先刷新聊天记录，不要重复点击。`); }
      finally { inFlight.current = false; setSending(false); }
    } });
  };
  return <section className="communication-messaging"><Space><strong>BOSS 对话</strong><Button size="small" loading={loading} disabled={sending} onClick={() => void refresh()}>刷新</Button><span className="muted">每 10 秒检查当前会话；打开会话可能标记已读</span></Space>
    {error && <Alert type="warning" showIcon message={error} style={{ marginTop: 12 }} />}
    <div className="communication-messages">{messages.length ? messages.map((item, index) => <div key={index} className={`communication-message ${item.from}`}><Tag>{item.from === 'myself' ? '我' : item.from === 'friend' ? candidate.name : '系统'}</Tag><span>{item.text}</span><small>{item.time}</small></div>) : <p className="muted">暂无已加载的聊天文字</p>}</div>
    <Input.TextArea value={text} onChange={event => { setText(event.target.value); requestId.current = null; }} maxLength={2000} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="输入消息；发送前会再次核对会话" />
    <Button type="primary" disabled={!text.trim() || sending || loading} loading={sending} onClick={send} style={{ marginTop: 8 }}>确认后发送</Button>
  </section>;
}

export function BulkMessageModal({ open, onClose, rows, jobId }: { open: boolean; onClose: () => void; rows: LocalCandidate[]; jobId: string }) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<string | undefined>();
  const [text, setText] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [newText, setNewText] = useState('');
  const [error, setError] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; status: string; error: string }[]>([]);
  const [running, setRunning] = useState(false);
  const [saving, setSaving] = useState(false);
  const stop = useRef(false);
  const selected = templates.find(item => item.id === selectedTemplate);
  const changed = !!selected && text.trim() !== selected.content;
  const invalidText = !text.trim() || /[\r\n]/.test(text);
  useEffect(() => { if (open) { setResults([]); setError(''); setText(''); setSelectedTemplate(undefined); void fetchMessageTemplates().then(setTemplates).catch(reason => setError(errorText(reason))); } }, [open]);
  const createTemplate = async () => {
    if (!newName.trim() || !newText.trim() || saving) return;
    setSaving(true);
    try {
      const saved = await createMessageTemplate(newName.trim(), newText.trim());
      setTemplates(items => [saved, ...items]);
      setSelectedTemplate(saved.id); setText(saved.content);
      setCreating(false); setNewName(''); setNewText(''); setError('');
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  const saveTemplate = async () => {
    if (!selected || !changed || invalidText || saving) return;
    setSaving(true);
    try {
      const saved = await updateMessageTemplate(selected.id, text.trim());
      setTemplates(items => items.map(item => item.id === saved.id ? saved : item));
      setText(saved.content); setError('');
    } catch (reason) { setError(errorText(reason)); }
    finally { setSaving(false); }
  };
  const removeTemplate = (id: string) => {
    const template = templates.find(item => item.id === id);
    if (!template) return;
    Modal.confirm({ title: `删除话术「${template.name}」？`, content: '仅删除保存的模板，当前输入框中的文字会保留。', okText: '删除', okButtonProps: { danger: true }, cancelText: '取消', onOk: async () => {
      try { await deleteMessageTemplate(id); setTemplates(items => items.filter(item => item.id !== id)); if (selectedTemplate === id) setSelectedTemplate(undefined); setError(''); }
      catch (reason) { setError(errorText(reason)); }
    } });
  };
  const start = async () => {
    if (invalidText || running || saving || !rows.length || results.length) return;
    stop.current = false; setRunning(true); setResults([]); setError('');
    const requestId = crypto.randomUUID();
    for (const row of rows) {
      if (stop.current) break;
      try {
        const result = await sendConversation(row.id, jobId, text.trim(), requestId);
        setResults(items => [...items, { id: row.id, name: row.name, status: result.status, error: result.error }]);
        if (result.status === 'executing' || /待核实|操作频繁|安全验证|限制|已点击发送/.test(result.error)) stop.current = true;
      } catch (reason) {
        stop.current = true;
        setResults(items => [...items, { id: row.id, name: row.name, status: 'unknown', error: `${errorText(reason)}；已停止后续发送，请核对 BOSS 聊天后再决定是否重发` }]);
      }
    }
    setRunning(false);
  };
  const send = () => {
    if (changed) {
      Modal.confirm({
        title: '当前话术有未保存的修改',
        content: '如需保留修改，请先取消并点击“保存”。继续发送只会按当前文字发送，本次修改不会保存到模板。',
        okText: '仅本次发送', cancelText: '返回保存',
        onOk: () => void start(),
      });
    } else void start();
  };
  return <><Modal title={`批量发送固定话术 · ${rows.length} 人`} open={open} width={700} onCancel={onClose} closable={!running} maskClosable={false} footer={<Space>{running ? <Button danger onClick={() => { stop.current = true; }}>处理完当前人后停止</Button> : <><Button disabled={!selected || !changed || invalidText || saving || !!results.length} loading={saving} onClick={() => void saveTemplate()}>保存</Button><Button type="primary" disabled={!rows.length || invalidText || saving || !!results.length} onClick={send}>发送</Button></>}</Space>}>
    <p className="muted">仅向当前岗位已勾选的沟通候选人发送。从聊天列表顶部按姓名和岗位查找，必要时对照基本信息；每人最多检查 250 条或 35 秒，失败不自动重试。打开会话可能标记已读。</p>
    <div className="communication-batch-names">{rows.map(row => <Tag key={row.id}>{row.name}</Tag>)}</div>
    {error && <Alert type="warning" showIcon message={error} style={{ margin: '12px 0' }} />}
    <div className="communication-template-toolbar"><Select placeholder="选择已保存话术" className="communication-template-select" disabled={running} value={selectedTemplate} options={templates.map(t => ({ value: t.id, label: t.name }))} onChange={id => { setSelectedTemplate(id); setText(templates.find(t => t.id === id)?.content ?? ''); }} optionRender={option => <div className="communication-template-option"><span>{option.label}</span><Button type="text" size="small" danger aria-label={`删除话术 ${option.label}`} icon={<CloseOutlined />} onMouseDown={event => event.preventDefault()} onClick={event => { event.stopPropagation(); removeTemplate(String(option.value)); }} /></div>} /><Tooltip title="新建话术"><Button icon={<PlusOutlined />} disabled={running} onClick={() => { setNewName(''); setNewText(''); setCreating(true); }} aria-label="新建话术" /></Tooltip></div>
    <Input.TextArea value={text} onChange={event => setText(event.target.value)} maxLength={2000} autoSize={{ minRows: 4, maxRows: 8 }} disabled={running} placeholder="选择已有话术后可修改内容" />
    {/[\r\n]/.test(text) && <p className="communication-text-hint">当前仅支持单条文字消息，请将换行改为空格。</p>}
    {changed && <p className="communication-text-hint">当前修改尚未保存到「{selected?.name}」。</p>}
    {(running || results.length > 0) && <div className="communication-batch-results"><strong>{running ? '发送中' : stop.current ? '已停止' : '本次完成'} · {results.length}/{rows.length}</strong>{results.map(item => <p key={item.id}>{item.name}：{item.status === 'success' ? '已发送' : item.status === 'failed' ? '失败' : '待核实'}{item.error ? ` · ${item.error}` : ''}</p>)}</div>}
  </Modal><Modal title="新建话术" open={creating} onCancel={() => setCreating(false)} destroyOnClose maskClosable={false} footer={<Space><Button onClick={() => setCreating(false)}>取消</Button><Button type="primary" loading={saving} disabled={!newName.trim() || !newText.trim() || /[\r\n]/.test(newText)} onClick={() => void createTemplate()}>保存新话术</Button></Space>}><Space direction="vertical" style={{ width: '100%' }} size="middle">{error && <Alert type="warning" showIcon message={error} />}<label>话术名称<Input value={newName} onChange={event => setNewName(event.target.value)} maxLength={128} placeholder="例如：索取简历" /></label><label>话术内容<Input.TextArea value={newText} onChange={event => setNewText(event.target.value)} maxLength={2000} autoSize={{ minRows: 4, maxRows: 8 }} placeholder="输入要发送给候选人的文字" /></label>{/[\r\n]/.test(newText) && <span className="communication-text-hint">请将换行改为空格。</span>}</Space></Modal></>;
}
