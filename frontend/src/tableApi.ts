import { fetchJson } from './api';
import type { CellValue, TableConfig, TableScope, TableState } from './tableModel';
const body = (value: unknown, method = 'PUT') => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
export const fetchTableState = (scope: TableScope, signal?: AbortSignal) => fetchJson<TableState>(`/api/local/tables/${scope}`, signal, '读取表格设置失败');
export const saveTableConfig = (scope: TableScope, revision: number, config: TableConfig) => fetchJson<TableState>(`/api/local/tables/${scope}/config`, undefined, '保存设置失败', body({ revision, config }));
export const saveTableCells = (scope: TableScope, ids: string[], field: string, value: CellValue) => fetchJson(`/api/local/tables/${scope}/cells`, undefined, '保存字段失败', body({ record_ids: ids, field_id: field, value }));
export const deleteTableRows = (scope: TableScope, ids: string[]) => fetchJson<{ deleted: string[]; errors: { id: string; error: string }[] }>(`/api/local/tables/${scope}/delete`, undefined, '删除失败', body({ record_ids: ids }, 'POST'));
export interface CommunicationTrash { id: string; name: string; source_job: string }
export const fetchCommunicationTrash = () => fetchJson<CommunicationTrash[]>('/api/local/tables/communications/recycle-bin', undefined, '读取回收站失败');
export const restoreCommunication = (id: string) => fetchJson(`/api/local/tables/communications/recycle-bin/${id}/restore`, undefined, '允许重新同步失败', { method: 'POST' });
