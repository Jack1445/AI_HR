import type { Page } from 'puppeteer-core';
import { SIDEBAR_NAV_AFTER_CLICK_MS, sleepRandom } from '../browser/index.js';
import { bossDebug } from './debug.js';

const SIDEBAR_NAV_WAIT_MS = 15_000;

/**
 * 点击 Boss 左侧 `.menu-list` 中的菜单项，并等待导航到给定 pathname（如 `/web/chat/index`）。
 */
export async function clickBossSidebarMenuToPath(
  page: Page,
  menuLabel: string,
  targetPath: string,
): Promise<void> {
  bossDebug('sidebar-search-start', {
    currentUrl: page.url(),
    menuLabel,
    targetPath,
  });
  const clicked = await page.evaluate(
    ({ label, path }) => {
      const norm = (v: string | null | undefined) => (v ?? '').replace(/\s+/g, '');
      const links = Array.from(document.querySelectorAll('.menu-list a'));
      const target = links.find((a) => {
        const href = a.getAttribute('href') ?? '';
        if (href.includes(path)) {
          return true;
        }
        const text = norm(a.querySelector('.menu-item-content span')?.textContent ?? a.textContent);
        return text.includes(label);
      });
      if (!(target instanceof HTMLElement)) {
        return null;
      }
      target.scrollIntoView({ block: 'center', inline: 'nearest' });
      target.click();
      return true;
    },
    { label: menuLabel, path: targetPath },
  );

  bossDebug('sidebar-search-result', { clicked });

  if (!clicked) {
    throw new Error(`未找到侧边栏菜单“${menuLabel}”，无法跳转到 ${targetPath}。`);
  }
  bossDebug('sidebar-click-sent', { menuLabel, targetPath });

  await sleepRandom(SIDEBAR_NAV_AFTER_CLICK_MS.min, SIDEBAR_NAV_AFTER_CLICK_MS.max);

  try {
    await page.waitForFunction(
      `((path) => {
        try {
          const p = window.location.pathname.replace(/\\/+$/, "") || "/";
          return p === path;
        } catch {
          return false;
        }
      })`,
      { timeout: SIDEBAR_NAV_WAIT_MS },
      targetPath,
    );
    bossDebug('sidebar-navigation-complete', { currentUrl: page.url() });
  } catch (error) {
    bossDebug('sidebar-navigation-failed', {
      currentUrl: page.url(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
