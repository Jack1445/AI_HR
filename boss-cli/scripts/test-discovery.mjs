// Offline contract tests. Never connect to Chrome or visit BOSS.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { classifyEvidence, validateTargets } from '../dist/toolset/communication.js';
import { readRecommendList, runRecommend, collectNewRecommendations } from '../dist/toolset/recommend.js';

const base = { recruiter_sent: false, candidate_sent: false, request_resume_enabled: null, mutual_reply_required: false, attachment_present: false };
assert.equal(classifyEvidence({ ...base, recruiter_sent: true }), 'unknown');
assert.equal(classifyEvidence({ ...base, candidate_sent: true, request_resume_enabled: false }), 'unknown');
assert.equal(classifyEvidence({ ...base, recruiter_sent: true, mutual_reply_required: true }), 'outgoing');
assert.equal(classifyEvidence({ ...base, candidate_sent: true, mutual_reply_required: true }), 'incoming');
assert.equal(classifyEvidence({ ...base, recruiter_sent: true, candidate_sent: true }), 'mutual');
assert.equal(classifyEvidence({ ...base, request_resume_enabled: true }), 'mutual');
assert.equal(classifyEvidence({ ...base, request_resume_enabled: true, mutual_reply_required: true }), 'unknown');
assert.equal(classifyEvidence({ ...base, attachment_present: true }), 'unknown');
assert.throws(() => validateTargets([]));
validateTargets([{ id: 'local-a', sourceId: 'remote-a', name: '同名', job: '同岗位' }, { id: 'local-b', sourceId: 'remote-b', name: '同名', job: '同岗位' }]);
assert.throws(() => validateTargets([{ id: 'local-a', name: '缺少会话编号', job: '岗位' }]));
assert.throws(() => validateTargets(Array.from({ length: 11 }, (_, i) => ({ id: String(i), name: '测试', job: '岗位' }))));
assert.throws(() => validateTargets([{ id: '1', name: '测试', job: '岗位' }, { id: '1', name: '测试', job: '岗位' }]));
await assert.rejects(() => runRecommend(undefined, { limit: 51 }));

// Execute the real extraction script against 20 synthetic cards. Access to
// card 11+ fails, proving the cap is applied BEFORE extracting personal data.
let touched = new Set();
const cards = Array.from({ length: 20 }, (_, index) => {
  const touch = () => { assert.ok(index < 10, 'read beyond hard limit'); touched.add(index); };
  return {
    querySelector(selector) { touch(); return selector === '.name-wrap .name' ? { textContent: `测试${index}` } : null; },
    querySelectorAll() { touch(); return []; },
    matches() { touch(); return false; },
    getAttribute() { touch(); return ''; },
    classList: { contains() { touch(); return false; } },
  };
});
const frame = { evaluate: async (script) => vm.runInNewContext(script, { document: { querySelectorAll: () => cards } }) };
assert.equal((await readRecommendList(frame, 10)).length, 10);
assert.equal(touched.size, 10);
const nestedFrame = { evaluate: async (script) => vm.runInNewContext(script, { document: { querySelectorAll: () => cards.flatMap(card => [card, card]) } }) };
assert.equal((await readRecommendList(nestedFrame, 10)).length, 10);
await assert.rejects(() => readRecommendList(frame, 51));
console.log('Discovery checks passed: evidence, ambiguity, limits, extraction cap. No BOSS calls.');

const makeCard = (name, baseInfo, id) => ({
  querySelector(selector) { return selector.includes('.name') ? { textContent: name } : null; },
  querySelectorAll(selector) { return selector === '.base-info span' ? [{ textContent: baseInfo }] : []; },
  matches() { return false; },
  getAttribute() { return id; },
  classList: { contains() { return false; } },
});
const original = Array.from({ length: 10 }, (_, i) => makeCard('同名', `本科${i}`, `old-${i}`));
const fresh = Array.from({ length: 10 }, (_, i) => makeCard('同名', `硕士${i}`, `new-${i}`));
const exclude = original.map((_, i) => ({ name: '同名', baseInfo: `本科${i}` }));
let scrolls = 0;
const incrementalFrame = { waitForFunction: async () => {}, evaluate: async script => {
  if (script.includes('window.scrollTo')) { scrolls++; return; }
  if (script.includes('return JSON.stringify(nodes.map')) return `page-${scrolls}`;
  return vm.runInNewContext(script, { document: { querySelectorAll: () => [...original, ...(scrolls ? fresh : [])] } });
} };
const batch = await collectNewRecommendations(incrementalFrame, 10, exclude);
assert.equal(batch.candidates.length, 10);
assert.equal(batch.candidates[0].baseInfo, '硕士0');
assert.equal(scrolls, 1, 'stop scrolling once 10 new identities are found');
assert.equal(batch.stop_reason, 'limit');
let emptyScrolls = 0;
const exhausted = { waitForFunction: async () => {}, evaluate: async script => {
  if (script.includes('window.scrollTo')) { emptyScrolls++; return; }
  if (script.includes('return JSON.stringify(nodes.map')) return 'unchanged';
  return vm.runInNewContext(script, { document: { querySelectorAll: () => original } });
} };
const noNew = await collectNewRecommendations(exhausted, 10, exclude);
assert.equal(noNew.candidates.length, 0);
assert.equal(noNew.stop_reason, 'no_more');
assert.equal(emptyScrolls, 3, 'stop when repeated scrolls reveal no new cards');
const pairFrame = { evaluate: async script => vm.runInNewContext(script, { document: { querySelectorAll: () => [makeCard(' 同名 ', ' 本科0 ', 'changed-id'), makeCard('其他人', '本科0', 'other')] } }) };
const pairs = await readRecommendList(pairFrame, 10, exclude);
assert.equal(pairs.length, 1);
assert.equal(pairs[0].name, '其他人');
console.log('Incremental checks passed: compound identity, skip existing, bounded scrolling, same-name retention.');

// Simulate BOSS infinite scrolling: only ten cards exist until each scroll.
let loadedPages = 1;
let waits = 0;
const scrollingCards = Array.from({ length: 70 }, (_, i) => makeCard(`滚动人选${i}`, `本科 / ${20 + i}岁`, `scroll-${i}`));
const scrollingFrame = {
  waitForFunction: async () => { waits++; },
  evaluate: async script => {
    if (script.includes('window.scrollTo')) { loadedPages++; return; }
    if (script.includes('return JSON.stringify(nodes.map')) return `page-${loadedPages}`;
    return vm.runInNewContext(script, { document: { querySelectorAll: () => scrollingCards.slice(0, loadedPages * 10) } });
  },
};
const fifty = await collectNewRecommendations(scrollingFrame, 50, []);
assert.equal(fifty.candidates.length, 50);
assert.equal(loadedPages, 5, 'must scroll through five groups, then stop before loading a sixth');
assert.equal(waits, 4, 'wait for each dynamically loaded group');
assert.equal(fifty.stop_reason, 'limit');
await assert.rejects(collectNewRecommendations({ ...scrollingFrame, waitForFunction: async () => { throw new Error('browser disconnected'); } }, 50, fifty.candidates), /browser disconnected/);
console.log('Infinite-scroll check passed: 10 initial cards, 4 loading waits, exactly 50 new people; unrelated browser errors surface.');
