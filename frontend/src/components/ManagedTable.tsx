import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Dropdown, Empty, Input, Modal, Select, Space, Table, Tag, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { CheckCircleOutlined, DeleteOutlined, DownOutlined, FilterOutlined, HolderOutlined, MoreOutlined, PlusOutlined, SearchOutlined, SettingOutlined, SortAscendingOutlined, TableOutlined } from '@ant-design/icons';
import { deleteTableRows, fetchTableState, saveTableCells, saveTableConfig } from '../tableApi';
import { cellText, filterCount, moveRow, selectTableRows, type CellValue, type TableConfig, type TableScope, type TableState, type TableView } from '../tableModel';
import { TableSettings, type FieldInfo } from './TableSettings';
import { CellInput, TableCellEditor } from './TableCellEditor';

export interface ManagedField<R> extends FieldInfo { width?: number; fixed?: 'left' | 'right'; defaultHidden?: boolean; get: (row: R) => CellValue | undefined; render?: (row: R) => ReactNode }
interface Props<R> {
  scope: TableScope; rows: R[]; fields: ManagedField<R>[]; loading?: boolean; busy?: boolean;
  onDeleted: (ids: string[]) => void | Promise<void>;
  onLocalSave?: (ids: string[], field: string, value: CellValue) => Promise<void>;
  onPageRows?: (rows: R[], ready: boolean) => void;
  contextKey?: string;
  emptyText?: ReactNode;
  showAll?: boolean;
  selectionActions?: (rows: R[], locked: boolean) => ReactNode;
}
function normalize(config: TableConfig, fields: FieldInfo[]): TableConfig {
  const all = [...fields, ...config.fields];
  return { ...config, views: config.views.map(v => ({ ...v, columns: [...v.columns.filter(c => all.some(f => f.id === c.id)), ...all.filter(f => !v.columns.some(c => c.id === f.id)).map(f => ({ id: f.id, name: '', hidden: !!(f as ManagedField<unknown>).defaultHidden, width: (f as ManagedField<unknown>).width || 160, fixed: (f as ManagedField<unknown>).fixed || '' as const }))] })) };
}

