import type { Page } from 'puppeteer-core';
import {
  LIST_FILTER_GAP_MS,
  LIST_MIN_BEFORE_EMPTY_OK_MS,
  LIST_POLL_MS,
  sleepRandom,
} from '../browser/index.js';
import { BOSS_CHAT_INDEX_URL, isBossChatIndexUrl } from '../common/auth.js';
import { ensurePage } from '../common/ensure_page.js';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { bossTimed } from '../common/debug.js';
import { walkChatHistory, chatScrollLayoutScript, historyScript, chatIdentityLayoutScript, mergeChatRows, type ChatRow } from './chat-history.js';

type CandidateItem = {
  name: string;
  job: string;
  time: string;
  message: string;
  unreadCount: number;
};

async function waitForCandidateListSettled(
  page: Page,
  opts: { timeoutMs: number; pollMsMin: number; pollMsMax: number; minMsBeforeEmptyOk: number },
): Promise<void> {
  const start = Date.now();
  let prev = -1;
  let stable = 0;
  while (Date.now() - start < opts.timeoutMs) {
    const n = (await page.evaluate(
      `(() => document.querySelectorAll(".geek-item").length)()`,
    )) as number;
    const elapsed = Date.now() - start;
    if (n === prev) {
      stable++;
    } else {
      prev = n;
      stable = 1;
    }
    if (stable >= 2) {
      if (n > 0) {
        return;
      }
      if (n === 0 && elapsed >= opts.minMsBeforeEmptyOk) {
        return;
      }
    }
    await sleepRandom(opts.pollMsMin, opts.pollMsMax);
  }
}

async function clickChatFilterTab(page: Page, label: string): Promise<void> {
  const labelLiteral = JSON.stringify(label);
  await page.evaluate(`(() => {
    const targetText = ${labelLiteral};
    const container = document.querySelector(".chat-message-filter-left");
    if (!container) {
      throw new Error("未找到聊天筛选容器：.chat-message-filter-left");
    }
    const spans = Array.from(container.querySelectorAll("span"));
    const norm = (v) => (v ?? "").replace(/\\s+/g, "");
    const target = spans.find((el) => norm(el.textContent).includes(targetText));
    if (!target) {
      const labels = spans.map((el) => norm(el.textContent)).filter(Boolean).join(",");
      throw new Error("未找到聊天筛选项：" + targetText + "；当前筛选项：" + (labels || "空"));
    }
    target.click();
  })()`);
}

async function waitForChatFilterTabSelected(page: Page, label: string): Promise<void> {
  const labelLiteral = JSON.stringify(label);
  await page.waitForFunction(
    `(() => {
      const targetText = ${labelLiteral};
      const container = document.querySelector(".chat-message-filter-left");
      if (!container) return false;
      const norm = (v) => (v ?? "").replace(/\\s+/g, "");
      const tabs = Array.from(container.querySelectorAll("span"));
      const tab = tabs.find((el) => norm(el.textContent).includes(targetText));
      if (!tab) return false;
      const cls = String(tab.className || "");
      const selectedByClass = /active|selected|current|checked/.test(cls);
      const selectedByAria = tab.getAttribute("aria-selected") === "true";
      const selectedByAncestor = !!tab.closest(".active, .selected, .current, .checked");
      return selectedByClass || selectedByAria || selectedByAncestor;
    })()`,
    { timeout: 8_000 },
  );
}

export async function ensureChatListReady(
  page: Page,
  filter: 'all' | 'unread' = 'all',
  preserveLoaded = false,
): Promise<void> {
  await bossTimed('candidates.navigate', () => ensurePage(page, {
    name: '沟通列表页',
    targetUrl: BOSS_CHAT_INDEX_URL,
    matches: isBossChatIndexUrl,
  }));

  await bossTimed('candidates.filter_ready', () => page.waitForFunction(
    `(() => {
      const filter = document.querySelector(".chat-message-filter-left");
      if (!filter) return false;
      const tabs = Array.from(filter.querySelectorAll("span"));
      return tabs.length >= 2;
    })()`,
    { timeout: 15_000 },
  ));

  const filterLabel = filter === 'unread' ? '未读' : '全部';
  const alreadySelected = preserveLoaded && await page.evaluate(`(() => {
    const tabs = Array.from(document.querySelectorAll('.chat-message-filter-left span'));
    const tab = tabs.find(el => (el.textContent || '').replace(/\\s+/g, '').includes(${JSON.stringify(filterLabel)}));
    return !!tab && (/active|selected|current|checked/.test(String(tab.className)) || tab.getAttribute('aria-selected') === 'true' || !!tab.closest('.active, .selected, .current, .checked'));
  })()`);
  if (!alreadySelected) {
    await bossTimed('candidates.filter_click', () => clickChatFilterTab(page, filterLabel));
    await bossTimed('candidates.filter_delay', () => sleepRandom(LIST_FILTER_GAP_MS.min, LIST_FILTER_GAP_MS.max));
  }
  await bossTimed('candidates.filter_selected', () => waitForChatFilterTabSelected(page, filterLabel));
  await bossTimed('candidates.list_settled', () => waitForCandidateListSettled(page, {
    timeoutMs: 18_000,
    pollMsMin: LIST_POLL_MS.min,
    pollMsMax: LIST_POLL_MS.max,
    minMsBeforeEmptyOk: LIST_MIN_BEFORE_EMPTY_OK_MS,
  }));
}

