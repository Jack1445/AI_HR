import type { Page } from 'puppeteer-core';
import { bossTimed } from '../common/debug.js';

export type ChatRow = { sourceId: string; name: string; job: string; time: string; message: string; unreadCount: number; legacyMatchUnique?: boolean };
type Snapshot = { rows: ChatRow[]; top: number; height: number; viewport: number; loading: boolean; error: string };

export const chatIdentityLayoutScript = `(() => {
  const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
  const rows = Array.from(document.querySelectorAll('.user-list .geek-item'));
  const grouped = new Map();
  rows.forEach((el, index) => {
    const key = JSON.stringify([norm(el.querySelector('.geek-name')?.textContent), norm(el.querySelector('.source-job')?.textContent)]);
    grouped.set(key, [...(grouped.get(key) || []), index]);
  });
  const duplicateGroups = [...grouped.values()].filter(group => group.length > 1);
  const sampleIndexes = [...new Set([0, 1, ...duplicateGroups.flat()])].filter(i => rows[i]);
  const detailIdentifiers = Array.from(document.querySelectorAll('.base-info-single-container, .chat-message-list')).map(el => ({ class: String(el.className), attributes: Object.fromEntries(Array.from(el.attributes).filter(a => /^(?:data-|id$)/.test(a.name)).map(a => [a.name, a.value])), childIdentifiers: Array.from(el.querySelectorAll('[data-id],[data-uid],[data-geekid],[data-geek-id]')).slice(0, 3).map(n => ({ tag: n.tagName, class: String(n.className), attributes: Object.fromEntries(Array.from(n.attributes).filter(a => /^(?:data-|id$)/.test(a.name)).map(a => [a.name, a.value])) })) }));
  return { total: rows.length, duplicateGroups, detailIdentifiers, samples: sampleIndexes.map(index => {
    const row = rows[index], nodes = [row, row.parentElement, row.parentElement?.parentElement, row.querySelector('.text.uid'), row.querySelector('.figure img')].filter(Boolean);
    return { index, nodes: nodes.map(el => ({ tag: el.tagName, class: String(el.className), attributes: Object.fromEntries(Array.from(el.attributes).filter(a => /^(?:data-|id$)/.test(a.name)).map(a => [a.name, a.value])) })), linkCount: row.querySelectorAll('a[href]').length };
  }) };
})()`;

// Layout-only diagnostics: no names, messages, or candidate details.
export const chatScrollLayoutScript = `(() => {
  const rows = Array.from(document.querySelectorAll('.geek-item'));
  const chains = rows.slice(0, 2).map(row => {
    const chain = [];
    for (let el = row; el; el = el.parentElement) {
      const style = getComputedStyle(el);
      chain.push({ tag: el.tagName, class: String(el.className), overflowY: style.overflowY, display: style.display, visibility: style.visibility, height: el.clientHeight, scrollHeight: el.scrollHeight, top: el.scrollTop });
    }
    return chain;
  });
  const list = document.querySelector('.user-list');
  const layout = list ? [list, ...list.querySelectorAll('div')].slice(0, 35).map(el => ({ class: String(el.className), height: el.clientHeight, scrollHeight: el.scrollHeight, transform: getComputedStyle(el).transform, top: el.getBoundingClientRect().top })) : [];
  return { rowCount: rows.length, chains, layout };
})()`;

export function beijingToday(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
}

export function validateSince(value: string, today = beijingToday()): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value || value > today) {
    throw new Error('起始日期必须为有效的 YYYY-MM-DD，且不能晚于今天（北京时间）');
  }
  return value;
}

