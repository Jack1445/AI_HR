import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const source = await readFile(new URL('../src/recycleBatch.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { restoreRecycleRecords } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const rows = Array.from({ length: 23 }, (_, i) => ({ id: String(i), name: '同名人选' }));
let active = 0; const calls = [], removed = [], progress = [];
const result = await restoreRecycleRecords([...rows, rows[0]], async id => {
  assert.equal(active++, 0); calls.push(id); await new Promise(resolve => setImmediate(resolve)); active--;
  if (id === '4') throw new Error('temporary failure');
}, id => removed.push(id), (done, total) => progress.push([done, total]));
assert.equal(calls.length, 23); assert.equal(result.restored, 22); assert.equal(result.failures.length, 1);
assert.equal(removed.includes('4'), false, 'failed row must remain in trash and selection');
assert.deepEqual(progress.at(-1), [23, 23]);
assert.deepEqual(await restoreRecycleRecords([], () => assert.fail('no selection'), () => {}, () => {}), { restored: 0, failures: [] });
console.log('Recycle batch passed: cross-page-sized selection, stable IDs for namesakes, duplicate suppression, partial failures and empty selection.');