export async function runGetChatHistory(since?: string): Promise<string> {
  return withBossSessionPage(async page => {
    // A sync starts a fresh all-chat snapshot; verification preserves it.
    await ensureChatListReady(page);
    const snapshot = await bossTimed('candidates.history', () => walkChatHistory(page, { since }));
    return JSON.stringify({ version: 1, since: since ?? null, ...snapshot });
  });
}

export async function runInspectChatScroll(probe = false): Promise<string> {
  return withBossSessionPage(async page => {
    await ensureChatListReady(page, 'all', true);
    if (probe) {
      const before = await page.evaluate(historyScript()) as { top: number; height: number; viewport: number; rows: unknown[] };
      try {
        await page.evaluate(historyScript('next'));
        await sleepRandom(700, 700);
        const after = await page.evaluate(historyScript()) as typeof before;
        if (before.top + before.viewport < before.height - 2 && after.top <= before.top) throw new Error('沟通列表未随滚动指令移动');
        return JSON.stringify({ before: { top: before.top, height: before.height, rows: before.rows.length }, after: { top: after.top, height: after.height, rows: after.rows.length }, probe: 'one_step_then_restore' });
      } finally {
        await page.evaluate(`(() => { const list = document.querySelector('.user-list'); if (list) { list.scrollTop = ${JSON.stringify(before.top)}; list.dispatchEvent(new Event('scroll', { bubbles: true })); } })()`);
      }
    }
    return JSON.stringify(await page.evaluate(chatScrollLayoutScript));
  });
}

export async function runInspectChatIdentities(): Promise<string> {
  return withBossSessionPage(async page => {
    await ensureChatListReady(page, 'all', true);
    const layout = await page.evaluate(chatIdentityLayoutScript) as object;
    const snapshot = await page.evaluate(historyScript()) as { rows: ChatRow[] };
    const indexed = new Map<string, ChatRow>(), unidentified = new Set<string>();
    mergeChatRows(indexed, unidentified, snapshot.rows);
    const groups = new Map<string, string[]>();
    for (const row of indexed.values()) {
      const key = JSON.stringify([row.name, row.job]);
      groups.set(key, [...(groups.get(key) ?? []), row.sourceId]);
    }
    return JSON.stringify({ ...layout, collector: { retained: indexed.size, unidentified: unidentified.size, sameNameDistinctIds: [...groups.values()].filter(ids => ids.length > 1) } });
  });
}

export async function runGetCandidateList(
  opts: { unreadOnly?: boolean } = {},
): Promise<string> {
  const unreadOnly = opts.unreadOnly === true;

  try {
    return await withBossSessionPage(async (page) => {
      await ensureChatListReady(page, unreadOnly ? 'unread' : 'all');

      const items = (await bossTimed('candidates.extract', () => page.evaluate(
        `(() => {
          const norm = (v) => (v ?? "").replace(/\\s+/g, " ").trim();
          return Array.from(document.querySelectorAll(".geek-item")).map((el) => {
            const name = norm(el.querySelector(".geek-name")?.textContent);
            const job = norm(el.querySelector(".source-job")?.textContent);
            const time = norm(el.querySelector(".time")?.textContent);
            const message = norm(el.querySelector(".push-text")?.textContent);
            const badge = el.querySelector(".badge-count");
            let unreadCount = 0;
            if (badge) {
              const digits = norm(badge.textContent).replace(/\\D/g, "");
              if (digits) unreadCount = parseInt(digits, 10) || 0;
            }
            return { name, job, time, message, unreadCount };
          });
        })()`,
      ))) as CandidateItem[];

      const candidates = items.filter((it) => it.name) as CandidateItem[];
      const withUnread = candidates.filter((it) => it.unreadCount > 0).length;
      const visible = unreadOnly ? candidates : candidates;
      const lines = visible.map((it, idx) => {
        const base = `${idx + 1}. ${it.name}${it.job ? `｜${it.job}` : ''}`;
        const meta = [
          it.unreadCount > 0 ? `未读:${it.unreadCount}` : '',
          it.time ? `时间:${it.time}` : '',
          it.message ? `消息:${it.message}` : '',
        ]
          .filter(Boolean)
          .join('｜');
        return meta ? `${base}｜${meta}` : base;
      });
      const previewText =
        lines.length > 0 ? `候选人明细：\n${lines.join('\n')}` : '候选人明细：暂无。';

      return [
        unreadOnly
          ? `未读筛选：共 ${visible.length} 人（已切换页面「未读」筛选）。`
          : `沟通列表共 ${candidates.length} 人，其中 ${withUnread} 人有未读消息。`,
        previewText,
      ]
        .filter(Boolean)
        .join('\n');
    });
  } catch (e) {
    if (e instanceof Error) {
      throw e;
    }
    throw new Error(`获取候选人列表失败：${String(e)}`);
  }
}
