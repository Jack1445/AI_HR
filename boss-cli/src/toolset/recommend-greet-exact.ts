import type { Frame, Page } from 'puppeteer-core';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { closeCResumePanel } from '../common/c_resume_capture.js';
import { detectBossPaywallPopup } from '../common/boss_paywall_popup.js';
import { ensureInRecommendPage, selectExactRecommendJob } from './recommend.js';

export interface ExactGreetTarget { geekId: string; name: string; baseInfo: string; jobLabel: string }
export interface ExactGreetResult { version: 1; geek_id: string; job_label: string; attempted: boolean; outcome: 'sent' | 'already' | 'clicked' | 'not_found' | 'mismatch' | 'blocked'; detail: string }

// Validate all identity fields and the job again in the same DOM turn as the click.
export function exactGreetScript(target: ExactGreetTarget, click: boolean): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const norm = value => (value ?? '').replace(/\\s+/g, ' ').trim();
    const stableInfo = value => value.split('/').map(norm).filter(v => v && !/活跃|在线|离线/.test(v)).join(' / ');
    const job = norm(document.querySelector('.job-selecter-wrap .ui-dropmenu-label')?.textContent);
    if (job !== norm(target.jobLabel)) return { outcome: 'mismatch', detail: '当前岗位与所选岗位不一致，未点击' };
    const matches = Array.from(document.querySelectorAll('.card-inner')).filter(el => (el.getAttribute('data-geekid') ?? el.getAttribute('data-geek') ?? '') === target.geekId);
    if (matches.length !== 1) return { outcome: 'not_found', detail: '当前推荐列表无法唯一定位这个 ID，未点击；列表可能已经刷新' };
    const card = matches[0].closest('.candidate-card-wrap, .card-item, .geek-card');
    if (!card || norm(card.querySelector('.name')?.textContent) !== norm(target.name)) return { outcome: 'mismatch', detail: '候选人 ID 与姓名不一致，未点击' };
    const info = Array.from(card.querySelectorAll('.base-info span')).map(el => norm(el.textContent)).filter(Boolean).join(' / ');
    if (!stableInfo(target.baseInfo) || stableInfo(info) !== stableInfo(target.baseInfo)) return { outcome: 'mismatch', detail: '候选人基本信息与本地记录不一致，未点击' };
    const controls = Array.from(card.querySelectorAll('.button-chat-wrap .btn'));
    if (controls.some(el => /^(继续沟通|已打招呼|已沟通)$/.test(norm(el.textContent)))) return { outcome: 'already', detail: 'BOSS 已显示已招呼或继续沟通，无需重复点击' };
    const btn = card.querySelector('.button-chat-wrap .btn.btn-greet');
    if (!(btn instanceof HTMLElement) || norm(btn.textContent) !== '打招呼') return { outcome: 'blocked', detail: '没有可确认的打招呼按钮，未点击' };
    if (/disabled|forbid|ban/i.test(btn.className) || btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true') return { outcome: 'blocked', detail: '打招呼按钮不可用，未点击' };
    btn.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = btn.getBoundingClientRect();
    const visible = getComputedStyle(btn);
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    if (!rect.width || !rect.height || visible.visibility === 'hidden' || Number(visible.opacity) < 0.05 || !hit || !btn.contains(hit)) return { outcome: 'blocked', detail: '按钮不可见或被弹窗遮挡，未点击' };
    if (${JSON.stringify(click)}) btn.click();
    return { outcome: 'clicked', detail: ${JSON.stringify(click ? '已点击打招呼' : '身份与按钮已核对')} };
  })()`;
}

const restrictionScript = `(() => {
  const visible = el => el instanceof HTMLElement && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
  const roots = Array.from(document.querySelectorAll('.boss-popup__wrapper, .boss-dialog__wrapper, .dialog-container, .toast, .ui-toast, .message, .ant-message-notice'));
  return roots.filter(visible).some(el => /尚未开放|职位已关闭|上限|次数用完|操作频繁|稍后再试|安全验证|验证码|购买|直豆|充值|额度不足|打招呼失败/.test(el.textContent || ''));
})()`;

async function restricted(page: Page): Promise<boolean> {
  if (await detectBossPaywallPopup(page)) return true;
  for (const frame of page.frames()) if (await frame.evaluate(restrictionScript)) return true;
  return false;
}

export async function greetExactOnPage(page: Page, frame: Frame, target: ExactGreetTarget, waitMs = 6000): Promise<ExactGreetResult> {
  let attempted = false;
  const wrap = (outcome: ExactGreetResult['outcome'], detail: string): ExactGreetResult => ({ version: 1, geek_id: target.geekId, job_label: target.jobLabel, attempted, outcome, detail });
  if (await restricted(page)) return wrap('blocked', 'BOSS 存在限制或确认弹窗，已停止；请先在 BOSS 处理');
  const checked = await frame.evaluate(exactGreetScript(target, false)) as Pick<ExactGreetResult, 'outcome' | 'detail'>;
  if (checked.outcome !== 'clicked') return wrap(checked.outcome, checked.detail);
  const clicked = await frame.evaluate(exactGreetScript(target, true)) as Pick<ExactGreetResult, 'outcome' | 'detail'>;
  if (clicked.outcome !== 'clicked') return wrap(clicked.outcome, clicked.detail);
  attempted = true;
  const deadline = Date.now() + waitMs;
  let confirmed = false;
  do {
    if (await restricted(page)) return wrap('blocked', '点击后 BOSS 显示限制或验证弹窗，已停止；请到 BOSS 核实');
    const state = await frame.evaluate(exactGreetScript(target, false)) as Pick<ExactGreetResult, 'outcome' | 'detail'>;
    confirmed = state.outcome === 'already';
    // Keep observing for delayed platform rejection, even after the button changes.
    if (Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  } while (Date.now() < deadline);
  return confirmed ? wrap('sent', 'BOSS 已显示已招呼或继续沟通') : wrap('clicked', '已点击，BOSS 未提供明确成功状态；请人工核实，不会自动重发');
}

export async function runRecommendGreetExact(target: ExactGreetTarget): Promise<string> {
  if (![target.geekId, target.name, target.baseInfo, target.jobLabel].every(v => typeof v === 'string' && v.trim())) throw new Error('打招呼需要 ID、姓名、基本信息和完整岗位标签');
  return withBossSessionPage(async page => {
    const frame = await ensureInRecommendPage(page);
    await closeCResumePanel(page);
    await selectExactRecommendJob(frame, target.jobLabel);
    return JSON.stringify(await greetExactOnPage(page, frame, target));
  });
}
