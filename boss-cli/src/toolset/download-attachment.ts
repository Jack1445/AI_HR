import { writeFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensureChatListReady } from './list.js';
import { ensureChatTarget } from './chat-history.js';
import { openChatScript } from './communication.js';

type Target = { id: string; sourceId: string; name: string; job: string };

function identityScript(target: Target, previousChat = ''): string {
  return `(() => {
    const target = ${JSON.stringify(target)};
    const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
    const visible = el => !!el && el.getBoundingClientRect().width > 0 && el.getBoundingClientRect().height > 0;
    const selected = document.querySelector('.geek-item.selected');
    const detail = Array.from(document.querySelectorAll('.base-info-single-container')).find(visible);
    const lists = Array.from(document.querySelectorAll('.chat-message-list')).filter(visible);
    return !!selected && selected.getAttribute('data-id') === target.sourceId &&
      norm(selected.querySelector('.geek-name')?.textContent) === target.name &&
      norm(selected.querySelector('.source-job')?.textContent) === target.job &&
      !!detail && norm(detail.querySelector('.name-box')?.textContent) === target.name &&
      norm(detail.querySelector('.position-item .position-name')?.textContent) === target.job &&
      lists.length === 1 && !!lists[0].querySelector('.message-item') &&
      (!${JSON.stringify(previousChat)} || lists[0].innerHTML !== ${JSON.stringify(previousChat)});
  })()`;
}

export async function runDownloadAttachment(target: Target, output: string): Promise<string> {
  if (!target || !['id', 'sourceId', 'name', 'job'].every(key => typeof target[key as keyof Target] === 'string' && target[key as keyof Target].trim()) || !isAbsolute(output) || !output.toLowerCase().endsWith('.pdf')) {
    throw new Error('下载目标必须含候选人 ID、BOSS 会话编号、姓名和岗位；输出须为绝对 PDF 路径');
  }
  return withBossSessionPage(async page => {
    await ensureChatListReady(page, 'all', true);
    // A preview left open by a previous action must not be mistaken for this candidate's file.
    await page.evaluate(`(() => { document.querySelector('.resume-common-wrap .close-btn')?.click(); })()`);
    await ensureChatTarget(page, target, Date.now() + 70_000);
    const row = await page.evaluate(openChatScript(target)) as { previousChat: string };
    const check = identityScript(target, row.previousChat);
    await page.waitForFunction(check, { timeout: 8000 });
    const card = await page.evaluate(`(() => {
      const cards = Array.from(document.querySelectorAll('.chat-message-list .item-friend'))
        .filter(el => el.querySelector('.resume-icon') && el.querySelector('.card-btn'));
      const last = cards.at(-1);
      if (!last) return null;
      const name = (last.querySelector('.message-card-top-title')?.textContent || '').trim();
      if (!name.toLowerCase().endsWith('.pdf')) throw new Error('最新附件不是 PDF，暂不能安全保存原始文件');
      const button = last.querySelector('.card-btn');
      if (!button || !(button.textContent || '').includes('点击预览附件简历')) throw new Error('附件预览按钮不可用');
      button.click();
      return { name };
    })()`) as { name: string } | null;
    if (!card) throw new Error('当前会话没有对方已提供、可预览的附件简历');
    await page.waitForFunction(`(() => {
      const frame = document.querySelector('iframe.attachment-iframe');
      return !!frame && frame.getBoundingClientRect().height > 0 && frame.src.includes('/bzl-office/pdf-viewer-b');
    })()`, { timeout: 12_000 });
    if (!await page.evaluate(identityScript(target))) throw new Error('下载前会话身份已变化，未保存附件');
    const result = await page.evaluate(`(async () => {
      const frame = document.querySelector('iframe.attachment-iframe');
      if (!frame) throw new Error('附件预览已关闭');
      const url = new URL(new URL(frame.src).searchParams.get('url') || '', location.origin);
      if (url.origin !== 'https://www.zhipin.com' || !url.pathname.startsWith('/wflow/zpgeek/download/preview4boss/')) throw new Error('附件来源不是预期的 BOSS 文件地址');
      const response = await fetch(url.href, { credentials: 'include' });
      if (!response.ok || !(response.headers.get('content-type') || '').toLowerCase().startsWith('application/pdf')) throw new Error('BOSS 未返回可下载的 PDF 附件（HTTP ' + response.status + '）');
      const limit = 10 * 1024 * 1024;
      if (Number(response.headers.get('content-length') || 0) > limit) throw new Error('附件超过 10 MB 限制');
      const blob = await response.blob();
      if (blob.size < 5 || blob.size > limit) throw new Error('附件为空或超过 10 MB 限制');
      const base64 = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',', 2)[1]);
        reader.onerror = () => reject(new Error('附件读取失败'));
        reader.readAsDataURL(blob);
      });
      return { base64, size: blob.size };
    })()`) as { base64: string; size: number };
    const bytes = Buffer.from(result.base64, 'base64');
    if (bytes.length !== result.size || !bytes.subarray(0, 5).equals(Buffer.from('%PDF-'))) throw new Error('下载文件不是有效 PDF');
    await writeFile(output, bytes, { flag: 'wx' });
    await page.evaluate(`(() => { document.querySelector('.resume-common-wrap .close-btn')?.click(); })()`);
    return JSON.stringify({ version: 1, id: target.id, source_id: target.sourceId, name: target.name, job: target.job, original_name: card.name, size: bytes.length });
  });
}
