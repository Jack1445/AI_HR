import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

// Exercise the production coordinator with fake I/O; never connect to BOSS.
const source = await readFile(new URL('../src/recommendationBatch.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } });
const { captureRecommendationBatch } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`);
const people = Array.from({ length: 20 }, (_, i) => ({ geekId: `id-${i}`, name: `Person ${i}`, online_resume: { id: 'old' } }));
const calls = [], saved = [], progress = [];
let active = 0;
const failures = await captureRecommendationBatch(people, async person => {
  const id = person.geekId;
  assert.equal(active++, 0, 'resume requests must run sequentially');
  calls.push(id);
  await new Promise(resolve => setImmediate(resolve));
  active--;
  if (id === 'id-3') throw new Error('test failure');
  return { id: `shot-${id}` };
}, (person, screenshot) => saved.push([person.geekId, screenshot.id]), state => progress.push(state));
assert.deepEqual(calls, people.map(person => person.geekId));
assert.equal(saved.length, 19);
assert.deepEqual(failures, ['Person 3：test failure']);
assert.deepEqual(progress.at(-1), { total: 20, completed: 20, failed: 1, currentName: null });
assert.equal(people[3].online_resume.id, 'old', 'failure must leave old screenshot intact');
let extraCalls = 0;
await assert.rejects(captureRecommendationBatch([...people, people[0]], async () => { extraCalls++; }, () => {}, () => {}), /超过 20/);
assert.equal(extraCalls, 0);
const missing = await captureRecommendationBatch([{ geekId: '', name: 'No ID' }], async () => { extraCalls++; }, () => {}, () => {});
assert.equal(missing.length, 1);
assert.equal(extraCalls, 0);
assert.deepEqual(await captureRecommendationBatch([], async () => { extraCalls++; }, () => {}, () => {}), []);
assert.equal(extraCalls, 0);
console.log('Recommendation batch passed: cap, sequential requests, partial failure, existing screenshot, missing ID, empty list.');
