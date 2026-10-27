import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(new URL('../../boss-cli/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');

// Isolated browser + mock APIs: never edit the user's actual saved table settings.
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1440, height: 1000, deviceScaleFactor: 1.25 } });
try {
  const page = await browser.newPage();
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  let state = { revision: 0, values: {}, config: { fields: [], active_view: 'default', views: [{ id: 'default', name: '全部记录', columns: [{ id: 'name', name: '', width: 150, hidden: false, fixed: 'left' }, { id: 'base', name: '', width: 175, hidden: false, fixed: '' }], filters: [], sorts: [], order: ['test'], collapsed: [], group: '', conjunction: 'and' }] } };
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) return url.hostname === '127.0.0.1' || url.protocol === 'data:' ? req.continue() : req.abort();
    const path = url.pathname;
    let result = {}, status = 200;
    if (path === '/api/health') result = { status: 'ok', version: 'test' };
    else if (path === '/api/local/jobs') result = { jobs: [], total: 0 };
    else if (path === '/api/local/recommendations/jobs') result = { jobs: [{ id: 'job', label: '测试岗位', available: true, count: 1 }] };
    else if (path === '/api/local/recommendations') result = { candidates: [{ id: 'test', geekId: 'test', name: '测试人选', baseInfo: '硕士', highlights: [], source_job: '测试岗位', greeted: false }], captured_at: null };
    else if (path === '/api/local/recommendations/recycle-bin') result = { candidates: [] };
    else if (path === '/api/recommendation-greetings' || path === '/api/ai/runs') result = [];
    else if (path === '/api/ai/data') result = { jobs: [], candidates: [] };
    else if (path === '/api/ai/config') result = { base_url: '', model: '', has_key: false, prompt: '', temperature: null, max_tokens: 4096, timeout_seconds: 120, token_parameter: 'max_tokens' };
    else if (path.startsWith('/api/local/tables/')) {
      if (req.method() === 'PUT') {
        const payload = JSON.parse(req.postData());
        writes.push(payload);
        const valid = payload.config.views.every(v => v.columns.every(c => Number.isInteger(c.width) && c.width >= 80 && c.width <= 800));
        if (!valid) { status = 422; result = { detail: 'width must be an integer between 80 and 800' }; }
        else { state = { ...state, config: payload.config, revision: state.revision + 1 }; result = state; }
      } else result = state;
    } else if (path === '/api/debug/status') result = { active_cli: null, latest_sync: null, diagnostics: { events: [], timings: [] }, runtime: {}, config: {} };
    else if (path === '/api/agent/policy') result = { writes_enabled: false, emergency_stop: false };
    await req.respond({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  async function click(text) {
    const button = await page.waitForFunction(t => [...document.querySelectorAll('button')].find(b => b.getClientRects().length && !b.disabled && b.innerText.replaceAll(' ', '') === t.replaceAll(' ', '')), {}, text);
    await button.asElement().click(); await button.dispose();
  }
  await page.goto('http://127.0.0.1:5173');
  await click('推荐牛人');
  const selector = '.recommendations-page [aria-label="调整姓名列宽"]';
  await page.waitForSelector(selector);
  async function resize(delta) {
    const previousWrites = writes.length;
    const handle = await page.$(selector);
    const box = await handle.boundingBox();
    await handle.evaluate(el => el.addEventListener('pointerdown', event => { window.resizeStart = event.clientX; window.resizePointer = event.pointerId; }, { once: true }));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    // A real pointer capture with a fractional move reproduces zoomed-screen input.
    await handle.evaluate((el, amount) => el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerId: window.resizePointer, clientX: window.resizeStart + amount, buttons: 1 })), delta);
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('.recommendations-page .table-save-status')?.textContent.includes('已保存到本地') || !!document.querySelector('.recommendations-page .table-error'));
    assert.equal(writes.length, previousWrites + 1);
    assert.equal(await page.$('.recommendations-page .table-error'), null, 'Fractional pointer movement must save without validation errors');
    assert(writes.at(-1).config.views.every(v => v.columns.every(c => Number.isInteger(c.width))));
    return state.config.views[0].columns.find(c => c.id === 'name').width;
  }
  assert.equal(await resize(-27.66668701171875), 122);
  assert.equal(state.config.views[0].columns.find(c => c.id === 'base').width, 175);
  assert.deepEqual(state.config.views[0].order, ['test']);
  assert.equal(await resize(-900.25), 80);
  assert.equal(await resize(900.75), 800);
  assert.equal(await resize(-677.5), 123);
  await page.reload(); await click('推荐牛人');
  await page.waitForSelector(selector);
  await click('字段 9');
  const input = await page.waitForSelector('input[aria-label="姓名列宽"]', { visible: true });
  await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.target instanceof Element && a.effect.target.closest('.ant-drawer')).every(a => a.playState !== 'running'));
  assert.equal(await input.evaluate(el => el.value), '123', 'Width survives reload');
  await input.click({ clickCount: 3 });
  await page.keyboard.type('122.333');
  await click('保存设置');
  await page.waitForFunction(() => !document.querySelector('.ant-drawer-open'));
  assert.equal(state.config.views[0].columns.find(c => c.id === 'name').width, 122, 'Manual width entry also saves integer pixels');
  assert.deepEqual(errors, []);
  console.log('Resize regression passed: fractional pointer coordinates, bounds, unrelated settings preserved, reload persistence, manual decimal entry. No real settings modified.');
} finally { await browser.close(); }
