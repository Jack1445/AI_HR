import { useState } from 'react';
import { Button, Checkbox, Input, InputNumber, Select, Space, Tag } from 'antd';
import { CheckOutlined, CloseOutlined } from '@ant-design/icons';
import { cellText, type CellValue } from '../tableModel';
import type { FieldInfo } from './TableSettings';

export function CellInput({ field, value, onChange, onEnter }: { field: FieldInfo; value: CellValue; onChange: (value: CellValue) => void; onEnter?: () => void }) {
  const label = `编辑${field.name}`;
  if (field.type === 'checkbox') return <Checkbox aria-label={label} checked={value === true} onChange={e => onChange(e.target.checked)}>已选中</Checkbox>;
  if (field.type === 'number') return <InputNumber autoFocus aria-label={label} value={typeof value === 'number' ? value : null} onChange={onChange} onPressEnter={onEnter} style={{ width: '100%' }} />;
  if (field.type === 'select' || field.type === 'multi') return <Select autoFocus aria-label={label} mode={field.type === 'multi' ? field.id === 'tags' ? 'tags' : 'multiple' : undefined} allowClear value={value ?? undefined} options={(field.options ?? []).map(v => ({ label: v, value: v }))} onChange={v => onChange(v ?? null)} style={{ width: '100%' }} />;
  if (field.type === 'date') return <Input autoFocus aria-label={label} type="date" value={typeof value === 'string' ? value : ''} onChange={e => onChange(e.target.value || null)} onPressEnter={onEnter} />;
  if (field.type === 'multiline') return <Input.TextArea autoFocus aria-label={label} maxLength={10000} autoSize={{ minRows: 2, maxRows: 6 }} value={cellText(value)} onChange={e => onChange(e.target.value)} />;
  return <Input autoFocus aria-label={label} maxLength={10000} value={cellText(value)} onChange={e => onChange(e.target.value)} onPressEnter={onEnter} />;
}

export function TableCellEditor({ field, value, disabled, save }: { field: FieldInfo; value: CellValue; disabled: boolean; save: (value: CellValue) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CellValue>(null);
  const [saving, setSaving] = useState(false);
  const submit = async () => { if (saving) return; setSaving(true); try { await save(draft === '' ? null : draft); setEditing(false); } catch { /* Parent displays the error; keep the draft for retry. */ } finally { setSaving(false); } };
  if (!editing) return <button className="editable-table-cell" disabled={disabled} title={`点击编辑${field.name}`} aria-label={`编辑${field.name}：${cellText(value) || '空'}`} onClick={() => { setDraft(value); setEditing(true); }}>{field.type === 'checkbox' ? <Checkbox checked={value === true} tabIndex={-1} style={{ pointerEvents: 'none' }} /> : Array.isArray(value) ? <Space size={[0, 3]} wrap>{value.map(v => <Tag key={v}>{v}</Tag>)}</Space> : cellText(value) || <span className="cell-placeholder">—</span>}</button>;
  return <div className="inline-cell-editor" onKeyDown={e => { if (e.key === 'Escape' && !saving) setEditing(false); }}><CellInput field={field} value={draft} onChange={setDraft} onEnter={() => void submit()} /><Space><Button aria-label={`保存${field.name}`} icon={<CheckOutlined />} size="small" type="primary" loading={saving} onClick={() => void submit()} /><Button aria-label="取消编辑" icon={<CloseOutlined />} size="small" disabled={saving} onClick={() => setEditing(false)} /></Space></div>;
}