export function ManagedTable<R extends { id: string; name: string; job_titles?: string[] }>({ scope, rows, fields: baseFields, loading, busy, onDeleted, onLocalSave, onPageRows, contextKey = '', emptyText, showAll = false, selectionActions }: Props<R>) {
  const pageSize = scope === 'communications' ? 20 : 10;
  const [state, setState] = useState<TableState | null>(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(false);
  const operation = useRef(false);
  const [saveStatus, setSaveStatus] = useState('设置保存在本地');
  const [settings, setSettings] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<string[]>([]);
  const [dragged, setDragged] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkField, setBulkField] = useState('');
  const [bulkValue, setBulkValue] = useState<CellValue>(null);
  const [viewDialog, setViewDialog] = useState<'rename' | 'clone' | 'new' | null>(null);
  const [viewName, setViewName] = useState('');
  const [modal, modalContext] = Modal.useModal();
  const [messageApi, messageContext] = message.useMessage();
  const reload = async () => { const next = await fetchTableState(scope); setState(next); setError(''); };
  useEffect(() => {
    const controller = new AbortController();
    fetchTableState(scope, controller.signal).then(setState).catch(e => { if (!controller.signal.aborted) setError(String(e.message)); });
    return () => controller.abort();
  }, [scope]);
  const config = state ? normalize(state.config, baseFields) : null;
  const view = config?.views.find(v => v.id === config.active_view);
  const activeFilterCount = view ? filterCount(view) : 0;
  const fields: ManagedField<R>[] = [...baseFields, ...(config?.fields ?? []).map(f => ({ ...f, editable: true, get: (r: R) => state?.values[r.id]?.[f.id] }))];
  const fieldById = new Map(fields.map(f => [f.id, f]));
  const get = (row: R, id: string): CellValue | undefined => id.startsWith('custom_') || id === 'notes' ? state?.values[row.id]?.[id] : fieldById.get(id)?.get(row);
  const ordered = view ? selectTableRows(rows, view, get, id => fieldById.get(id)?.type ?? 'text', query) : [];
  // Group headings participate in pagination, but never in selection or verification.
  type DisplayRow = { id: string; row?: R; group?: string; count?: number };
  const display: DisplayRow[] = [];
  if (view?.group) {
    const groups = new Map<string, R[]>();
    ordered.forEach(row => { const key = cellText(get(row, view.group)); groups.set(key, [...groups.get(key) ?? [], row]); });
    for (const [key, people] of groups) {
      display.push({ id: `group:${key}`, group: key, count: people.length });
      if (!view.collapsed.includes(key)) display.push(...people.map(row => ({ id: row.id, row })));
    }
  } else display.push(...ordered.map(row => ({ id: row.id, row })));
  const pageRows = (showAll ? display : display.slice((page - 1) * pageSize, page * pageSize)).flatMap(item => item.row ? [item.row] : []);
  const pageRowIds = pageRows.map(r => r.id).join('|');
  const pageCallback = useRef(onPageRows); pageCallback.current = onPageRows;
  const pageReady = !!state && !!view && !loading && page <= Math.max(1, Math.ceil(display.length / pageSize));
  useEffect(() => { pageCallback.current?.(pageRows, pageReady); }, [pageRowIds, contextKey, pageReady]);
  useEffect(() => { setPage(1); setSelection([]); setQuery(''); }, [contextKey]);
  useEffect(() => { setPage(p => Math.min(p, Math.max(1, Math.ceil(display.length / pageSize)))); }, [display.length, pageSize]);
  const visibleIds = ordered.map(row => row.id).join('|');
  useEffect(() => { const visible = new Set(visibleIds.split('|')); setSelection(keys => keys.filter(id => visible.has(id))); }, [visibleIds]);
  const locked = !!busy || working || !!loading;
  const manual = !!view && !view.sorts.length && !view.group;
  const selectedRows = rows.filter(row => selection.includes(row.id));
  const run = async (work: () => Promise<void>) => {
    if (operation.current || busy) throw new Error('请等待当前操作完成');
    operation.current = true; setWorking(true); setError(''); setSaveStatus('正在保存…');
    try { await work(); setSaveStatus('已保存到本地'); }
    catch (e) { setError(e instanceof Error ? e.message : '操作失败'); setSaveStatus('保存失败，请重试'); throw e; }
    finally { operation.current = false; setWorking(false); }
  };
  const persist = async (next: TableConfig) => {
    if (!state) return;
    await run(async () => { setState(await saveTableConfig(scope, state.revision, next)); });
  };
  const saveView = (patch: Partial<TableView>) => config && view ? persist({ ...config, views: config.views.map(v => v.id === view.id ? { ...v, ...patch } : v) }) : Promise.resolve();
  const safely = (promise: Promise<unknown>) => { void promise.catch(() => {}); };
  const edit = async (ids: string[], field: string, value: CellValue) => {
    await run(async () => {
      if (field.startsWith('custom_') || field === 'notes') {
        await saveTableCells(scope, ids, field, value);
        setState(old => old && ({ ...old, values: { ...old.values, ...Object.fromEntries(ids.map(id => [id, { ...old.values[id], [field]: value }])) } }));
      } else if (onLocalSave) await onLocalSave(ids, field, value);
      else throw new Error('该字段只读');
    });
  };
  const remove = (people: R[]) => {
    const greeted = scope === 'recommendations' ? people.filter(p => Boolean((p as R & { greeted?: boolean }).greeted)).length : 0;
    return modal.confirm({ title: `处理 ${people.length} 位候选人？`, content: <><p>{people.slice(0, 5).map(p => p.name).join('、')}{people.length > 5 ? '…' : ''}</p><p>{scope === 'recommendations' ? `已打招呼 ${greeted} 人：仅从推荐牛人隐藏，沟通记录及本地资料保留。未打招呼 ${people.length - greeted} 人：按原规则移入回收站并清理推荐资料。` : `删除该人选的全部本地岗位关联、备注和简历；不操作 BOSS。关联岗位：${[...new Set(people.flatMap(p => p.job_titles ?? []))].join('、') || '未关联'}。回收站保留姓名和来源岗位用于阻止再次同步。`}</p></>, okText: scope === 'recommendations' ? '确认处理' : '删除并移入回收站', cancelText: '取消', okButtonProps: { danger: true }, onOk: () => run(async () => {
    const result = await deleteTableRows(scope, people.map(p => p.id));
    await onDeleted(result.deleted); setSelection(keys => keys.filter(id => !result.deleted.includes(id)));
    await reload();
    if (result.errors.length) throw new Error(`已删除 ${result.deleted.length} 人；${result.errors.map(e => e.error).join('；')}`);
    messageApi.success(`已处理 ${result.deleted.length} 人`);
  }) });
  };
  const reposition = (id: string, target: string) => {
    if (!view || !manual || locked) return;
    // Keep IDs outside the current job/filter in their stored relative order.
    const complete = [...view.order, ...rows.map(r => r.id).filter(key => !view.order.includes(key))];
    safely(saveView({ order: moveRow(complete, id, target) }));
  };
  const resize = (id: string, original: number, startX: number, element: HTMLElement, pointerId: number) => {
    element.setPointerCapture(pointerId);
    let width = original;
    // Browser zoom/display scaling can produce fractional CSS-pixel coordinates.
    const move = (e: PointerEvent) => { width = Math.round(Math.max(80, Math.min(800, original + e.clientX - startX))); element.title = `松开保存列宽：${width}px`; element.style.transform = `translateX(${width - original}px)`; };
    const end = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', cancel); element.style.transform = ''; if (view && width !== original) safely(saveView({ columns: view.columns.map(c => c.id === id ? { ...c, width } : c) })); };
    const cancel = () => { element.removeEventListener('pointermove', move); element.removeEventListener('pointerup', end); element.removeEventListener('pointercancel', cancel); element.style.transform = ''; };
    element.addEventListener('pointermove', move); element.addEventListener('pointerup', end); element.addEventListener('pointercancel', cancel);
  };
  const visibleColumns = (view?.columns ?? []).filter(c => !c.hidden && fieldById.has(c.id));
  const columns: ColumnsType<DisplayRow> = [
    { key: 'drag', width: 38, fixed: 'left', render: (_, item) => item.row ? <button className="table-drag-handle" aria-label={`拖动${item.row.name}`} title={manual ? '拖动调整顺序；也可使用末尾菜单置顶或置底' : '清空排序和分组后可拖动'} disabled={!manual || locked} draggable={manual && !locked} onDragStart={e => { setDragged(item.id); e.dataTransfer.setData('text/plain', item.id); }} onDragEnd={() => setDragged('')}><HolderOutlined /></button> : null },
    ...visibleColumns.map((column, index): ColumnsType<DisplayRow>[number] => {
      const field = fieldById.get(column.id)!;
      return { key: column.id, width: column.width, fixed: column.fixed || undefined, title: <div className="managed-column-title"><span>{column.name || field.name}</span>{field.editable && <span className="column-edit-mark" title="可编辑字段">✎</span>}<span role="separator" aria-label={`调整${field.name}列宽`} className="column-resizer" onPointerDown={e => { if (locked) return; e.preventDefault(); e.stopPropagation(); resize(column.id, column.width, e.clientX, e.currentTarget, e.pointerId); }} /></div>,
        onCell: item => !item.row ? { colSpan: index === 0 ? visibleColumns.length : 0 } : {},
        render: (_, item) => !item.row ? index === 0 && <button className="table-group-toggle" disabled={locked} onClick={() => safely(saveView({ collapsed: view!.collapsed.includes(item.group!) ? view!.collapsed.filter(g => g !== item.group) : [...view!.collapsed, item.group!] }))}><DownOutlined rotate={view!.collapsed.includes(item.group!) ? -90 : 0} /><strong>{item.group || '未填写'}</strong><Tag>{item.count} 人</Tag></button> : field.editable ? <TableCellEditor key={`${item.id}:${field.id}`} field={{ ...field, name: column.name || field.name }} value={get(item.row, field.id) ?? null} disabled={locked} save={value => edit([item.id], field.id, value)} /> : field.render ? field.render(item.row) : <span className="table-readonly-value">{cellText(get(item.row, field.id)) || '—'}</span>,
      };
    }),
    { key: 'actions', title: '', width: 45, fixed: 'right', render: (_, item) => item.row ? <Dropdown trigger={['click']} menu={{ items: [{ key: 'top', label: '置顶', disabled: !manual }, { key: 'bottom', label: '置底', disabled: !manual }, { type: 'divider' }, { key: 'delete', label: scope === 'recommendations' && (item.row as R & { greeted?: boolean }).greeted ? '从推荐页隐藏' : '移入回收站', icon: <DeleteOutlined />, danger: true }], onClick: ({ key }) => key === 'delete' ? remove([item.row!]) : reposition(item.id, key) }}><Button type="text" size="small" disabled={locked} aria-label={`${item.row.name}的行操作`} icon={<MoreOutlined />} /></Dropdown> : null },
  ];
  const editable = fields.filter(f => f.editable);
  const activeBulkField = editable.find(f => f.id === bulkField);
  if (!state || !config || !view) return <div className="managed-table-loading">{error ? <Alert type="error" message={error} action={<Button onClick={() => safely(reload())}>重试</Button>} /> : <Table loading columns={[]} dataSource={[]} />}</div>;
  return <div className="managed-table">
    {modalContext}{messageContext}
    <div className="table-view-bar"><Space><TableOutlined /><Select aria-label="选择表格视图" value={view.id} options={config.views.map(v => ({ value: v.id, label: v.name }))} disabled={locked} onChange={active_view => { setPage(1); setSelection([]); safely(persist({ ...config, active_view })); }} style={{ minWidth: 145 }} />
      <Dropdown trigger={['click']} menu={{ items: [{ key: 'new', label: '新建视图', icon: <PlusOutlined />, disabled: config.views.length >= 30 }, { key: 'clone', label: '复制当前视图', disabled: config.views.length >= 30 }, { key: 'rename', label: '重命名视图' }, { key: 'delete', label: '删除当前视图', danger: true, disabled: config.views.length === 1 }], onClick: ({ key }) => {
        if (key === 'delete') modal.confirm({ title: '删除当前视图？', content: '仅删除视图配置，候选人和字段值都会保留。', okText: '删除视图', cancelText: '取消', onOk: () => persist({ ...config, views: config.views.filter(v => v.id !== view.id), active_view: config.views.find(v => v.id !== view.id)!.id }) });
        else { setViewDialog(key as 'new' | 'clone' | 'rename'); setViewName(key === 'new' ? '' : key === 'clone' ? `${view.name} 副本` : view.name); }
      } }}><Button aria-label="管理视图" type="text" disabled={locked} icon={<MoreOutlined />} /></Dropdown></Space><span className="table-save-status"><CheckCircleOutlined /> {saveStatus}</span></div>
    <div className="managed-toolbar"><Space wrap size={5}><Button size="small" icon={<SettingOutlined />} disabled={locked} onClick={() => setSettings('fields')}>字段 {visibleColumns.length}</Button><Button size="small" type={activeFilterCount ? 'primary' : 'text'} ghost={!!activeFilterCount} icon={<FilterOutlined />} disabled={locked} onClick={() => setSettings('filters')}>筛选{activeFilterCount ? ` ${activeFilterCount}` : ''}</Button><Button size="small" icon={<SortAscendingOutlined />} disabled={locked} onClick={() => setSettings('sorts')}>排序{view.sorts.length ? ` ${view.sorts.length}` : ''}</Button><Button size="small" disabled={locked} onClick={() => setSettings('group')}>{view.group ? `分组：${fieldById.get(view.group)?.name}` : '分组'}</Button></Space><Input disabled={locked} aria-label="搜索表格" className="managed-search" size="small" prefix={<SearchOutlined />} placeholder="搜索本地表格" allowClear value={query} onChange={e => { setQuery(e.target.value); setPage(1); }} /></div>
    {error && <Alert className="table-error" type="error" showIcon message={error} action={<Button size="small" disabled={working} onClick={() => safely(reload())}>重新加载设置</Button>} />}
    {selection.length > 0 && <div className="table-selection-bar"><span>已选择 <strong>{selection.length}</strong> 人</span><Space>{selectionActions?.(selectedRows, locked)}<Button size="small" disabled={locked || !editable.length} onClick={() => { setBulkField(editable[0]?.id || ''); setBulkValue(null); setBulkOpen(true); }}>批量填写</Button><Button size="small" danger icon={<DeleteOutlined />} disabled={locked} onClick={() => remove(selectedRows)}>删除</Button><Button type="text" size="small" disabled={locked} onClick={() => setSelection([])}>取消选择</Button></Space></div>}
    <Table<DisplayRow> className={`managed-data-table ${scope === 'recommendations' ? 'recommendation-table' : 'candidate-table'}`} rowKey="id" size="middle" tableLayout="fixed" columns={columns} dataSource={display} loading={loading || working} rowClassName={item => !item.row ? 'table-group-row' : dragged === item.id ? 'table-row-dragging' : ''} rowSelection={{ selectedRowKeys: selection, preserveSelectedRowKeys: true, onChange: keys => setSelection(keys.map(String)), getCheckboxProps: item => ({ disabled: !item.row || locked }), columnWidth: 38, fixed: true }} onRow={item => ({ onDragOver: e => { if (dragged && item.row && manual) e.preventDefault(); }, onDrop: e => { e.preventDefault(); if (dragged && item.row) reposition(dragged, item.id); setDragged(''); } })} pagination={showAll ? false : { disabled: locked, current: page, onChange: setPage, pageSize, showSizeChanger: false, hideOnSinglePage: true }} scroll={{ x: visibleColumns.reduce((sum, c) => sum + c.width, 0) + 121 }} locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={query || activeFilterCount ? '没有符合条件的记录，可调整筛选或搜索' : emptyText || '暂无本地记录'} /> }} />
    <div className="managed-table-footer"><span>{ordered.length} / {rows.length} 条记录{view.group ? ' · 已分组' : manual ? ' · 手动排序' : ` · ${view.sorts.length} 项排序`}</span><span>点击可编辑单元格 · 拖动表头边线调整列宽</span></div>
    {settings && <TableSettings key={`${view.id}:${settings}`} initial={config} state={state} fields={baseFields} tab={settings} busy={working} error={error} onClose={() => setSettings('')} onSave={async next => { try { await persist(next); setSettings(''); setPage(1); } catch { /* Keep settings open for correction. */ } }} />}
    <Modal title={viewDialog === 'new' ? '新建视图' : viewDialog === 'clone' ? '复制视图' : '重命名视图'} open={!!viewDialog} onCancel={() => setViewDialog(null)} confirmLoading={working} okText="保存" cancelText="取消" onOk={() => {
      const name = viewName.trim();
      if (!name || config.views.some(v => v.name === name && (viewDialog !== 'rename' || v.id !== view.id))) { messageApi.warning('请输入不重复的视图名称'); return; }
      const id = crypto.randomUUID();
      const newView: TableView = viewDialog === 'clone' ? { ...structuredClone(view), id, name } : { id, name, columns: view.columns, filters: [], conjunction: 'and', filter_groups: [], sorts: [], group: '', collapsed: [], order: [] };
      safely(persist(viewDialog === 'rename' ? { ...config, views: config.views.map(v => v.id === view.id ? { ...v, name } : v) } : { ...config, views: [...config.views, newView], active_view: id }).then(() => { setViewDialog(null); setPage(1); }));
    }}><Input aria-label="视图名称" maxLength={60} value={viewName} onChange={e => setViewName(e.target.value)} placeholder="例如：本周关注" /></Modal>
    <Modal title={`批量填写 · ${selection.length} 人`} open={bulkOpen} confirmLoading={working} onCancel={() => setBulkOpen(false)} okText="应用到所选人选" cancelText="取消" onOk={() => { if (bulkField && selection.length) safely(edit(selection, bulkField, bulkValue).then(() => setBulkOpen(false))); }}>
      <p className="table-help">所选字段的现有值会被替换；留空将清除此字段。</p><Select aria-label="批量填写字段" value={bulkField} options={editable.map(f => ({ value: f.id, label: f.name }))} onChange={field => { setBulkField(field); setBulkValue(null); }} style={{ width: '100%', marginBottom: 16 }} />{activeBulkField && <CellInput key={bulkField} field={activeBulkField} value={bulkValue} onChange={setBulkValue} />}
    </Modal>
  </div>;
}
