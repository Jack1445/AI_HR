import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

// Isolated Chrome profile + intercepted APIs. No real API credentials or candidate data.
const require = createRequire(new URL('../../boss-cli/package.json', import.meta.url));
const puppeteer = require('puppeteer-core');
const out = resolve(fileURLToPath(new URL('../../data/diagnostics/ai-ui/', import.meta.url)));
await mkdir(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, defaultViewport: { width: 1440, height: 1000 } });
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  let config = { base_url: 'http://localhost:1234/v1', model: 'local-vision-model', temperature: null, max_tokens: 4096, token_parameter: 'max_completion_tokens', send_session_id: false, timeout_seconds: 120, prompt: '请根据项目经历分析岗位契合点，给出依据与需要追问的问题。', has_key: false };
  let run = null;
  let finish = false;
  let runCalls = 0;
  let previewCalls = 0;
  let modelCalls = 0;
  let testCalls = 0;
  let modelFailure = false;
  const candidates = Array.from({ length: 7 }, (_, i) => ({ id: `test-${i}`, name: `测试候选人 ${i + 1}`, summary: '硕士 / Python 项目 / 数据分析', job: 'AI 产品实习生 · 北京', has_image: false }));
  await page.setRequestInterception(true);
  page.on('request', async request => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      if (url.hostname === '127.0.0.1' || url.protocol === 'data:') return request.continue();
      return request.abort();
    }
    const path = url.pathname;
    const payload = request.postData() ? JSON.parse(request.postData()) : null;
    let result = {};
    let status = 200;
    if (path === '/api/health') result = { status: 'ok', service: 'ai-hr-backend', version: '0.4.0' };
    else if (path === '/api/local/jobs') result = { jobs: [], total: 0 };
    else if (path === '/api/recommendation-greetings') result = [];
    else if (path === '/api/local/recommendations/jobs') result = { jobs: [], current_job_key: '' };
    else if (path === '/api/local/recommendations') result = { candidates: [], job_label: '', limit: 20 };
    else if (path.startsWith('/api/local/tables/')) result = { revision: 0, values: {}, config: { fields: [], active_view: 'default', views: [{ id: 'default', name: '全部记录', columns: [], filters: [], sorts: [], order: [], collapsed: [], group: '', conjunction: 'and' }] } };
    else if (path === '/api/debug/status') result = { active_cli: null, latest_sync: null, diagnostics: { events: [], timings: [] }, runtime: {}, config: {} };
    else if (path === '/api/agent/policy') result = { writes_enabled: false, emergency_stop: false };
    else if (path === '/api/ai/config') {
      if (request.method() === 'PUT') { const { api_key, clear_key, ...fields } = payload; config = { ...fields, has_key: false }; }
      result = config;
    } else if (path === '/api/ai/models') {
      modelCalls++;
      assert.equal(request.method(), 'POST');
      assert.equal(payload, null, 'Catalog request must not send candidate data or credentials from the browser');
      if (modelFailure) { status = 400; result = { detail: '平台未提供此模型列表接口，请检查 Base URL 或手动填写模型 ID' }; }
      else result = { models: [{ id: 'local-text-model' }, { id: 'local-vision-model' }], endpoint: `${config.base_url}/models` };
    } else if (path === '/api/ai/data') result = { jobs: [{ id: 'job', label: 'AI 产品实习生 · 北京', count: 7 }], candidates };
    else if (path === '/api/ai/test') { testCalls++; result = { ok: true, elapsed_seconds: 0.42, usage: {} }; }
    else if (path === '/api/ai/preview') { previewCalls++; result = { items: payload.candidate_ids.map(id => ({ candidate_id: id, name: candidates.find(c => c.id === id).name, data: { 项目: '本地测试项目' }, image_id: null })) }; }
    else if (path === '/api/ai/runs') {
      if (request.method() === 'POST') {
        runCalls++;
        run = { id: 'test-run', status: 'running', model: config.model, created_at: new Date().toISOString(), total: payload.candidate_ids.length, completed: 0, failed: 0, error: '', selection: payload, config: { ...config }, items: payload.candidate_ids.map(id => ({ candidate_id: id, name: candidates.find(c => c.id === id).name, status: 'running', data: { 项目: '本地测试项目' }, image_id: null, output: '', error: '', usage: {}, elapsed_seconds: null })) };
        result = run;
      } else result = run ? [run] : [];
    } else if (path === '/api/ai/runs/test-run') {
      if (finish) { run.status = 'success'; run.completed = run.total; run.items = run.items.map(i => ({ ...i, status: 'success', output: '契合点：项目中有 Python 数据分析实践。\n资料依据：本地测试项目。\n待确认：项目中的具体职责与结果。', elapsed_seconds: 1.2, usage: { total_tokens: 320 } })); }
      result = run;
    }
    await request.respond({ status, contentType: 'application/json', body: JSON.stringify(result) });
  });
  async function click(text) {
    const handle = await page.waitForFunction(t => [...document.querySelectorAll('button')].find(b => b.innerText.replaceAll(' ', '') === t.replaceAll(' ', '') && b.getClientRects().length && !b.disabled), {}, text).catch(async error => {
      await page.screenshot({ path: resolve(out, 'failure.png'), fullPage: true });
      console.log(JSON.stringify({ target: text, errors, body: await page.evaluate(() => document.body.innerText.slice(0, 3000)) }));
      throw error;
    });
    await handle.asElement().click();
    await handle.dispose();
  }
  await page.goto('http://127.0.0.1:5173');
  await click('AI 管理');
  await page.waitForSelector('.ai-people-table .ant-table-row');
  await page.waitForFunction(() => document.querySelector('.ai-model-tools')?.textContent.includes('已获取 2 个模型'));
  assert.equal(modelCalls, 1);
  assert.equal(testCalls, 0);
  assert.equal(runCalls, 0);
  await page.click('.ai-advanced .ant-collapse-header');
  await page.waitForSelector('[aria-label="发送会话标识"]', { visible: true });
  await page.click('[aria-label="发送会话标识"]');
  await click('保存设置与提示词');
  await page.waitForFunction(() => document.querySelector('.ai-main .ai-card-title .ant-tag')?.textContent === '已保存');
  assert.equal(config.send_session_id, true);
  await page.click('[aria-label="选择 AI 模型"]');
  await page.type('[aria-label="选择 AI 模型"]', 'text');
  await page.waitForSelector('.ant-select-item-option[title="local-text-model"]');
  await page.click('.ant-select-item-option[title="local-text-model"]');
  await page.waitForFunction(() => document.querySelector('.ai-model-tools') && !document.querySelector('[aria-label="选择 AI 模型"]').disabled);
  assert.equal(config.model, 'local-text-model', 'Choosing from the catalog must immediately save the model');
  await page.reload();
  await click('AI 管理');
  await page.waitForFunction(() => document.querySelector('.ai-model-tools')?.textContent.includes('已获取 2 个模型'));
  assert.equal(modelCalls, 2);
  assert.equal(config.send_session_id, true, 'Session compatibility option must survive reload');
  assert.equal(await page.$eval('.ai-connection .ant-select-selection-item', el => el.textContent), 'local-text-model');
  assert.equal(runCalls, 0);
  modelFailure = true;
  await click('刷新模型列表');
  await page.waitForSelector('.ai-model-error');
  assert.equal(config.model, 'local-text-model', 'Catalog failures must retain the saved model');
  await click('手动填写模型');
  await page.click('[aria-label="手动模型 ID"]', { clickCount: 3 });
  await page.type('[aria-label="手动模型 ID"]', 'manual-vision');
  await click('保存设置与提示词');
  await page.waitForFunction(() => document.querySelector('.ai-main .ai-card-title .ant-tag')?.textContent === '已保存');
  assert.equal(config.model, 'manual-vision');
  await click('返回下拉选择');
  modelFailure = false;
  await click('保存并获取模型列表');
  await page.waitForFunction(() => document.querySelector('.ai-model-tools')?.textContent.includes('已获取 2 个模型'));
  assert.match(await page.$eval('.ai-connection .ant-select-selection-item', el => el.textContent), /manual-vision.*列表未返回/);
  await page.type('[aria-label="API 基础地址"]', '/proxy');
  await page.waitForFunction(() => !document.querySelector('.ai-model-tools')?.textContent.includes('已获取'));
  await page.click('[aria-label="选择 AI 模型"]');
  assert.equal(await page.$('.ant-select-item-option[title="local-text-model"]'), null, 'Changing the endpoint must discard stale catalog entries');
  await page.keyboard.press('Escape');
  await page.click('[aria-label="API 基础地址"]', { clickCount: 3 });
  await page.type('[aria-label="API 基础地址"]', 'http://localhost:1234/v1');
  await click('保存并获取模型列表');
  await page.waitForFunction(() => document.querySelector('.ai-model-tools')?.textContent.includes('已获取 2 个模型'));
  assert.equal(testCalls, 0, 'Catalog retrieval must never trigger a billed connection test');
  assert.equal(config.send_session_id, false, 'Changing the service address must reset provider-specific compatibility');
  await click('保存并测试连接');
  await page.waitForSelector('.ai-connected');
  await page.type('textarea[aria-label="AI 分析提示词"]', '\n测试附加要求：引用具体项目证据。');
  await page.click('.ai-people-table .ant-table-row input[type="checkbox"]');
  await click('预览发送资料');
  await page.waitForSelector('.ant-modal');
  assert.equal(runCalls, 0);
  assert.equal(previewCalls, 1);
  await click('关闭预览');
  await page.waitForFunction(() => ![...document.querySelectorAll('.ant-modal-mask')].some(el => el.getClientRects().length));
  await click('保存并开始分析');
  await page.waitForSelector('.ai-result-people button');
  assert.match(config.prompt, /测试附加要求/);
  assert.equal(runCalls, 1);
  assert.equal(run.total, 1);
  await click('沟通候选人');
  await page.waitForFunction(() => document.querySelector('.workspace-task-progress')?.innerText.includes('AI 分析正在后台进行'));
  await page.reload();
  await click('AI 管理');
  await page.waitForSelector('.ai-result-people button');
  assert.equal(runCalls, 1, 'Reload must not repeat the paid request');
  finish = true;
  await page.waitForSelector('.ai-answer');
  await page.screenshot({ path: resolve(out, 'desktop.png'), fullPage: true });
  await page.setViewport({ width: 390, height: 844 });
  await page.screenshot({ path: resolve(out, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2), false, 'Mobile layout should not overflow the page');
  assert.deepEqual(errors, []);
  console.log('AI UI passed: automatic model list, searchable selection/save/reload, unsupported provider/manual entry, stale catalog invalidation, no automatic inference, config/test, prompt, preview, manual run, progress, responsive layout. Screenshots:', out);
} finally {
  await browser.close();
}
