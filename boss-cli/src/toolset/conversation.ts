import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensureChatListReady } from './list.js';
import { beijingToday, chatDate, historyScript, reachedDateCutoff, type ChatRow } from './chat-history.js';
import { openChatScript } from './communication.js';
import { scrapeCurrentChatMessages } from './chat.js';
import { sendChatMessageOnPage } from './send.js';
import type { Page } from 'puppeteer-core';

type Target = { id: string; sourceId: string; name: string; job: string; baseInfo?: string; recentTime?: string };

type ChatSnapshot = { rows: ChatRow[]; top: number; height: number; viewport: number; loading: boolean; error: string };

function stableBasicInfo(value: string): string[] {
  return [value.match(/\d{1,2}岁/)?.[0], value.match(/\d{2,4}年应届生/)?.[0], value.match(/博士|硕士|本科|大专/)?.[0]]
    .filter((part): part is string => !!part);
}

function readyScript(target: Target, previousChat: string): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const previous = ${JSON.stringify(previousChat)};
    const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
    const selected = document.querySelector('.geek-item.selected');
    if (!selected || selected.getAttribute('data-id') !== target.sourceId ||
        norm(selected.querySelector('.geek-name')?.textContent) !== target.name ||
        norm(selected.querySelector('.source-job')?.textContent) !== target.job) return false;
    const detail = Array.from(document.querySelectorAll('.base-info-single-container')).find(el => el.getBoundingClientRect().height > 0);
    if (!detail || norm(detail.querySelector('.name-box')?.textContent) !== target.name ||
        norm(detail.querySelector('.position-item .position-name')?.textContent) !== target.job) return false;
    const list = Array.from(document.querySelectorAll('.chat-message-list')).filter(el => el.getBoundingClientRect().height > 0);
    return list.length === 1 && (!previous || list[0].innerHTML !== previous);
  })()`;
}

async function locateConversation(page: Page, target: Target): Promise<{ matched: Target; script: string }> {
  const started = Date.now();
  const seen = new Map<string, ChatRow>();
  const cutoff = target.recentTime ? chatDate(target.recentTime) : null;
  const basicParts = stableBasicInfo(target.baseInfo ?? '');
  await page.evaluate(historyScript('top'));
  await new Promise(resolve => setTimeout(resolve, 300));
  let bottomSince = 0;
  while (Date.now() - started < 35_000 && seen.size < 250) {
    const snapshot = await page.evaluate(historyScript()) as ChatSnapshot;
    if (snapshot.error) throw new Error(`沟通列表读取失败：${snapshot.error}`);
    for (const row of snapshot.rows) {
      if (seen.size >= 250) break;
      if (!row.sourceId || seen.has(row.sourceId)) continue;
      seen.set(row.sourceId, row);
      if (row.name !== target.name || row.job !== target.job) continue;
      const matched = { ...target, sourceId: row.sourceId };
      const opened = await page.evaluate(openChatScript(matched)) as { previousChat: string };
      const script = readyScript(matched, opened.previousChat);
      await page.waitForFunction(script, { timeout: 8000 });
      if (row.sourceId === target.sourceId || !basicParts.length) return { matched, script };
      const detailText = await page.evaluate(`(() => {
        const el = Array.from(document.querySelectorAll('.base-info-single-container')).find(node => node.getBoundingClientRect().height > 0);
        return (el?.textContent || '').replace(/\\s+/g, ' ');
      })()`) as string;
      if (basicParts.every(part => detailText.includes(part))) return { matched, script };
    }
    if (cutoff && !snapshot.loading && reachedDateCutoff([...seen.values()], cutoff, beijingToday())) {
      throw new Error(`已从顶部检查 ${seen.size} 条会话，超过该候选人最近沟通日期 ${cutoff}，仍未找到姓名、岗位和基本信息一致的会话；未发送`);
    }
    if (snapshot.top + snapshot.viewport >= snapshot.height - 2 && !snapshot.loading) {
      if (!bottomSince) bottomSince = Date.now();
      if (Date.now() - bottomSince >= 1500) break;
    } else bottomSince = 0;
    await page.evaluate(historyScript('next'));
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`已从顶部检查 ${seen.size} 条会话（最多 250 条或 35 秒），未找到姓名、岗位和基本信息一致的会话；未发送`);
}

export function validateConversationTarget(value: unknown): asserts value is Target {
  if (!value || typeof value !== 'object' ||
      !['id', 'sourceId', 'name', 'job'].every(key => typeof (value as Record<string, unknown>)[key] === 'string' &&
        !!String((value as Record<string, unknown>)[key]).trim())) {
    throw new Error('会话目标必须包含非空的 id、sourceId、name 和 job');
  }
}

export async function runConversation(targetValue: unknown, text = ''): Promise<string> {
  validateConversationTarget(targetValue);
  const target = targetValue;
  if (text.length > 2000) throw new Error('消息超过 2000 字');
  if (/[\r\n]/.test(text)) throw new Error('当前仅支持单条文字消息，请把换行改为空格');
  return withBossSessionPage(async page => {
    await ensureChatListReady(page, 'all', true);
    const { matched, script } = await locateConversation(page, target);
    const before = await scrapeCurrentChatMessages(page);
    if (text) {
      // Recheck the exact target immediately before the irreversible send.
      if (!await page.evaluate(script)) throw new Error('发送前会话已切换，未发送');
      const normalized = text.replace(/\s+/g, ' ').trim();
      const oldCount = before.messages.filter(m => m.from === 'myself' && m.text === normalized).length;
      await sendChatMessageOnPage(page, { text });
      const sentScript = `(() => {
        const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
        const selected = document.querySelector('.geek-item.selected');
        if (!selected || selected.getAttribute('data-id') !== ${JSON.stringify(matched.sourceId)}) return false;
        return Array.from(document.querySelectorAll('.chat-message-list .message-item .item-myself .text span'))
          .filter(el => norm(el.textContent) === ${JSON.stringify(normalized)}).length > ${oldCount};
      })()`;
      try { await page.waitForFunction(sentScript, { timeout: 8000 }); }
      catch { throw new Error('已点击发送，但未看到新消息；结果待核实，请勿自动重试'); }
      const after = await scrapeCurrentChatMessages(page);
      return JSON.stringify({ target: matched, sent: true, messages: after.messages });
    }
    return JSON.stringify({ target: matched, messages: before.messages });
  });
}
