import type { ElementHandle, Frame, Page } from 'puppeteer-core';
import { writeFile } from 'node:fs/promises';
import { inspectResumePng } from './resume_png_quality.js';
import { bossDebug, bossTimed } from './debug.js';
import { sleepRandom } from '../browser/timing.js';
import { resumeHeight, setTempHeight } from '../browser/viewport_temp.js';

/** 在线简历 iframe：`src` 常为相对路径 `/web/frame/c-resume/...`，故用子串匹配 */
export const C_RESUME_IFRAME_SELECTOR =
  'iframe[src*="c-resume"], iframe[src*="frame/c-resume"]' as const;

const CLOSE_C_RESUME_PANEL_SCRIPT = `(() => {
  const sel = ${JSON.stringify(C_RESUME_IFRAME_SELECTOR)};
  function hasCResumeIframe(root) {
    return Array.from(root.querySelectorAll('iframe')).some((iframe) => {
      const src = iframe.getAttribute('src') || '';
      return src.includes('c-resume') || src.includes('frame/c-resume');
    });
  }
  const wraps = Array.from(document.querySelectorAll('.dialog-lib-resume, .boss-popup__wrapper, .boss-dialog__wrapper, .dialog-container'));
  for (var wi = 0; wi < wraps.length; wi++) {
    var w = wraps[wi];
    if (hasCResumeIframe(w)) {
      var c =
        w.querySelector('.close-btn') ||
        w.querySelector('.boss-popup__close') ||
        w.querySelector('.boss-dialog__close') ||
        w.querySelector('.drawer-close') ||
        w.querySelector('.icon-close') ||
        w.querySelector('.btn-quxiao');
      if (c) {
        c.click();
        return true;
      }
    }
  }
  var iframe = document.querySelector(sel);
  var node = iframe ? iframe.parentElement : null;
  for (var i = 0; i < 12 && node; i++) {
    var closeBtn = node.querySelector(
      '.close-btn, .boss-popup__close, .boss-dialog__close, .drawer-close, .icon-close, .btn-quxiao',
    );
    if (closeBtn) {
      closeBtn.click();
      return true;
    }
    node = node.parentElement;
  }
  return false;
})()`;

const C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS = 3_000;

const VISIBLE_C_RESUME_IN_FRAME_SCRIPT = `(() => {
  var iframe = document.querySelector(${JSON.stringify(C_RESUME_IFRAME_SELECTOR)});
  if (!(iframe instanceof HTMLElement)) return false;
  var r = iframe.getBoundingClientRect();
  return r.width > 8 && r.height > 8;
})()`;

export async function frameHasVisibleCResumeIframe(frame: Frame): Promise<boolean> {
  try {
    return (await frame.evaluate(VISIBLE_C_RESUME_IN_FRAME_SCRIPT)) as boolean;
  } catch {
    return false;
  }
}

