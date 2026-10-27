import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { captureCResumeIframeToFile } from '../dist/common/c_resume_capture.js';

// Isolated local fixture: no BOSS login, remote candidates, or messages.
// The recommendation document stays scrolled while a fixed resume opens inside it.
const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const outputRoot = resolve(fileURLToPath(new URL('../../data/diagnostics/', import.meta.url)));
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(join(outputRoot, 'resume-origin-'));
const server = createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/recommend') {
    res.end(`<style>body{margin:0;height:5000px}#panel{position:fixed;top:20px;left:30px;width:740px;height:calc(100vh - 40px);overflow:auto}iframe{display:block;border:0;width:700px;height:2400px}</style><div id="panel"><iframe src="/web/frame/c-resume"></iframe></div>`);
  } else if (req.url === '/web/frame/c-resume') {
    res.end(`<style>body{margin:0;font:20px sans-serif}#top{height:120px;background:rgb(20,80,180)}#bottom{height:120px;background:rgb(180,70,20)}#scroll{height:2400px;overflow:auto}#content{height:2400px;overflow:hidden}</style><div id="scroll"><div id="content"><div id="top">测试候选人 / AVATAR / HEADER</div><h2>教育经历 工作经历</h2>${'<p>可见正文 Resume content</p>'.repeat(20)}<div id="bottom" style="position:absolute;top:2280px;width:100%">END OF RESUME</div></div></div>`);
  } else {
    res.end('<style>body{margin:0;height:8000px}iframe{display:block;border:0;width:900px;height:100vh}</style><iframe src="/recommend"></iframe>');
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
let browser;
try {
  browser = await puppeteer.launch({ executablePath: chrome, headless: true, defaultViewport: { width: 1000, height: 800, deviceScaleFactor: 1 } });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction('document.querySelector("iframe")?.contentDocument?.querySelector("iframe")?.contentDocument?.querySelector("#top")');
  const recommend = page.frames().find(f => f.url().endsWith('/recommend'));
  const resume = page.frames().find(f => f.url().endsWith('/web/frame/c-resume'));
  for (const [index, [outerOffset, innerOffset]] of [[0,0], [350,0], [900,300], [0,600]].entries()) {
    await recommend.evaluate(`window.scrollTo(0, ${outerOffset})`);
    await resume.evaluate(`document.querySelector('#scroll').style.height='500px'; document.querySelector('#scroll').scrollTop=${innerOffset}`);
    const file = join(output, `capture-${index}.png`);
    await captureCResumeIframeToFile(page, { width: 1000, height: 800, deviceScaleFactor: 1 }, file, '测试候选人');
    const encoded = (await readFile(file)).toString('base64');
    const pixels = await page.evaluate(`(async () => {
      const image = new Image(); image.src = 'data:image/png;base64,${encoded}'; await image.decode();
      const canvas = document.createElement('canvas'); canvas.width=image.width; canvas.height=image.height;
      const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
      return { width:image.width,height:image.height,top:Array.from(ctx.getImageData(10,10,1,1).data) };
    })()`);
    assert.ok(pixels.top[2] > 150 && pixels.top[0] < 40 && pixels.top[1] > 50 && pixels.top[1] < 110, `capture ${index}, prior scroll ${outerOffset}/${innerOffset}: avatar/header must be at the top (${file}); got ${pixels.top}`);
    assert.equal(await recommend.evaluate('window.scrollY'), 0);
    assert.equal(await resume.evaluate('document.querySelector("#scroll").scrollTop'), 0);
    assert.deepEqual(page.viewport(), { width: 1000, height: 800, deviceScaleFactor: 1 });
    console.log(JSON.stringify({ capture:index, priorScroll:[outerOffset,innerOffset], headerAtTop:true, ...pixels }));
  }
  console.log(`Consecutive nested-frame resume origins passed. Images: ${output}`);
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
