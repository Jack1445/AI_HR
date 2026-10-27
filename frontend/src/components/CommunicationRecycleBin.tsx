import { useState } from 'react';
import { Alert, Button, Empty, Input, Modal, Table, message } from 'antd';
import { DeleteOutlined, UndoOutlined } from '@ant-design/icons';
import { fetchCommunicationTrash, restoreCommunication, type CommunicationTrash } from '../tableApi';

export function CommunicationRecycleBin({ disabled }: { disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<CommunicationTrash[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [api, context] = message.useMessage();
  const load = async () => { setBusy(true); setError(''); try { setRows(await fetchCommunicationTrash()); } catch (e) { setError(String(e)); } finally { setBusy(false); } };
  return <>{context}<Button size="small" icon={<DeleteOutlined />} disabled={disabled} onClick={() => { setOpen(true); setQuery(''); void load(); }}>回收站</Button><Modal title="沟通候选人回收站" open={open} onCancel={() => setOpen(false)} width={720} footer={<Button onClick={() => setOpen(false)}>关闭</Button>}>
    <p className="recycle-bin-notice">删除的人选不会重新同步。点击“允许重新同步”只取消排除，下次手动同步时可重新入库；原本的备注、字段值和简历不会恢复。当前来源按姓名与来源岗位联合识别。</p>
    <Input aria-label="搜索沟通回收站" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索姓名或来源岗位" allowClear />
    {error && <Alert type="error" message={error} action={<Button onClick={() => void load()}>重试</Button>} />}
    <Table<CommunicationTrash> rowKey="id" loading={busy} dataSource={rows.filter(r => `${r.name} ${r.source_job}`.includes(query.trim()))} pagination={{ pageSize: 8, showSizeChanger: false }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="回收站为空" /> }} columns={[{ title: '姓名', dataIndex: 'name' }, { title: '来源岗位', dataIndex: 'source_job' }, { title: '', key: 'restore', width: 150, render: (_, row) => <Button type="link" icon={<UndoOutlined />} disabled={busy || disabled} onClick={async () => { setBusy(true); setError(''); try { await restoreCommunication(row.id); setRows(items => items.filter(i => i.id !== row.id)); api.success('已允许下次手动同步重新入库'); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}>允许重新同步</Button> }]} />
  </Modal></>;
}
