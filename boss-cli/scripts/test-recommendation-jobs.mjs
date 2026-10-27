import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readRecommendList, readRecommendJobOptions, selectExactRecommendJob } from '../dist/toolset/recommend.js';
let touched = 0;
const cards = Array.from({ length: 60 }, (_, i) => ({
  querySelector(selector) { assert.ok(i < 50); touched = Math.max(touched, i + 1); return selector.includes('.name') ? { textContent: `Person ${i}` } : null; },
  querySelectorAll() { assert.ok(i < 50); return []; }, matches() { return false; }, getAttribute() { return String(i); }, classList: { contains() { return false; } },
}));
assert.equal((await readRecommendList({ evaluate: async script => vm.runInNewContext(script, { document: { querySelectorAll: () => cards } }) }, 50)).length, 50);
assert.equal(touched, 50);
let current = '财务 _ 北京 240-360元/天';
let clicks = [];
class Element { scrollIntoView() {} click() {} }
class Input extends Element { value = ''; focus() {} dispatchEvent() {} }
const input = new Input();
const host = new Element();
Object.defineProperty(host, 'textContent', { get: () => current });
const makeJob = label => Object.assign(new Element(), { textContent: label, querySelector: () => ({ textContent: label }), click: () => { current = label; clicks.push(label); } });
let jobs = [makeJob('财务 _ 北京 240-360元/天'), makeJob('财务 _ 上海 240-360元/天')];
const frame = {
  evaluate: async script => vm.runInNewContext(script, { document: { querySelector: sel => sel.includes('chat-job-search') ? input : host, querySelectorAll: () => jobs }, HTMLElement: Element, HTMLInputElement: Input, Event: class {} }),
  waitForFunction: async () => {},
};
assert.equal((await readRecommendJobOptions(frame)).length, 2);
await selectExactRecommendJob(frame, '财务 _ 上海 240-360元/天');
assert.deepEqual(clicks, ['财务 _ 上海 240-360元/天']);
await selectExactRecommendJob(frame, current);
assert.equal(clicks.length, 1, 'same-job screenshot must keep currently loaded cards');
await assert.rejects(selectExactRecommendJob(frame, '财务'), /岗位不存在或完整标签重复/);
jobs = [makeJob('重复岗位'), makeJob('重复岗位')];
await assert.rejects(selectExactRecommendJob(frame, '重复岗位'), /岗位不存在或完整标签重复/);
console.log('50-person cap and exact recommendation job selection passed without any browser connection.');
