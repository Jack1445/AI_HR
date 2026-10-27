import { isAbsolute } from 'node:path';
import { withBossSessionPage } from '../common/boss_session_page.js';
import { ensureInRecommendPage, selectExactRecommendJob, readCurrentRecommendJobLabel } from './recommend.js';
import { snapshotBossPageViewport, ONLINE_RESUME_IFRAME_WAIT_MAX_MS } from '../browser/index.js';
import { captureCResumeIframeToFile, closeCResumePanel, findVisibleCResumeIframeHandle, prepareResumeCaptureWindow } from '../common/c_resume_capture.js';
import { waitForCResumeIframeOrPaywall, describeBossPaywallPopupIfPresent } from '../common/boss_paywall_popup.js';

// Screenshot-only path: deliberately does not import or invoke OCR services.
export async function runRecommendResume(options: { geekId: string; name: string; output: string; jobLabel?: string }): Promise<string> {
  if (!options.geekId || !options.name || !isAbsolute(options.output) || !options.output.endsWith('.png')) {
    throw new Error('需要候选人稳定 ID、姓名及绝对 PNG 输出路径');
  }
  return withBossSessionPage(async page => {
    await prepareResumeCaptureWindow(page);
    const frame = await ensureInRecommendPage(page);
    await closeCResumePanel(page);
    if (options.jobLabel) await selectExactRecommendJob(frame, options.jobLabel);
    const previous = await findVisibleCResumeIframeHandle(page);
    if (previous) { await previous.dispose(); throw new Error('上一个简历面板未关闭，请关闭后重试'); }
    const viewport = await snapshotBossPageViewport(page);
    try {
      await frame.evaluate(`(() => {
        const expected = ${JSON.stringify({ id: options.geekId, name: options.name })};
        const norm = v => (v ?? '').replace(/\\s+/g, ' ').trim();
        const matches = Array.from(document.querySelectorAll('.card-inner')).filter(el =>
          (el.getAttribute('data-geekid') ?? el.getAttribute('data-geek') ?? '') === expected.id);
        if (matches.length !== 1) throw new Error('推荐列表已变化或无法唯一定位该候选人，请重新手动读取推荐列表后再试');
        const inner = matches[0];
        const card = inner.closest('.candidate-card-wrap, .card-item, .geek-card');
        if (!card || norm(card.querySelector('.name')?.textContent) !== expected.name) throw new Error('候选人 ID 与姓名不一致，已停止截图');
        inner.scrollIntoView({ block: 'center', inline: 'nearest' });
        inner.click();
      })()`);
      const outcome = await waitForCResumeIframeOrPaywall(page, ONLINE_RESUME_IFRAME_WAIT_MAX_MS);
      if (outcome !== 'iframe') throw new Error(await describeBossPaywallPopupIfPresent(page) || '未出现在线简历，请确认当前账号可查看该简历');
      // The old panel was closed and the clicked card matched both stable ID and
      // name. Canvas resumes cannot expose their name as DOM text.
      if (!await captureCResumeIframeToFile(page, viewport, options.output, options.name, true)) throw new Error('在线简历截图失败');
      const job_label = await readCurrentRecommendJobLabel(frame);
      if (options.jobLabel && job_label !== options.jobLabel.replace(/\s+/g, ' ').trim()) throw new Error('截图期间推荐岗位发生变化，未保存截图');
      return JSON.stringify({ version: 1, geek_id: options.geekId, name: options.name, job_label, captured_at: new Date().toISOString() });
    } finally {
      await closeCResumePanel(page);
    }
  });
}
