import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const require = createRequire(new URL('../../boss-cli/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const out = fileURLToPath(new URL('../../data/diagnostics/greeting-ui/', import.meta.url));
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1440, height: 1000 } });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const label = '产品实习生 · 北京 200-300元/天';
  const people = Array.from({ length: 12 }, (_, i) => ({ id: `local-${i}`, geekId: `geek-${i}`, name: `测试人选${i + 1}`, greeted: i === 2, baseInfo: '23岁 / 硕士', source_job: label, salary: '面议', expect: '北京 产品经理', highlights: ['数据分析'], advantage: '', experience: '', canGreet: true, hasHistoryChat: false, hasViewed: true }));
  let batch = null;
  let postCount = 0;
  let lastPayload;
  await page.setRequestInterception(true);
  page.on('request', async req => {
    const url = new URL(req.url());
    if (!url.pathname.startsWith('/api/')) {
      if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return req.continue();
      return req.abort();
    }
    const path = url.pathname;
    let result = {};
    if (path === '/api/health') result = { status: 'ok', service: 'ai-hr-backend', version: '0.4.1' };
    else if (path === '/api/local/jobs') result = { jobs: [], total: 0 };
    else if (path === '/api/local/recommendations/jobs') result = { jobs: [{ id: 'job', label, available: true, count: people.length }] };
    else if (path === '/api/local/recommendations') result = { job_label: label, limit: 20, candidates: people, captured_at: new Date().toISOString() };
    else if (path === '/api/local/recommendations/recycle-bin') result = { candidates: [] };
    else if (path.startsWith('/api/local/tables/')) result = { revision: 0, values: {}, config: { fields: [], active_view: 'default', views: [{ id: 'default', name: '全部记录', columns: [], filters: [], sorts: [], order: [], collapsed: [], group: '', conjunction: 'and' }] } };
    else if (path === '/api/debug/status') result = { active_cli: null, latest_sync: null, diagnostics: { events: [], timings: [] }, runtime: {}, config: {} };
    else if (path === '/api/agent/policy') result = { writes_enabled: false, emergency_stop: false };
    else if (path === '/api/ai/config') result = { base_url: '', model: '', has_key: false, prompt: '', temperature: null, max_tokens: 4096, timeout_seconds: 120, token_parameter: 'max_tokens' };
    else if (path === '/api/ai/data') result = { jobs: [], candidates: [] };
    else if (path === '/api/ai/runs') result = [];
    else if (path === '/api/recommendation-greetings') {
      if (req.method() === 'POST') {
        postCount++; lastPayload = JSON.parse(req.postData());
        batch = { id: lastPayload.request_id, job_key: 'job', job_label: label, status: 'running', total: lastPayload.candidate_ids.length, completed: 0, sent: 0, already: 0, created_at: new Date().toISOString(), items: lastPayload.candidate_ids.map((id, i) => ({ candidate_id: id, name: people.find(p => p.id === id).name, base_info: '23岁 / 硕士', status: i ? 'pending' : 'executing', detail: '正在核对身份' })) };
        result = batch;
      } else result = batch ? [batch] : [];
    }
    await req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify(result) });
  });
  async function click(text) {
    const handle = await page.waitForFunction(t => [...document.querySelectorAll('button')].find(b => b.innerText.replaceAll(' ', '') === t.replaceAll(' ', '') && b.getClientRects().length && !b.disabled), {}, text);
    await handle.asElement().click(); await handle.dispose();
  }
  async function modalSettled() {
    await page.waitForFunction(() => document.getAnimations().filter(a => a.effect?.target instanceof Element && a.effect.target.closest('.ant-modal')).every(a => a.playState !== 'running'));
  }
  await page.goto('http://127.0.0.1:5173');
  await click('推荐牛人');
  await page.waitForSelector('.recommendation-table .ant-table-row');
  const badge = id => `.recommendation-table [data-row-key="${id}"] .greeting-status`;
  assert.equal(await page.$eval(badge('local-0'), el => el.textContent), '否');
  assert.equal(await page.$eval(badge('local-2'), el => el.textContent), '是', 'Prior successful greetings load from the database');
  assert.equal(await page.$eval(badge('local-2'), el => getComputedStyle(el).color), 'rgb(36, 131, 77)');
  assert.equal(await page.$eval(badge('local-0'), el => getComputedStyle(el).color), 'rgb(139, 150, 148)');
  assert.equal(postCount, 0);
  await page.click('.recommendation-table .ant-table-row[data-row-key="local-0"] input[type="checkbox"]');
  await page.click('.recommendation-table .ant-pagination-item-2');
  await page.click('.recommendation-table .ant-table-row[data-row-key="local-10"] input[type="checkbox"]');
  await click('一键打招呼（2）');
  await page.waitForSelector('.greeting-confirm-list');
  assert.equal(postCount, 0, 'Opening confirmation does not send');
  assert.match(await page.$eval('.greeting-confirm-list', el => el.innerText), /测试人选11/);
  await modalSettled();
  await page.screenshot({ path: resolve(out, 'confirmation.png'), fullPage: true });
  await click('取消');
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal-mask')].some(el => el.getClientRects().length));
  assert.equal(postCount, 0, 'Cancel does not send');
  await click('一键打招呼（2）');
  await click('确认向 2 人打招呼');
  await page.waitForSelector('.greeting-history');
  assert.equal(postCount, 1);
  assert.deepEqual(lastPayload.candidate_ids, ['local-0', 'local-10']);
  assert.equal(lastPayload.job_key, 'job');
  assert.equal(lastPayload.confirmed, true);
  await click('关闭');
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal-mask')].some(el => el.getClientRects().length));
  assert.equal(await page.$eval('.recommendations-heading .ant-btn-primary', el => el.disabled), true);
  assert.equal(await page.$eval(badge('local-10'), el => el.textContent), '否', 'Submitting alone must not mark a greeting sent');
  await click('沟通候选人');
  await page.waitForFunction(() => document.querySelector('.workspace-task-progress')?.innerText.includes('正在打招呼'));
  await page.reload();
  await page.waitForFunction(() => document.querySelector('.workspace-task-progress')?.innerText.includes('正在打招呼'));
  assert.equal(postCount, 1, 'Reload must not send again');
  await click('推荐牛人');
  await page.waitForSelector('.greeting-progress');
  batch = { ...batch, status: 'completed', completed: 2, sent: 1, items: batch.items.map((i, n) => ({ ...i, status: n ? 'not_found' : 'sent', detail: n ? '推荐列表已刷新，未找到此人，未点击' : 'BOSS 已显示继续沟通' })) };
  await page.waitForFunction(() => document.querySelector('.greeting-progress')?.innerText.includes('已发送 1 人'));
  await page.waitForFunction(selector => document.querySelector(selector)?.textContent === '是', {}, badge('local-0'));
  await page.click('.recommendation-table .ant-pagination-item-2');
  assert.equal(await page.$eval(badge('local-10'), el => el.textContent), '否', 'Failed rows stay gray');
  await page.click('.recommendation-table .ant-pagination-item-1');
  await page.screenshot({ path: resolve(out, 'desktop.png'), fullPage: true });
  await click('查看明细');
  await page.waitForFunction(() => [...document.querySelectorAll('.ant-modal')].some(el => el.innerText.includes('推荐列表已刷新')));
  await modalSettled();
  await page.screenshot({ path: resolve(out, 'results.png'), fullPage: true });
  await click('关闭');
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal-mask')].some(el => el.getClientRects().length));
  // The API persists successful sends independently of the recent-task history.
  people[0].greeted = true;
  batch = null;
  await page.reload();
  await click('推荐牛人');
  await page.waitForSelector(badge('local-0'));
  assert.equal(await page.$eval(badge('local-0'), el => el.textContent), '是', 'Reload preserves the sent flag without task history');
  assert.equal(postCount, 1, 'Refreshing the status must not resend');
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(out, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false);
  assert.deepEqual(errors, []);
  console.log('Greeting UI passed: selection, confirmation, progress, live yes/no status, green/gray colors, history, failure handling, reload persistence, mobile. No real API calls.');
} finally { await browser.close(); }
