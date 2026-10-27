import assert from 'node:assert/strict';
import vm from 'node:vm';
import { openChatScript } from '../dist/toolset/communication.js';

let clicked = '';
const row = sourceId => ({
  getAttribute: key => key === 'data-id' ? sourceId : null,
  querySelector: selector => ({ textContent: ({ '.geek-name': '同名', '.source-job': '同岗位', '.push-text': `消息-${sourceId}`, '.time': '今天' })[selector] }),
  click: () => { clicked = sourceId; },
});
const first = row('786184743-0'), second = row('786172528-0');
const context = { document: {
  querySelectorAll: () => [first, second, row('786172528-0')],
  querySelector: selector => ({ '.geek-item.selected': first, '.base-info-single-container .name-box': { textContent: '同名' }, '.chat-message-list': { innerHTML: '上一人的会话内容' } })[selector],
} };
const result = vm.runInNewContext(openChatScript({ id: 'local-b', sourceId: '786172528-0', name: '同名', job: '同岗位' }), context);
assert.equal(clicked, '786172528-0', 'same-name target must be selected by ID');
assert.equal(result.message, '消息-786172528-0');
assert.equal(result.previousChat, '上一人的会话内容', 'same-name switches must wait for the old transcript to change');
assert.throws(() => vm.runInNewContext(openChatScript({ id: 'local', sourceId: 'missing', name: '同名', job: '同岗位' }), context));
assert.throws(() => vm.runInNewContext(openChatScript({ id: 'local', sourceId: '786172528-0', name: '姓名变了', job: '同岗位' }), context));
console.log('Chat targeting passed: exact ID, same-name isolation, duplicate DOM and stale transcript protection.');
