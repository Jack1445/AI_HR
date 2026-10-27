import assert from 'node:assert/strict';
import vm from 'node:vm';
import { chatDate, validateSince, walkChatHistory, beijingToday } from '../dist/toolset/chat-history.js';

assert.equal(chatDate('10月01日', '2026-10-26'), '2026-10-01');
assert.equal(chatDate('昨天 13:45', '2026-10-26'), '2026-10-25');
assert.equal(chatDate('周日', '2026-10-26'), '2026-10-25');
assert.equal(chatDate('星期一', '2026-10-26'), '2026-10-19');
assert.equal(chatDate('12月31日', '2026-01-02'), '2025-12-31');
assert.equal(chatDate('2025年12月31日', '2026-10-26'), '2025-12-31');
assert.equal(chatDate('2026-02-30', '2026-10-26'), null);
assert.equal(chatDate('未知时间', '2026-10-26'), null);
assert.equal(beijingToday(new Date('2026-09-30T17:00:00Z')), '2026-10-01');
assert.throws(() => validateSince('2026-02-30', '2026-10-26'));
assert.throws(() => validateSince('2026-10-27', '2026-10-26'));

function fixture({ virtual = false, stuck = false, sameName = false, clone = false, missingId = false, error = false } = {}) {
  let clock = 1000, loaded = 10, pendingAt = 0;
  const all = Array.from({ length: 54 }, (_, i) => ({ sourceId: `chat-${i}`, name: `测试${i}`, job: `岗位${i % 3}`, time: i === 0 ? '2020-01-01' : i === 53 ? '2020-02-01' : '2021-10-01', message: '测试', unreadCount: 0 }));
  all[30].time = '未知';
  if (sameName) { all[1].name = all[0].name; all[1].job = all[0].job; }
  if (clone) all[1] = { ...all[0] };
  if (missingId) all[1].sourceId = '';
  const area = { innerText: error ? '加载失败' : '', querySelectorAll: () => pendingAt || stuck ? [{ getBoundingClientRect: () => ({ height: 10 }), getAttribute: name => name === 'aria-busy' ? 'true' : null }] : [] };
  const scroller = { parentElement: area, clientHeight: 300, scrollHeight: 1000, scrollTop: 0, dispatchEvent: () => { if (scroller.scrollTop + 300 >= scroller.scrollHeight && loaded < all.length && !pendingAt) pendingAt = clock; } };
  let top = 0;
  Object.defineProperty(scroller, 'scrollTop', { get: () => top, set: value => { top = Math.max(0, Math.min(value, scroller.scrollHeight - scroller.clientHeight)); } });
  const rows = () => {
    if (pendingAt && clock - pendingAt >= 3500) { loaded = Math.min(all.length, loaded + 10); scroller.scrollHeight = loaded * 100; pendingAt = 0; }
    const start = virtual ? Math.floor(scroller.scrollTop / 100) : 0;
    return all.slice(start, virtual ? Math.min(loaded, start + 5) : loaded).map(row => ({ parentElement: scroller, getAttribute: key => key === 'data-id' ? row.sourceId : null, querySelector: selector => ({ textContent: ({ '.geek-name': row.name, '.source-job': row.job, '.time': row.time, '.push-text': row.message, '.badge-count': '0' })[selector] }) }));
  };
  scroller.querySelectorAll = selector => selector === '.geek-item' ? rows() : [];
  // Actual BOSS layout: .user-list uses overflow:hidden and native scrollTop.
  // Its ancestors can also be clipped; they must never become the scroll target.
  const context = { document: { querySelectorAll: selector => selector === '.user-list' ? [scroller] : rows() }, getComputedStyle: () => ({ overflowY: 'hidden' }), Event: class {} };
  // Real injected script executes against a fake scrolling DOM, no BOSS account.
  const page = { evaluate: script => Promise.resolve(vm.runInNewContext(script, context)) };
  return { page, options: { now: () => clock, pause: async () => { clock += 500; }, deadline: 120_000 }, all };
}
for (const virtual of [false, true]) {
  const f = fixture({ virtual });
  const result = await walkChatHistory(f.page, { ...f.options, since: '2021-10-01' });
  assert.equal(result.scanned, 54, 'must load beyond the initial ten, including virtualized rows');
  assert.equal(result.rows.length, 52, 'inclusive start date; pinned old row must not end scanning');
  assert.equal(result.undated, 1);
  assert.equal(result.stop_reason, 'stable_bottom');
  assert.ok(result.rows.some(r => r.name === '测试52'));
}
const f = fixture({ virtual: true });
assert.equal((await walkChatHistory(f.page, { ...f.options, target: { sourceId: 'chat-45', name: '测试45', job: '岗位0' } })).stop_reason, 'target_found');
for (const config of [{ stuck: true }, { error: true }]) {
  const f = fixture(config);
  await assert.rejects(walkChatHistory(f.page, f.options));
}
console.log('Chat history: 54 rows, delayed lazy loading, virtual list, inclusive dates, pinned old rows, unknown dates, historical targeting, timeout and ambiguity checks passed.');

const names = fixture({ sameName: true });
const distinct = await walkChatHistory(names.page, names.options);
assert.equal(distinct.rows.length, 54, 'same name/job with different BOSS IDs must remain separate');
assert.equal(distinct.rows.filter(row => row.name === '测试0' && row.job === '岗位0').length, 2);
assert.equal(distinct.rows[0].legacyMatchUnique, false);
assert.equal(distinct.rows[1].legacyMatchUnique, false);
const clone = fixture({ clone: true });
assert.equal((await walkChatHistory(clone.page, clone.options)).rows.length, 53, 'same BOSS ID rendered twice counts once');
const missing = fixture({ missingId: true });
const incomplete = await walkChatHistory(missing.page, missing.options);
assert.equal(incomplete.rows.length, 53);
assert.equal(incomplete.unidentified, 1, 'missing identity must be reported without aborting everyone else');
console.log('Identity checks passed: same-name distinct IDs, repeated DOM, legacy ambiguity and missing-ID isolation.');