// BOSS uses relative dates for recent chats and omits the year for older ones.
// Unknown labels stay in the scan/verification scope; they must never hide people.
export function chatDate(label: string, today = beijingToday()): string | null {
  const text = label.trim();
  const base = new Date(`${today}T00:00:00Z`);
  const ago = (days: number) => new Date(base.getTime() - days * 86400_000).toISOString().slice(0, 10);
  if (/^(刚刚|今天|\d+分钟前|\d{1,2}:\d{2})/.test(text)) return today;
  if (/^昨天/.test(text)) return ago(1);
  if (/^前天/.test(text)) return ago(2);
  const week = text.match(/^(?:星期|周)([日天一二三四五六])/);
  if (week) {
    const day = '日一二三四五六'.indexOf(week[1] === '天' ? '日' : week[1]);
    return ago((base.getUTCDay() - day + 7) % 7 || 7);
  }
  const match = text.match(/^(?:(\d{4})[年/.-])?(\d{1,2})[月/.-](\d{1,2})(?:日)?(?:\s.*)?$/);
  if (!match) return null;
  let year = match[1] ? Number(match[1]) : base.getUTCFullYear();
  const make = () => `${year}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}`;
  if (!match[1] && make() > today) year -= 1;
  const value = make();
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value ? value : null;
}

// BOSS's .user-list is a native scroll container with overflow:hidden; its
// custom scrollbar controls scrollTop. CSS auto/scroll detection excludes it.
// The same script is used for snapshots and movements, including virtual lists.
export function historyScript(move: 'read' | 'top' | 'next' = 'read'): string {
  return `(() => {
    const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
    const lists = Array.from(document.querySelectorAll('.user-list')).filter(el => el.clientHeight > 0);
    if (lists.length !== 1) throw new Error('沟通列表 .user-list 匹配数为 ' + lists.length + '，无法唯一定位历史滚动区域');
    const scroller = lists[0];
    const items = Array.from(scroller.querySelectorAll('.geek-item'));
    if (!items.length) {
      const explicitEmpty = Array.from(scroller.querySelectorAll('div, p, span')).some(el =>
        /^(?:暂无联系人|暂无沟通记录|暂无聊天记录|暂无牛人|暂无消息|没有相关联系人)[。！!]?$/u.test(norm(el.textContent)) && el.getBoundingClientRect().height > 0);
      if (explicitEmpty) return { rows: [], top: 0, height: 0, viewport: 0, loading: false, error: '' };
    }
    const area = scroller.parentElement;
    const text = norm(area?.innerText);
    const error = text.match(/加载失败|网络异常|操作频繁|安全验证|请完成验证/)?.[0] || '';
    const loading = Array.from(area?.querySelectorAll('[aria-busy="true"], [role="progressbar"], [class*="loading"], [class*="spinner"]') || []).some(el => {
      if (el.getBoundingClientRect().height <= 0 || getComputedStyle(el).visibility === 'hidden') return false;
      // Infinite-scroll wrappers can remain visible after loading finishes.
      return el.getAttribute('aria-busy') === 'true' || el.getAttribute('role') === 'progressbar' ||
        /加载中|正在加载/.test(norm(el.textContent)) || getComputedStyle(el).animationName !== 'none' && !!getComputedStyle(el).animationName;
    });
    if (${JSON.stringify(move)} === 'top') scroller.scrollTop = 0;
    if (${JSON.stringify(move)} === 'next') scroller.scrollTop = Math.min(scroller.scrollHeight, scroller.scrollTop + Math.max(100, scroller.clientHeight * 0.8));
    if (${JSON.stringify(move)} !== 'read') scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    return { rows: items.map(el => ({
      sourceId: norm(el.getAttribute('data-id')),
      name: norm(el.querySelector('.geek-name')?.textContent), job: norm(el.querySelector('.source-job')?.textContent),
      time: norm(el.querySelector('.time')?.textContent), message: norm(el.querySelector('.push-text')?.textContent),
      unreadCount: Number(norm(el.querySelector('.badge-count')?.textContent).replace(/\\D/g, '')) || 0
    })).filter(row => row.name), top: scroller.scrollTop, height: scroller.scrollHeight, viewport: scroller.clientHeight, loading, error };
  })()`;
}

