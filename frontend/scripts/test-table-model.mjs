import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/tableModel.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { beijingDate, matches, filterCount, selectTableRows, moveRow } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
assert.equal(beijingDate('2026-10-21T16:30:00Z'), '2026-10-22');
assert.equal(beijingDate('2026-10-21T16:30:00'), '2026-10-22');
assert.equal(beijingDate(null), '');
assert.equal(matches(false, { op: 'empty', value: '' }), false);
assert.equal(matches(0, { op: 'empty', value: '' }), false);
assert.equal(matches([], { op: 'empty', value: '' }), true);
assert.equal(matches(10, { op: 'gt', value: '2' }, 'number'), true);
assert.equal(matches(['重点', '待看'], { op: 'eq', value: '重点' }, 'multi'), true);
const rows = [{ id: 'a', name: '同名', score: 10, group: '乙' }, { id: 'b', name: '同名', score: 2, group: '甲' }, { id: 'c', name: '其他', score: 10, group: '甲' }, { id: 'd', name: '空', score: null, group: '' }];
const view = { columns: [{ id: 'name' }], filters: [], sorts: [], order: ['c', 'a', 'b'], conjunction: 'and' };
const get = (r, f) => r[f];
const type = f => f === 'score' ? 'number' : 'text';
assert.deepEqual(selectTableRows(rows, view, get, type).map(r => r.id), ['c', 'a', 'b', 'd']);
assert.deepEqual(selectTableRows(rows, { ...view, sorts: [{ field: 'score', direction: 'desc' }, { field: 'group', direction: 'asc' }] }, get, type).map(r => r.id), ['c', 'a', 'b', 'd']);
assert.equal(selectTableRows(rows, { ...view, filters: [{ field: 'name', op: 'eq', value: '同名' }, { field: 'score', op: 'gte', value: '10' }] }, get, type).length, 1);
assert.equal(selectTableRows(rows, { ...view, conjunction: 'or', filters: [{ field: 'name', op: 'eq', value: '同名' }, { field: 'score', op: 'gte', value: '10' }] }, get, type).length, 3);
const candidates = [
  { id: '985-27', tags: ['985院校'], base: '27年应届 / 硕士' },
  { id: '211-28', tags: ['211院校'], base: '28年应届 / 本科' },
  { id: '985-29', tags: ['985院校'], base: '29年应届 / 硕士' },
  { id: 'other-27', tags: ['普通院校'], base: '27年应届 / 本科' },
];
const groupedView = { ...view, filter_groups: [
  { conjunction: 'or', filters: [{ field: 'tags', op: 'contains', value: '985' }, { field: 'tags', op: 'contains', value: '211' }] },
  { conjunction: 'or', filters: [{ field: 'base', op: 'contains', value: '27年应届' }, { field: 'base', op: 'contains', value: '28年应届' }] },
] };
assert.equal(filterCount(groupedView), 4);
assert.deepEqual(selectTableRows(candidates, groupedView, get, type).map(r => r.id), ['985-27', '211-28']);
assert.equal(selectTableRows(candidates, { ...groupedView, conjunction: 'or' }, get, type).length, 4);
assert.deepEqual(moveRow(['hidden', 'a', 'b', 'c'], 'c', 'a'), ['hidden', 'c', 'a', 'b']);
assert.deepEqual(moveRow(['a', 'b', 'c'], 'a', 'bottom'), ['b', 'c', 'a']);
assert.deepEqual(moveRow(['a', 'b', 'c'], 'c', 'top'), ['c', 'a', 'b']);
console.log('Table model checks passed: Beijing dates, typed and grouped filters, multi-sort, manual ordering and preserved hidden rows.');
