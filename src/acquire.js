import { chromium } from 'playwright';
import { hash } from './dom.js';

export function checkUrl(input) {
  const url = new URL(input);
  if (!['http:','https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are supported');
  return url.href;
}
export async function fetchHtml(url) {
  const response = await fetch(checkUrl(url), { signal: AbortSignal.timeout(30000),
    headers: { 'User-Agent': 'PromptPlanScraper/1.0' } });
  if (!response.ok) throw new Error(`Page HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('URL did not return HTML');
  const max = 20 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > max) throw new Error('Page exceeds 20 MB limit');
    chunks.push(chunk);
  }
  return { html: Buffer.concat(chunks).toString('utf8'), url: response.url };
}
export async function openPage(url) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.route('**/*', route => ['image','media','font'].includes(route.request().resourceType())
      ? route.abort() : route.continue());
    const response = await page.goto(checkUrl(url), { waitUntil: 'domcontentloaded', timeout: 30000 });
    if (response && !response.ok()) throw new Error(`Browser page HTTP ${response.status()}`);
    await page.waitForTimeout(1500);
    return { browser, page, html: await page.content(), url: page.url() };
  } catch (err) { await browser.close(); throw err; }
}

// Extract each state before moving, so virtualized lists cannot lose earlier rows.
export async function walkPage(page, plan, onSnapshot, { maxSteps = 200, settleMs = 1200 } = {}) {
  let stable = 0, previous = '', steps = 0, pages = 1;
  const visited = new Set([page.url()]);
  for (; steps < maxSteps; steps++) {
    const html = await page.content();
    const rows = await onSnapshot(html, page.url());
    const state = await page.evaluate(selector => ({
      records: [...document.querySelectorAll(selector)].map(el => el.textContent),
      height: document.documentElement.scrollHeight,
      scrollY: window.scrollY,
      containers: [...document.querySelectorAll('body *')].filter(el => el.scrollHeight > el.clientHeight + 100
        && ['auto','scroll'].includes(getComputedStyle(el).overflowY)).map(el => [el.scrollHeight,el.scrollTop])
    }), plan.recordSelector);
    const fingerprint = hash(JSON.stringify({ rows, state }));
    stable = fingerprint === previous ? stable + 1 : 0;
    previous = fingerprint;
    let clicked = false;
    if (plan.loadMoreSelector) {
      const button = page.locator(plan.loadMoreSelector).first();
      if (await button.isVisible() && await button.isEnabled()) {
        await button.click({ timeout: 10000 }); clicked = true;
      }
    }
    if (stable >= 4 && !clicked) {
      if (plan.nextPageSelector) {
        const next = page.locator(plan.nextPageSelector).first();
        if (await next.isVisible() && await next.isEnabled()) {
          const href = await next.getAttribute('href');
          if (href && visited.has(new URL(href, page.url()).href)) return { stopReason: 'pagination-cycle', steps: steps + 1, pages };
          await next.click({ timeout: 10000 });
          await page.waitForTimeout(settleMs);
          visited.add(page.url()); pages++; stable = 0; previous = ''; continue;
        }
      }
      return { stopReason: 'stable-after-scroll', steps: steps + 1, pages };
    }
    // Advance one viewport so IntersectionObservers and virtualized rows are visited.
    await page.evaluate(() => {
      window.scrollBy(0, Math.max(500, innerHeight * 0.8));
      for (const el of document.querySelectorAll('body *')) {
        if (el.scrollHeight > el.clientHeight + 100 && ['auto','scroll'].includes(getComputedStyle(el).overflowY))
          el.scrollTop += Math.max(300, el.clientHeight * 0.8);
      }
    });
    await page.waitForTimeout(settleMs);
  }
  return { stopReason: 'max-steps', steps, pages };
}
