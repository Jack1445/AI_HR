import { useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Input, InputNumber, Modal, Select, Space, Tabs, Tag } from 'antd';
import { DeleteOutlined, HolderOutlined, PlusOutlined } from '@ant-design/icons';
import { fieldTypes, filterLabels, moveRow, type CustomField, type FieldType, type TableConfig, type TableState } from '../tableModel';

export interface FieldInfo { id: string; name: string; type: FieldType; editable?: boolean; options?: string[] }
interface Props { initial: TableConfig; state: TableState; fields: FieldInfo[]; tab: string; busy: boolean; error?: string; onSave: (config: TableConfig) => Promise<void>; onClose: () => void }
export function TableSettings({ initial, state, fields: baseFields, tab, busy, error, onSave, onClose }: Props) {
  const [config, setConfig] = useState<TableConfig>(() => structuredClone(initial));
  const [activeTab, setActiveTab] = useState(tab);
  const [dragged, setDragged] = useState('');
  const [newName, setNewName] = useState('');
  const [newType, setNewType] = useState<FieldType>('text');
  const [newOptions, setNewOptions] = useState<string[]>([]);
  const [validation, setValidation] = useState('');
  const [modal, context] = Modal.useModal();
  const view = config.views.find(v => v.id === config.active_view)!;
  const fields = [...baseFields, ...config.fields.map(f => ({ ...f, editable: true }))];
  const options = fields.map(f => ({ value: f.id, label: view.columns.find(c => c.id === f.id)?.name || f.name }));
  const changeView = (patch: Partial<typeof view>) => setConfig(c => ({ ...c, views: c.views.map(v => v.id === view.id ? { ...v, ...patch } : v) }));
  const changeColumn = (id: string, patch: Partial<typeof view.columns[number]>) => changeView({ columns: view.columns.map(c => c.id === id ? { ...c, ...patch } : c) });
  const updateCustom = (id: string, patch: Partial<CustomField>) => setConfig(c => ({ ...c, fields: c.fields.map(f => f.id === id ? { ...f, ...patch } : f) }));
  const removeField = (id: string) => {
    const count = Object.values(state.values).filter(v => v[id] != null && v[id] !== '' && (!Array.isArray(v[id]) || (v[id] as string[]).length)).length;
    modal.confirm({ title: '删除这个自定义字段？', content: `保存设置后将清除 ${count} 条已填写的值，并从所有视图移除此字段。此操作不能撤销。`, okText: '删除字段', okButtonProps: { danger: true }, cancelText: '取消', onOk: () => setConfig(c => ({ ...c, fields: c.fields.filter(f => f.id !== id), views: c.views.map(v => ({ ...v, columns: v.columns.filter(col => col.id !== id), filters: v.filters.filter(f => f.field !== id), sorts: v.sorts.filter(s => s.field !== id), group: v.group === id ? '' : v.group })) })) });
  };
  const addField = () => {
    const name = newName.trim();
    if (!name || fields.some(f => f.name === name)) { setValidation('请输入不重复的字段名称'); return; }
    if ((newType === 'select' || newType === 'multi') && !newOptions.length) { setValidation('请至少添加一个选项'); return; }
    const id = `custom_${crypto.randomUUID()}`;
    setConfig(c => ({ ...c, fields: [...c.fields, { id, name, type: newType, options: newOptions }], views: c.views.map(v => ({ ...v, columns: [...v.columns, { id, name: '', width: 160, hidden: false, fixed: '' }] })) }));
    setNewName(''); setNewOptions([]); setValidation('');
  };
  const fieldPanel = <>
    <p className="table-help">拖动左侧手柄调整列顺序。系统字段可隐藏、改显示名称；自定义字段的值保存在本地数据库。</p>
    <div className="field-config-head"><span>显示 / 字段名称</span><span>宽度</span><span>固定位置</span></div>
    {view.columns.map(column => {
      const field = fields.find(f => f.id === column.id)!;
      const custom = config.fields.find(f => f.id === column.id);
      if (!field) return null;
      return <div className="field-config-item" key={column.id} onDragOver={e => { if (dragged) e.preventDefault(); }} onDrop={e => { e.preventDefault(); if (!dragged) return; const order = moveRow(view.columns.map(c => c.id), dragged, column.id); changeView({ columns: order.map(id => view.columns.find(c => c.id === id)!) }); setDragged(''); }}>
        <div className="field-config-row"><button className="table-drag-handle" draggable onDragStart={e => { setDragged(column.id); e.dataTransfer.setData('text/plain', column.id); }} onDragEnd={() => setDragged('')} title="拖动调整字段顺序"><HolderOutlined /></button>
          <Checkbox aria-label={`显示${field.name}`} checked={!column.hidden} onChange={e => changeColumn(column.id, { hidden: !e.target.checked })} />
          <Input aria-label={`${field.name}显示名称`} maxLength={60} value={column.name || field.name} onChange={e => custom ? updateCustom(field.id, { name: e.target.value }) : changeColumn(column.id, { name: e.target.value })} />
          <InputNumber aria-label={`${field.name}列宽`} min={80} max={800} precision={0} step={1} value={column.width} onChange={value => changeColumn(column.id, { width: Math.round(value ?? 160) })} />
          <Select aria-label={`${field.name}固定位置`} value={column.fixed} onChange={fixed => changeColumn(column.id, { fixed })} options={[{ value: '', label: '不固定' }, { value: 'left', label: '左侧' }, { value: 'right', label: '右侧' }]} />
          {custom ? <Button danger type="text" aria-label={`删除字段${field.name}`} icon={<DeleteOutlined />} onClick={() => removeField(field.id)} /> : <Tag className="system-field-tag">系统</Tag>}
        </div>
        {custom && <div className="field-type-line"><span>{fieldTypes[custom.type]}</span>{['select', 'multi'].includes(custom.type) && <Select aria-label={`${field.name}选项`} mode="tags" value={custom.options} tokenSeparators={[',', '，']} onChange={values => updateCustom(custom.id, { options: [...new Set([...state.config.fields.find(f => f.id === custom.id)?.options ?? [], ...values.map(v => v.trim()).filter(Boolean)])] })} placeholder="输入选项后回车" />}</div>}
      </div>;
    })}
    <div className="new-field-form"><strong>新增字段</strong><Space.Compact block><Input aria-label="新字段名称" maxLength={60} placeholder="例如：关注原因、面试日期" value={newName} onChange={e => setNewName(e.target.value)} /><Select aria-label="新字段类型" value={newType} onChange={setNewType} options={Object.entries(fieldTypes).map(([value, label]) => ({ value, label }))} style={{ width: 140 }} /></Space.Compact>
      {['select', 'multi'].includes(newType) && <Select aria-label="新字段选项" mode="tags" value={newOptions} onChange={values => setNewOptions([...new Set(values.map(v => v.trim()).filter(Boolean))])} placeholder="输入选项后回车，如：重点关注" tokenSeparators={[',', '，']} />}
      {validation && <Alert type="warning" message={validation} />}<Button icon={<PlusOutlined />} onClick={addField} disabled={config.fields.length >= 100}>添加字段</Button></div>
  </>;
  const filterPanel = <><p className="table-help">筛选只改变当前视图，不删除记录；应用于全部本地数据。</p><Select aria-label="筛选组合方式" value={view.conjunction} options={[{ value: 'and', label: '满足以下所有条件（且）' }, { value: 'or', label: '满足以下任意条件（或）' }]} onChange={conjunction => changeView({ conjunction })} style={{ width: 260 }} />
    {view.filters.map((rule, i) => <div className="table-rule" key={i}><Select aria-label={`筛选字段${i + 1}`} value={rule.field} options={options} onChange={field => changeView({ filters: view.filters.map((r, j) => i === j ? { ...r, field } : r) })} /><Select aria-label={`筛选条件${i + 1}`} value={rule.op} options={Object.entries(filterLabels).map(([value, label]) => ({ value, label }))} onChange={op => changeView({ filters: view.filters.map((r, j) => i === j ? { ...r, op } : r) })} /><Input aria-label={`筛选值${i + 1}`} placeholder="日期填 YYYY-MM-DD，复选框填 是 / 否" value={rule.value} disabled={['empty', 'not_empty'].includes(rule.op)} onChange={e => changeView({ filters: view.filters.map((r, j) => i === j ? { ...r, value: e.target.value } : r) })} /><Button aria-label={`删除筛选${i + 1}`} type="text" icon={<DeleteOutlined />} onClick={() => changeView({ filters: view.filters.filter((_, j) => j !== i) })} /></div>)}
    <Space><Button icon={<PlusOutlined />} onClick={() => changeView({ filters: [...view.filters, { field: fields[0].id, op: 'contains', value: '' }] })} disabled={view.filters.length >= 30}>添加条件</Button><Button type="text" onClick={() => changeView({ filters: [] })}>清空筛选</Button></Space></>;
  const sortPanel = <><p className="table-help">从上到下按优先级排序。清空排序并取消分组后，可拖动行或置顶、置底。</p>{view.sorts.map((rule, i) => <div className="table-rule sort-rule" key={i}><span>{i + 1}</span><Select aria-label={`排序字段${i + 1}`} value={rule.field} options={options} onChange={field => changeView({ sorts: view.sorts.map((r, j) => i === j ? { ...r, field } : r) })} /><Select aria-label={`排序方向${i + 1}`} value={rule.direction} options={[{ value: 'asc', label: '升序' }, { value: 'desc', label: '降序' }]} onChange={direction => changeView({ sorts: view.sorts.map((r, j) => i === j ? { ...r, direction } : r) })} /><Button aria-label={`删除排序${i + 1}`} type="text" icon={<DeleteOutlined />} onClick={() => changeView({ sorts: view.sorts.filter((_, j) => i !== j) })} /></div>)}<Space><Button icon={<PlusOutlined />} disabled={view.sorts.length >= 10} onClick={() => changeView({ sorts: [...view.sorts, { field: fields[0].id, direction: 'asc' }] })}>添加排序</Button><Button type="text" onClick={() => changeView({ sorts: [] })}>清空排序</Button></Space></>;
  const groupPanel = <><p className="table-help">按字段分组查看；点击分组标题可收起或展开。每组显示实际记录数。</p><Select aria-label="分组字段" style={{ width: '100%' }} value={view.group} options={[{ value: '', label: '不分组' }, ...options.filter(o => o.value !== 'resume')]} onChange={group => changeView({ group, collapsed: [] })} /></>;
  return <Drawer title={`表格设置 · ${view.name}`} width={700} open onClose={busy ? undefined : onClose} maskClosable={!busy} footer={<div className="table-settings-footer"><span>设置仅影响当前视图；字段增删影响整张表</span><Space><Button disabled={busy} onClick={onClose}>取消</Button><Button type="primary" loading={busy} onClick={() => {
    if (!view.columns.some(c => !c.hidden)) { setValidation('请至少保留一列可见'); setActiveTab('fields'); return; }
    if (config.fields.some(f => !f.name.trim())) { setValidation('字段名称不能为空'); setActiveTab('fields'); return; }
    void onSave(config);
  }}>保存设置</Button></Space></div>}>
    {context}{error && <Alert type="error" message={error} showIcon />}<Tabs activeKey={activeTab} onChange={setActiveTab} items={[{ key: 'fields', label: '字段管理', children: fieldPanel }, { key: 'filters', label: `筛选 ${view.filters.length || ''}`, children: filterPanel }, { key: 'sorts', label: `排序 ${view.sorts.length || ''}`, children: sortPanel }, { key: 'group', label: '分组', children: groupPanel }]} />
  </Drawer>;
}
