import { useEffect, useState } from 'react';
import { Button, Drawer, Input, Select, Space } from 'antd';
import { DeleteOutlined, PlusOutlined } from '@ant-design/icons';
import type { RecommendationReadCondition, RecommendationReadConditions } from '../api';

const emptyConditions = (): RecommendationReadConditions => ({ groups: [], conjunction: 'and' });
const newRule = (): RecommendationReadCondition => ({ field: 'highlights', op: 'contains', value: '' });
const fields = [
  { value: 'highlights', label: '标签' }, { value: 'baseInfo', label: '基本信息' },
  { value: 'name', label: '姓名' }, { value: 'expect', label: '期望职位' }, { value: 'salary', label: '期望薪资' },
];
const operations = [
  { value: 'contains', label: '包含' }, { value: 'not_contains', label: '不包含' },
  { value: 'eq', label: '等于' }, { value: 'neq', label: '不等于' },
  { value: 'empty', label: '为空' }, { value: 'not_empty', label: '不为空' },
];
const options = [{ value: 'and', label: '全部满足（且）' }, { value: 'or', label: '满足任一（或）' }];

export function loadRecommendationReadConditions(jobKey: string): RecommendationReadConditions {
  if (!jobKey) return emptyConditions();
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(`ai-hr-read-conditions:${jobKey}`) || 'null');
    if (value && typeof value === 'object' && 'groups' in value && Array.isArray(value.groups) && 'conjunction' in value && (value.conjunction === 'and' || value.conjunction === 'or')) {
      return value as RecommendationReadConditions;
    }
  } catch { /* Invalid local settings are ignored; a new configuration can be saved. */ }
  return emptyConditions();
}

export function RecommendationReadConditionsDrawer({ open, jobKey, jobLabel, disabled, onClose, onSave }: {
  open: boolean; jobKey: string; jobLabel: string; disabled: boolean;
  onClose: () => void; onSave: (conditions: RecommendationReadConditions) => void;
}) {
  const [draft, setDraft] = useState<RecommendationReadConditions>(emptyConditions);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setDraft(loadRecommendationReadConditions(jobKey)); setError(''); } }, [open, jobKey]);
  const changeGroup = (index: number, patch: Partial<RecommendationReadConditions['groups'][number]>) =>
    setDraft(current => ({ ...current, groups: current.groups.map((group, i) => i === index ? { ...group, ...patch } : group) }));
  const changeRule = (groupIndex: number, ruleIndex: number, patch: Partial<RecommendationReadCondition>) =>
    changeGroup(groupIndex, { filters: draft.groups[groupIndex].filters.map((rule, i) => i === ruleIndex ? { ...rule, ...patch } : rule) });
  const count = draft.groups.reduce((sum, group) => sum + group.filters.length, 0);
  const save = () => {
    if (draft.groups.some(group => group.filters.some(rule => !['empty', 'not_empty'].includes(rule.op) && !rule.value.trim()))) {
      setError('请填写筛选值；如需不设条件，请删除条件组。'); return;
    }
    window.localStorage.setItem(`ai-hr-read-conditions:${jobKey}`, JSON.stringify(draft));
    onSave(draft); onClose();
  };
  return <Drawer title="新增人选 · 读取条件" width={700} open={open} onClose={onClose} maskClosable={!disabled} closable={!disabled} footer={<div className="read-conditions-footer"><span>条件按当前岗位单独保存</span><Space><Button onClick={onClose}>取消</Button><Button type="primary" disabled={disabled} onClick={save}>保存条件</Button></Space></div>}>
    <div className="read-conditions-intro"><strong>{jobLabel || '请选择推荐岗位'}</strong><p>设置条件后，沿 BOSS 推荐列表继续查找，只为符合条件且未入库的人截图。清空条件时仅检查列表前 N 人，不因重复而扩大检查范围。</p></div>
    {draft.groups.length > 1 && <div className="read-conditions-join"><span>条件组之间</span><Select aria-label="读取条件组之间的关系" value={draft.conjunction} options={options} onChange={conjunction => setDraft(current => ({ ...current, conjunction }))} /></div>}
    {draft.groups.map((group, groupIndex) => <div className="filter-condition-group" key={groupIndex}>
      <div className="filter-condition-group-head"><strong>条件组 {groupIndex + 1}</strong><Space size={8}><span>组内</span><Select aria-label={`读取条件组${groupIndex + 1}的关系`} value={group.conjunction} options={options} onChange={conjunction => changeGroup(groupIndex, { conjunction })} /><Button aria-label={`删除读取条件组${groupIndex + 1}`} type="text" icon={<DeleteOutlined />} onClick={() => setDraft(current => ({ ...current, groups: current.groups.filter((_, i) => i !== groupIndex) }))} /></Space></div>
      {group.filters.map((rule, ruleIndex) => <div className="table-rule" key={ruleIndex}>
        <Select aria-label={`读取字段${groupIndex + 1}-${ruleIndex + 1}`} value={rule.field} options={fields} onChange={field => changeRule(groupIndex, ruleIndex, { field })} />
        <Select aria-label={`读取条件${groupIndex + 1}-${ruleIndex + 1}`} value={rule.op} options={operations} onChange={op => changeRule(groupIndex, ruleIndex, { op })} />
        <Input aria-label={`读取条件值${groupIndex + 1}-${ruleIndex + 1}`} value={rule.value} maxLength={100} disabled={['empty', 'not_empty'].includes(rule.op)} placeholder="例如 985、211" onChange={event => changeRule(groupIndex, ruleIndex, { value: event.target.value })} />
        <Button aria-label={`删除读取条件${groupIndex + 1}-${ruleIndex + 1}`} type="text" icon={<DeleteOutlined />} onClick={() => { const filters = group.filters.filter((_, i) => i !== ruleIndex); setDraft(current => ({ ...current, groups: filters.length ? current.groups.map((g, i) => i === groupIndex ? { ...g, filters } : g) : current.groups.filter((_, i) => i !== groupIndex) })); }} />
      </div>)}
      <Button size="small" icon={<PlusOutlined />} disabled={count >= 30 || group.filters.length >= 10} onClick={() => changeGroup(groupIndex, { filters: [...group.filters, newRule()] })}>添加组内条件</Button>
    </div>)}
    <Space><Button icon={<PlusOutlined />} disabled={draft.groups.length >= 10 || count >= 30} onClick={() => setDraft(current => ({ ...current, groups: [...current.groups, { filters: [newRule()], conjunction: 'or' }] }))}>新增条件组</Button><Button type="text" disabled={!draft.groups.length} onClick={() => { setDraft(emptyConditions()); setError(''); }}>清空条件</Button></Space>
    {error && <p className="read-conditions-error" role="alert">{error}</p>}
    <p className="read-conditions-hint">例如“标签包含 985 或 211”：在同一条件组里添加两条规则，组内选择“满足任一（或）”。</p>
  </Drawer>;
}
