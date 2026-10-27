export type TableScope = 'recommendations' | 'communications';
export type FieldType = 'text' | 'multiline' | 'number' | 'date' | 'select' | 'multi' | 'checkbox';
export type CellValue = string | number | boolean | string[] | null;
export interface CustomField { id: string; name: string; type: FieldType; options: string[] }
export interface ColumnConfig { id: string; name: string; width: number; hidden: boolean; fixed: '' | 'left' | 'right' }
export interface FilterRule { field: string; op: 'contains' | 'not_contains' | 'eq' | 'neq' | 'empty' | 'not_empty' | 'gt' | 'gte' | 'lt' | 'lte'; value: string }
export interface SortRule { field: string; direction: 'asc' | 'desc' }
export interface TableView { id: string; name: string; columns: ColumnConfig[]; filters: FilterRule[]; conjunction: 'and' | 'or'; sorts: SortRule[]; group: string; collapsed: string[]; order: string[] }
export interface TableConfig { fields: CustomField[]; views: TableView[]; active_view: string }
export interface TableState { revision: number; config: TableConfig; values: Record<string, Record<string, CellValue>> }
export const fieldTypes: Record<FieldType, string> = { text: '文本', multiline: '多行文本', number: '数字', date: '日期', select: '单选', multi: '多选', checkbox: '复选框' };
export const filterLabels: Record<FilterRule['op'], string> = { contains: '包含', not_contains: '不包含', eq: '等于', neq: '不等于', empty: '为空', not_empty: '不为空', gt: '大于 / 晚于', gte: '大于等于', lt: '小于 / 早于', lte: '小于等于' };
export const cellText = (value: CellValue | undefined) => Array.isArray(value) ? value.join('、') : value == null ? '' : typeof value === 'boolean' ? value ? '是' : '否' : String(value);
export function beijingDate(value?: string | null) {
  if (!value) return '';
  const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}
export function matches(value: CellValue | undefined, rule: FilterRule, type: FieldType = 'text') {
  const text = cellText(value).toLocaleLowerCase();
  const needle = rule.value.toLocaleLowerCase();
  const empty = value == null || value === '' || (Array.isArray(value) && !value.length);
  if (rule.op === 'empty') return empty;
  if (rule.op === 'not_empty') return !empty;
  if (rule.op === 'contains') return text.includes(needle);
  if (rule.op === 'not_contains') return !text.includes(needle);
  const equal = Array.isArray(value) ? value.some(v => v.toLocaleLowerCase() === needle) : type === 'number' ? !empty && needle.trim() !== '' && Number(value) === Number(needle) : text === needle;
  if (rule.op === 'eq') return equal;
  if (rule.op === 'neq') return !equal;
  if (empty || !needle.trim()) return false;
  const a = type === 'number' ? Number(value) : text;
  const b = type === 'number' ? Number(needle) : needle;
  return rule.op === 'gt' ? a > b : rule.op === 'gte' ? a >= b : rule.op === 'lt' ? a < b : a <= b;
}
export function selectTableRows<R extends { id: string }>(rows: R[], view: TableView, get: (row: R, field: string) => CellValue | undefined, type: (field: string) => FieldType, search = '') {
  const order = new Map(view.order.map((id, index) => [id, index]));
  const result = rows.filter(row => {
    const results = view.filters.map(rule => matches(get(row, rule.field), rule, type(rule.field)));
    const matched = !results.length || (view.conjunction === 'and' ? results.every(Boolean) : results.some(Boolean));
    return matched && (!search.trim() || view.columns.some(c => cellText(get(row, c.id)).toLowerCase().includes(search.trim().toLowerCase())));
  });
  return result.sort((a, b) => {
    for (const sort of view.sorts) {
      const av = get(a, sort.field), bv = get(b, sort.field);
      const emptyA = av == null || av === '', emptyB = bv == null || bv === '';
      if (emptyA !== emptyB) return emptyA ? 1 : -1;
      const delta = type(sort.field) === 'number' ? Number(av) - Number(bv) : cellText(av).localeCompare(cellText(bv), 'zh-CN', { numeric: true });
      if (delta) return sort.direction === 'asc' ? delta : -delta;
    }
    return (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER);
  });
}
export function moveRow(order: string[], id: string, target: string | 'top' | 'bottom') {
  if (id === target) return order;
  const result = order.filter(key => key !== id);
  const index = target === 'top' ? 0 : target === 'bottom' ? result.length : result.indexOf(target);
  result.splice(index < 0 ? result.length : index, 0, id);
  return result;
}
