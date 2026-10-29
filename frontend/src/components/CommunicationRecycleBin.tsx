import { useState } from 'react';
import { Alert, Button, Checkbox, Empty, Input, Modal, Progress, Space, Table, Tag, message } from 'antd';
import { DeleteOutlined, SearchOutlined, UndoOutlined } from '@ant-design/icons';
import { fetchCommunicationTrash, restoreCommunication, type CommunicationTrash } from '../tableApi';
import { restoreRecycleRecords } from '../recycleBatch';

export function CommunicationRecycleBin({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CommunicationTrash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState<string[]>([]);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<{ completed: number; total: number } | null>(null);
  const [notice, setNotice] = useState('');
  const [api, context] = message.useMessage();
  const filteredRows = rows.filter(row => `${row.name} ${row.baseInfo} ${row.source_job ?? row.scope_label ?? ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const load = async () => {
    setBusy(true); setError(''); setNotice('');
    try { setRows(await fetchCommunicationTrash()); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const openRecycleBin = () => {
    setOpen(true); setQuery(''); setSelection([]); setRestoreProgress(null); setError(''); setNotice(''); void load();
  };
  const allowAgain = async (people: CommunicationTrash[]) => {
    if (disabled || busy || restoring || !people.length) return;
    setBusy(true); setRestoring(people.length === 1 ? people[0].id : 'batch'); setError(''); setNotice('');
    try {
      const result = await restoreRecycleRecords(people, async id => { await restoreCommunication(id); }, id => {
        setRows(items => items.filter(item => item.id !== id));
        setSelection(items => items.filter(item => item !== id));
      }, (completed, total) => setRestoreProgress({ completed, total }));
      if (result.restored) setNotice(`已允许 ${result.restored} 人重新读取。下次在 BOSS 遇到他们时可重新入库。`);
      if (result.failures.length) setError(`有 ${result.failures.length} 人未处理成功，仍保留在回收站并保持选中，可重试：${result.failures.join('；')}`);
      if (result.restored) api.success(`已允许 ${result.restored} 人重新读取`);
    } finally { setRestoring(null); setBusy(false); }
  };
  return <>{context}<Button size="small" icon={<DeleteOutlined />} disabled={disabled} onClick={openRecycleBin}>回收站{rows.length ? `（${rows.length}）` : ''}</Button><Modal title={<Space><DeleteOutlined /><span>人选共享回收站</span><Tag>{rows.length} 人</Tag></Space>} open={open} onCancel={() => { if (!restoring) setOpen(false); }} closable={!restoring} maskClosable={!restoring} width={840} footer={<Button disabled={!!restoring} onClick={() => setOpen(false)}>关闭</Button>}>
    <p className="recycle-bin-notice">两个页面共用这些排除记录。点击“允许重新读取”只取消排除；下次在 BOSS 遇到此人时才能重新入库，已删除的备注、字段值和简历不会恢复。</p>
    <Input prefix={<SearchOutlined />} aria-label="搜索沟通回收站" value={query} onChange={e => { setQuery(e.target.value); setSelection([]); }} placeholder="搜索姓名、基本信息或来源岗位" allowClear disabled={busy} />
    <div className="recycle-batch-toolbar"><Checkbox disabled={busy || !filteredRows.length} checked={!!filteredRows.length && filteredRows.every(row => selection.includes(row.id))} indeterminate={selection.length > 0 && !filteredRows.every(row => selection.includes(row.id))} onChange={event => setSelection(event.target.checked ? filteredRows.map(row => row.id) : [])}>{query.trim() ? '全选搜索结果' : '全选全部'}（{filteredRows.length} 人）</Checkbox><Space wrap><span className="muted">已选 {selection.length} 人 · 可跨页选择</span><Button type="primary" size="small" icon={<UndoOutlined />} loading={!!restoring} disabled={busy || !selection.length} onClick={() => void allowAgain(rows.filter(row => selection.includes(row.id)))}>批量允许重新读取</Button></Space></div>
    {restoreProgress && restoring && <Progress size="small" percent={Math.round(restoreProgress.completed / restoreProgress.total * 100)} format={() => `${restoreProgress.completed}/${restoreProgress.total}`} />}
    {notice && <Alert className="recycle-bin-feedback" type="success" showIcon message={notice} />}
    {error && <Alert className="recycle-bin-feedback" type="warning" showIcon message={error} action={<Button size="small" onClick={() => void load()}>重试</Button>} />}
    <Table<CommunicationTrash> rowKey="id" loading={busy && !restoring} dataSource={filteredRows} rowSelection={{ selectedRowKeys: selection, preserveSelectedRowKeys: true, onChange: keys => setSelection(keys.map(String)), getCheckboxProps: () => ({ disabled: busy }), columnWidth: 42 }} pagination={{ disabled: !!restoring, pageSize: 8, showSizeChanger: false, hideOnSinglePage: true }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query ? '没有匹配的回收站记录' : '回收站为空'} /> }} columns={[{ title: '姓名', dataIndex: 'name', width: 150 }, { title: '基本信息', dataIndex: 'baseInfo', width: 260, render: (value: string) => value || '—' }, { title: '排除范围', key: 'scope', render: (_: unknown, row: CommunicationTrash) => row.scope_label ?? row.source_job ?? '—' }, { title: '操作', key: 'restore', width: 150, render: (_: unknown, row: CommunicationTrash) => <Button type="link" size="small" icon={<UndoOutlined />} loading={restoring === row.id} disabled={busy || disabled} onClick={() => void allowAgain([row])}>允许重新读取</Button> }]} />
  </Modal></>;
}
