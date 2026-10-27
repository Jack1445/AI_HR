import assert from 'node:assert/strict';
import puppeteer from 'puppeteer-core';
import { greetExactOnPage } from '../dist/toolset/recommend-greet-exact.js';

// Isolated HTML fixtures only. Never connect to a logged-in BOSS browser.
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const target = { geekId: 'id-1', name: '同名', baseInfo: '23岁 / 本科 / 刚刚活跃', jobLabel: '测试岗位 北京' };
try {
  const page = await browser.newPage();
  const fixture = async (change = '') => {
    await page.setContent(`<div class="job-selecter-wrap"><span class="ui-dropmenu-label">测试岗位 北京</span></div>
      ${['id-0', 'id-1'].map(id => `<div class="candidate-card-wrap"><div class="card-inner" data-geekid="${id}"><span class="name">同名</span><div class="base-info"><span>23岁</span><span>本科</span><span>今日活跃</span></div><div class="button-chat-wrap"><button class="btn btn-greet" onclick="window.clicked.push('${id}'); this.textContent='继续沟通'">打招呼</button></div></div></div>`).join('')}
      <script>window.clicked=[];${change}</script>`);
  };
  const run = () => greetExactOnPage(page, page.mainFrame(), target, 400);
  await fixture();
  let result = await run();
  assert.equal(result.outcome, 'sent');
  assert.equal(result.attempted, true);
  assert.deepEqual(await page.evaluate('window.clicked'), ['id-1']);
  assert.equal((await run()).outcome, 'already');
  assert.deepEqual(await page.evaluate('window.clicked'), ['id-1']);
  for (const [mutation, outcome] of [
    ["document.querySelector('.ui-dropmenu-label').textContent='其他岗位'", 'mismatch'],
    ["document.querySelector('[data-geekid=\"id-1\"] .name').textContent='另一人'", 'mismatch'],
    ["document.querySelector('[data-geekid=\"id-1\"] .base-info span').textContent='24岁'", 'mismatch'],
    ["document.querySelector('[data-geekid=\"id-1\"]').remove()", 'not_found'],
    ["document.querySelector('[data-geekid=\"id-1\"] button').disabled=true", 'blocked'],
    ["document.querySelector('[data-geekid=\"id-1\"] button').style.display='none'", 'blocked'],
    ["document.body.insertAdjacentHTML('beforeend','<div class=\"boss-popup__wrapper\">打招呼次数上限</div>')", 'blocked'],
  ]) {
    await fixture(mutation);
    result = await run();
    assert.equal(result.outcome, outcome, mutation);
    assert.equal(result.attempted, false);
    assert.deepEqual(await page.evaluate('window.clicked'), []);
  }
  await fixture(`document.querySelector('[data-geekid="id-1"] button').onclick=()=>{window.clicked.push('id-1')}`);
  result = await run();
  assert.equal(result.outcome, 'clicked');
  assert.equal(result.attempted, true);
  assert.deepEqual(await page.evaluate('window.clicked'), ['id-1']);
  await fixture(`document.querySelector('[data-geekid="id-1"] button').addEventListener('click',()=>setTimeout(()=>document.body.insertAdjacentHTML('beforeend','<div class="boss-popup__wrapper">额度不足</div>'),100))`);
  result = await run();
  assert.equal(result.outcome, 'blocked');
  assert.equal(result.attempted, true);
  console.log('Exact greeting fixtures passed: identity, job, basic info, visibility, already, single click, unknown, delayed platform rejection. No live messages sent.');
} finally { await browser.close(); }
