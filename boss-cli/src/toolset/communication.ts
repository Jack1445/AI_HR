import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensureChatListReady } from './list.js';
import { ensureChatTarget } from './chat-history.js';

export type CommunicationEvidence = {
  recruiter_sent: boolean;
  candidate_sent: boolean;
  request_resume_enabled: boolean | null;
  mutual_reply_required: boolean;
  attachment_present: boolean;
};

// Absence of one sender in a partially loaded history is not proof of no reply.
// One-sided states require the platform's explicit mutual-reply gate as well.
export function classifyEvidence(e: CommunicationEvidence): 'outgoing' | 'incoming' | 'mutual' | 'unknown' {
  if (e.mutual_reply_required && (e.request_resume_enabled === true || (e.recruiter_sent && e.candidate_sent))) return 'unknown';
  if (e.request_resume_enabled === true || (e.recruiter_sent && e.candidate_sent)) return 'mutual';
  if (e.mutual_reply_required && e.recruiter_sent && !e.candidate_sent) return 'outgoing';
  if (e.mutual_reply_required && e.candidate_sent && !e.recruiter_sent) return 'incoming';
  return 'unknown';
}

type Target = { id: string; sourceId: string; name: string; job: string };
export function validateTargets(value: unknown): asserts value is Target[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10 || value.some((t) =>
    !t || typeof t.id !== 'string' || !t.id || typeof t.name !== 'string' || !t.name.trim() ||
    typeof t.job !== 'string' || !t.job.trim() || typeof t.sourceId !== 'string' || !t.sourceId.trim()) || new Set(value.map((t) => t.id)).size !== value.length) {
    throw new Error('核验目标必须为 1 到 10 个不重复的 {id, sourceId, name, job} 对象；缺少 BOSS 会话编号时请先同步。');
  }
}

export function openChatScript(target: Target): string {
  const key = JSON.stringify({ sourceId: target.sourceId, name: target.name, job: target.job });
  return `(() => {
          const target = ${key};
          const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
          const rows = Array.from(document.querySelectorAll('.user-list .geek-item')).filter(el => el.getAttribute('data-id') === target.sourceId);
          if (!rows.length) throw new Error('当前列表未找到目标 BOSS 会话编号，请重新同步');
          if (rows.some(el => norm(el.querySelector('.geek-name')?.textContent) !== target.name || norm(el.querySelector('.source-job')?.textContent) !== target.job)) throw new Error('会话编号对应的姓名或岗位已变化，请重新同步');
          const el = rows[0];
          const previousId = document.querySelector('.geek-item.selected')?.getAttribute('data-id');
          const previousName = norm(document.querySelector('.base-info-single-container .name-box')?.textContent);
          const previousChat = previousId !== target.sourceId && previousName === target.name ? document.querySelector('.chat-message-list')?.innerHTML || '' : '';
          const message = norm(el.querySelector('.push-text')?.textContent);
          const time = norm(el.querySelector('.time')?.textContent);
          el.click();
          return { message, time, previousChat };
        })()`;
}

export async function runClassifyCommunications(value: unknown): Promise<string> {
  validateTargets(value);
  return withBossSessionPage(async (page) => {
    await ensureChatListReady(page, 'all', true);
    const results = [];
    const deadline = Date.now() + 70_000;
    for (const target of value) {
      try {
        if (Date.now() >= deadline) throw new Error('本次核验达到 70 秒上限，请手动重试剩余人员');
        await ensureChatTarget(page, target, deadline);
        const key = JSON.stringify({ sourceId: target.sourceId, name: target.name, job: target.job });
        const row = await page.evaluate(openChatScript(target)) as { message: string; time: string; previousChat: string };
        // Wait for BOTH the selected row and matching detail panel. Merely
        // waiting for any message list can read the previous person's chat.
        const snapshotScript = `(() => {
          const target = ${key};
          const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
          const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0 && getComputedStyle(el).visibility !== 'hidden';
          const selected = document.querySelector('.geek-item.selected');
          if (!selected || selected.getAttribute('data-id') !== target.sourceId || norm(selected.querySelector('.geek-name')?.textContent) !== target.name || norm(selected.querySelector('.source-job')?.textContent) !== target.job) return null;
          const detail = Array.from(document.querySelectorAll('.base-info-single-container')).find(visible);
          if (!detail || norm(detail.querySelector('.name-box')?.textContent) !== target.name) return null;
          const position = norm(detail.querySelector('.position-item .position-name')?.textContent);
          if (position !== target.job) return null;
          const lists = Array.from(document.querySelectorAll('.chat-message-list')).filter(visible);
          if (lists.length !== 1) return null;
          const list = lists[0];
          if (${JSON.stringify(row.previousChat)} && list.innerHTML === ${JSON.stringify(row.previousChat)}) return null;
          if (!list.querySelector('.message-item')) return null;
          const hasMessage = selector => Array.from(list.querySelectorAll(selector)).some(el => !!norm(el.textContent) || !!el.querySelector('img, .resume-icon'));
          const controls = Array.from(document.querySelectorAll('.operate-icon-item')).filter(visible);
          const request = controls.find(el => norm(el.querySelector('.operate-btn')?.textContent).includes('求简历'));
          const button = request?.querySelector('.operate-btn');
          const disabled = request && button ? /disabled|forbid|ban/i.test(String(request.className) + ' ' + String(button.className)) || button.hasAttribute('disabled') || button.getAttribute('aria-disabled') === 'true' : null;
          const attachmentButtons = Array.from(document.querySelectorAll('a,button')).filter(el => visible(el) && norm(el.textContent) === '附件简历');
          const gateText = [request?.textContent ?? '', ...attachmentButtons.map(el => el.parentElement?.textContent ?? '')].join(' ');
          return {
            recruiter_sent: hasMessage('.message-item .item-myself'),
            candidate_sent: hasMessage('.message-item .item-friend'),
            request_resume_enabled: disabled === null ? null : !disabled,
            mutual_reply_required: /双向回复后|双方.*(?:回复|发送).*后/.test(gateText),
            attachment_present: !!list.querySelector('.item-friend .resume-icon')
          };
        })()`;
        await page.waitForFunction(snapshotScript, { timeout: 8000 });
        const evidence = await page.evaluate(snapshotScript) as CommunicationEvidence | null;
        if (!evidence) throw new Error('会话在核验过程中发生切换，请重试');
        const status = classifyEvidence(evidence);
        results.push({ id: target.id, status, evidence, message: row.message, time: row.time, checked_at: new Date().toISOString(), error: status === 'unknown' ? '当前页面证据不足或冲突，未推断单方沟通状态' : '' });
      } catch (error) {
        // Return an explicit per-target failure, never guess a category.
        results.push({ id: target.id, status: 'unknown', evidence: null, checked_at: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      }
    }
    return JSON.stringify({ version: 1, results });
  });
}