type WalkOptions = { since?: string; target?: { sourceId: string; name: string; job: string }; deadline?: number; pause?: () => Promise<void>; now?: () => number };

export function mergeChatRows(rows: Map<string, ChatRow>, unidentified: Set<string>, incoming: ChatRow[]) {
  for (const row of incoming) {
    if (!row.sourceId) { unidentified.add(JSON.stringify([row.name.toLowerCase(), row.job.toLowerCase()])); continue; }
    rows.set(row.sourceId, row);
  }
}

export async function walkChatHistory(page: Page, options: WalkOptions = {}) {
  const now = options.now ?? Date.now;
  const deadline = options.deadline ?? now() + 600_000;
  const pause = options.pause ?? (() => new Promise<void>(resolve => setTimeout(resolve, 500)));
  const today = beijingToday();
  if (options.since) validateSince(options.since, today);
  const rows = new Map<string, ChatRow>();
  const unidentified = new Set<string>();
  let last = '', bottomSince = 0, steps = 0;
  await page.evaluate(historyScript('top'));
  await pause();
  // Scan to the bottom even with a date selected: pinned chats and non-monotonic
  // ordering mean one old row cannot prove that every following row is older.
  while (now() < deadline && steps < 2000) {
    const snapshot = await page.evaluate(historyScript()) as Snapshot;
    if (snapshot.error) throw new Error(`沟通历史读取中止：${snapshot.error}`);
    mergeChatRows(rows, unidentified, snapshot.rows);
    if (options.target && snapshot.rows.some(r => r.sourceId === options.target!.sourceId)) return { rows: [...rows.values()], scanned: rows.size, undated: 0, unidentified: unidentified.size, stop_reason: 'target_found' };
    const signature = JSON.stringify([snapshot.top, snapshot.height, snapshot.rows.map(r => [r.sourceId, r.time])]);
    const bottom = snapshot.top + snapshot.viewport >= snapshot.height - 2;
    if (bottom && !snapshot.loading && signature === last) {
      if (!bottomSince) bottomSince = now();
      // Ten quiet seconds at the bottom accommodates delayed lazy loading.
      if (now() - bottomSince >= 10_000) {
        if (options.target) throw new Error('已遍历沟通列表，未找到对应 BOSS 会话编号');
        const all = [...rows.values()];
        const legacyCounts = new Map<string, number>();
        const legacyKey = (r: ChatRow) => JSON.stringify([r.name.toLowerCase(), r.job.toLowerCase()]);
        for (const row of all) legacyCounts.set(legacyKey(row), (legacyCounts.get(legacyKey(row)) ?? 0) + 1);
        const selected = all.filter(r => !options.since || !chatDate(r.time, today) || chatDate(r.time, today)! >= options.since)
          .map(row => ({ ...row, legacyMatchUnique: legacyCounts.get(legacyKey(row)) === 1 && !unidentified.has(legacyKey(row)) }));
        return { rows: selected, scanned: all.length, undated: selected.filter(r => !chatDate(r.time, today)).length, unidentified: unidentified.size, stop_reason: 'stable_bottom' };
      }
    } else bottomSince = 0;
    last = signature;
    await bossTimed('candidates.history_scroll', () => page.evaluate(historyScript('next')));
    steps += 1;
    await pause();
  }
  throw new Error(`沟通历史尚未加载完整（已发现 ${rows.size} 人），达到读取时限；请重试，未将部分列表标为完成`);
}

export async function ensureChatTarget(page: Page, target: { sourceId: string; name: string; job: string }, deadline: number) {
  const present = await page.evaluate(`(() => {
    const target = ${JSON.stringify(target)};
    return Array.from(document.querySelectorAll('.user-list .geek-item')).some(el => el.getAttribute('data-id') === target.sourceId);
  })()`);
  if (!present) await walkChatHistory(page, { target, deadline });
}