/** 截图文件名安全段（在线简历 / 推荐预览共用） */
export function safeResumeScreenshotFileBase(name: string): string {
  const t = name.replace(/[/\\?%*:|"<>]/g, '_').trim().slice(0, 64);
  return t.length > 0 ? t : 'candidate';
}

/** 关闭含 `c-resume` iframe 的弹层（聊天「在线简历」与推荐「预览」共用）。含 `.boss-popup__close`、`.btn-quxiao`（取消）等。会在主文档与各子 frame 中尝试。 */
export async function closeCResumePanel(page: Page): Promise<void> {
  try {
    for (let round = 0; round < 5; round++) {
      let closedAny = false;
      for (const frame of page.frames()) {
        try {
          const closed = (await frame.evaluate(CLOSE_C_RESUME_PANEL_SCRIPT)) as boolean;
          closedAny = closedAny || closed;
        } catch {
          /* detached / 无权限 */
        }
      }
      if (!closedAny) {
        break;
      }
      await sleepRandom(200, 450);
    }
  } catch {
    /* ignore */
  }
}

/**
 * 在任意 frame（含主 frame、`recommendFrame` 等）中查找已挂载且尺寸可见的 c-resume iframe。
 */
export async function findVisibleCResumeIframeHandle(page: Page): Promise<ElementHandle<Element> | null> {
  for (const frame of page.frames()) {
    try {
      if (!(await frameHasVisibleCResumeIframe(frame))) {
        continue;
      }
      const h = await frame.$(C_RESUME_IFRAME_SELECTOR);
      if (h) {
        return h;
      }
    } catch {
      /* detached */
    }
  }
  return null;
}

// A mounted, tall iframe can still contain only a watermark or an invisible body.
export const C_RESUME_CONTENT_STATE_SCRIPT = `(() => {
  const body = document.body;
  const text = body?.innerText?.trim() || '';
  const height = Math.max(body?.scrollHeight || 0, document.documentElement?.scrollHeight || 0);
  const conditions = { visibility: document.visibilityState, readyState: document.readyState, fonts: document.fonts.status };
  if (!body || document.visibilityState !== 'visible' || !['complete', 'interactive'].includes(document.readyState)) return { ready: false, text, height, visibleChars: 0, ...conditions };
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let node, visibleChars = 0;
  while ((node = walker.nextNode())) {
    const parent = node.parentElement;
    if (!node.textContent?.trim() || !parent || !parent.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) continue;
    const range = document.createRange(); range.selectNodeContents(node);
    if (range.getBoundingClientRect().width > 0) visibleChars += node.textContent.trim().length;
  }
  const canvases = Array.from(document.querySelectorAll('canvas')).filter(el =>
    el.width > 100 && el.height > 100 && el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true }) &&
    el.getBoundingClientRect().width > 100 && el.getBoundingClientRect().height > 100);
  const textReady = visibleChars >= 80 && /教育经历|工作经历|项目经历|个人优势|期望职位/.test(text);
  // BOSS also serves online resumes as one canvas with no DOM text. This is a
  // distinct renderer, accepted only after the caller verifies the target card.
  const mode = textReady ? 'text' : visibleChars === 0 && canvases.length === 1 ? 'canvas' : 'pending';
  const canvasRect = mode === 'canvas' ? canvases[0].getBoundingClientRect() : null;
  const canvas = canvasRect ? { width: canvases[0].width, height: canvases[0].height, cssTop: canvasRect.top, cssHeight: canvasRect.height } : null;
  const ready = mode !== 'pending' && height > 100 && document.fonts.status === 'loaded';
  return { ready, mode, canvas, text, height, visibleChars, ...conditions };
})()`;

/** A minimized Chrome window can return background-only screenshots despite a populated DOM. */
export async function prepareResumeCaptureWindow(page: Page): Promise<void> {
  const session = await page.createCDPSession();
  try {
    const { windowId, bounds } = await session.send('Browser.getWindowForTarget');
    bossDebug('resume.window', { state: bounds.windowState });
    if (bounds.windowState === 'minimized') await session.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await page.bringToFront();
  } finally { await session.detach(); }
}

export const C_RESUME_RESET_SCROLL_SCRIPT = `(() => {
  let changed = 0;
  for (const node of [document.documentElement, document.body, ...document.querySelectorAll('body *')]) {
    if (node && (node.scrollTop !== 0 || node.scrollLeft !== 0) && typeof node.scrollTo === 'function') {
      node.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      changed++;
    }
  }
  return changed;
})()`;

/** Reset the resume, its modal, and every containing frame before each capture. */
async function resetCResumeScrollPosition(content: Frame): Promise<number> {
  let changed = 0;
  for (let frame: Frame | null = content; frame; frame = frame.parentFrame()) {
    // String evaluate expressions must invoke themselves. An `el => ...` string
    // passed to ElementHandle.evaluate returns a function without running it.
    changed += await frame.evaluate(C_RESUME_RESET_SCROLL_SCRIPT) as number;
  }
  if (changed) bossDebug('resume.scroll-reset', { containers: changed });
  return changed;
}

/** ElementHandle.screenshot adds the owning frame's scroll offset to a box that
 * is already relative to the main frame. Use main-document coordinates once,
 * without screenshot's implicit scrollIntoView moving the prepared viewport. */
export async function captureCResumePng(page: Page, iframe: ElementHandle<Element>): Promise<Uint8Array> {
  const box = await iframe.boundingBox();
  if (!box || box.width <= 8 || box.height <= 8) throw new Error('在线简历截图区域不可见');
  const origin = await page.evaluate('(() => ({ x: window.scrollX, y: window.scrollY }))()') as { x: number; y: number };
  const clip = { x: box.x + origin.x, y: box.y + origin.y, width: box.width, height: box.height };
  bossDebug('resume.capture-region', clip);
  return page.screenshot({ type: 'png', captureBeyondViewport: true, clip });
}

export async function waitForVisibleCResumeIframeReady(
  page: Page,
  timeoutMs = 15_000,
  expectedName?: string,
  verifiedCanvasTarget = false,
  captureViewport?: NonNullable<Awaited<ReturnType<Page['viewport']>>>,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let previousSignature = '', stableSince = 0;
  let lastDiagnostic = '';
  while (Date.now() < deadline) {
    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) { previousSignature = ''; await sleepRandom(100, 180); continue; }
    try {
      const contentFrame = await iframe.contentFrame();
      if (contentFrame && await resetCResumeScrollPosition(contentFrame)) previousSignature = '';
      const box = await iframe.boundingBox();
      if (box && box.width > 8 && box.height > 8 && contentFrame) {
        const state = await contentFrame.evaluate(C_RESUME_CONTENT_STATE_SCRIPT) as { ready: boolean; mode?: string; canvas?: { width: number; height: number; cssTop: number; cssHeight: number } | null; text?: string; height?: number; visibleChars?: number; visibility?: string; readyState?: string; fonts?: string };
        const captureHeight = Math.ceil(Math.max((state.height || 0) + 200, box.y + box.height + 40));
        if (captureViewport && state.height && captureHeight > (page.viewport()?.height || 0)) {
          await setTempHeight(page, captureViewport, captureHeight);
          previousSignature = '';
          continue;
        }
        const targetMatches = state.mode === 'canvas' ? verifiedCanvasTarget : !expectedName || state.text?.includes(expectedName);
        const diagnostic = JSON.stringify({ ready: state.ready, mode: state.mode, canvas: state.canvas, textChars: state.text?.length, targetMatches, height: state.height, visibleChars: state.visibleChars, visibility: state.visibility, readyState: state.readyState, fonts: state.fonts, width: box.width, frameHeight: box.height });
        if (diagnostic !== lastDiagnostic) { bossDebug('resume.content-state', JSON.parse(diagnostic)); lastDiagnostic = diagnostic; }
        if (state.ready && targetMatches) {
          const signature = JSON.stringify([state.mode, state.canvas, state.text, state.height, box.x, box.y, box.width, box.height]);
          if (signature !== previousSignature) { previousSignature = signature; stableSince = Date.now(); }
          else if (Date.now() - stableSince >= 600) {
            if (state.mode === 'canvas') {
              if (captureViewport && state.canvas && (Math.abs(state.canvas.cssTop) > 1 || state.canvas.cssHeight < (state.height || 0) - 1)) {
                await sleepRandom(200, 300);
                continue;
              }
              // Size alone says nothing about whether the canvas has painted.
              // Wait for real screenshot pixels; never save this probe image.
              const quality = inspectResumePng(await captureCResumePng(page, iframe));
              bossDebug('resume.canvas-quality', quality);
              if (!quality.readable) { await sleepRandom(200, 300); continue; }
            }
            bossDebug('resume.content-ready', { height: state.height, visibleChars: state.visibleChars });
            return true;
          }
        } else previousSignature = '';
      } else previousSignature = '';
    } finally { await iframe.dispose(); }
    await sleepRandom(100, 180);
  }
  return false;
}

/**
 * 在已出现 `c-resume` iframe 的页面上，对 iframe 整框截图并关闭弹层。
 * `preOpenViewport` 为打开弹层前的视口快照，请用 `snapshotBossPageViewport(page)`（`page.viewport()` 常为 null 时勿直接用默认尺寸）。
 */
export async function captureCResumeIframeToFile(
  page: Page,
  preOpenViewport: Awaited<ReturnType<Page['viewport']>>,
  absPath: string,
  expectedName?: string,
  verifiedCanvasTarget = false,
): Promise<boolean> {
  try {
    await prepareResumeCaptureWindow(page);
    await setTempHeight(page, preOpenViewport);

    const iframe = await findVisibleCResumeIframeHandle(page);
    if (!iframe) {
      return false;
    }

    try {
      const ready = await bossTimed('resume.content_ready', () => waitForVisibleCResumeIframeReady(page, 15_000, expectedName, verifiedCanvasTarget, preOpenViewport || undefined));
      if (!ready) throw new Error('在线简历正文未显示或布局未稳定，未保存截图；请保持 BOSS 窗口可见后重新读取');
      const bytes = await bossTimed('resume.screenshot', () => captureCResumePng(page, iframe));
      const quality = inspectResumePng(bytes);
      bossDebug('resume.image-quality', quality);
      if (!quality.readable) throw new Error(`在线简历截图为空白或仅有水印，未保存（${quality.width}×${quality.height}，正文像素 ${quality.darkPixels}）；请保持 BOSS 窗口可见后重新读取`);
      await writeFile(absPath, bytes);
    } finally {
      await iframe.dispose();
    }

    await sleepRandom(
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
      C_RESUME_CLOSE_AFTER_CAPTURE_DELAY_MS,
    );
    await closeCResumePanel(page);
    return true;
  } finally {
    await resumeHeight(page, preOpenViewport);
  }
}
