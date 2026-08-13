import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const qaDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(qaDir, '..');
const webRoot = path.join(root, 'apps', 'marketing', 'dist');

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].filter(Boolean);
  const executable = candidates.find((candidate) => fs.existsSync(candidate));
  if (!executable) throw new Error('Chrome, Edge, or Chromium is required for the marketing journey check.');
  return executable;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const filePath = path.resolve(webRoot, relativePath);
      if (!filePath.startsWith(`${webRoot}${path.sep}`)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      fs.readFile(filePath, (error, body) => {
        if (error) {
          response.writeHead(404).end('Not found');
          return;
        }
        const type = {
          '.css': 'text/css; charset=utf-8',
          '.html': 'text/html; charset=utf-8',
          '.js': 'text/javascript; charset=utf-8',
          '.json': 'application/json; charset=utf-8',
          '.pdf': 'application/pdf',
          '.webp': 'image/webp',
        }[path.extname(filePath)] || 'application/octet-stream';
        response.writeHead(200, { 'Cache-Control': 'no-store', 'Content-Type': type });
        response.end(body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, server }));
  });
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  return response.json();
}

async function waitForJson(url, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let lastError;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      return await requestJson(url);
    } catch (error) {
      lastError = error;
      await wait(150);
    }
  }
  throw lastError || new Error(`Timed out waiting for ${url}`);
}

class CdpPage {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.errors = [];
    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.errors.push(message.params.exceptionDetails?.exception?.description || message.params.exceptionDetails?.text || 'Runtime exception');
      }
      if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
        this.errors.push(message.params.entry.text);
      }
    };
  }

  send(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'Page evaluation failed');
    }
    return result.result?.value;
  }
}

async function openPage(debugPort, url) {
  const target = await requestJson(`http://127.0.0.1:${debugPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  const page = new CdpPage(socket);
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Log.enable');
  return page;
}

async function waitForExpression(page, expression, message, timeoutMs = 12_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await page.evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(message);
}

async function navigate(page, url, viewport) {
  await page.send('Emulation.setDeviceMetricsOverride', {
    deviceScaleFactor: viewport.scale,
    height: viewport.height,
    mobile: false,
    width: viewport.width,
  });
  await page.send('Page.navigate', { url });
  await waitForExpression(page, `document.readyState === 'complete'`, `${viewport.name} did not finish loading.`);
  await waitForExpression(page, `Boolean(window.ZuochengPlanner)`, `${viewport.name} planner did not load.`);
}

async function press(page, key, code, text = '') {
  const virtualKey = code === 'Enter' ? 13 : code === 'Space' ? 32 : 0;
  const payload = {
    code,
    key,
    nativeVirtualKeyCode: virtualKey,
    windowsVirtualKeyCode: virtualKey,
  };
  await page.send('Input.dispatchKeyEvent', { ...payload, text, type: 'keyDown' });
  await page.send('Input.dispatchKeyEvent', { ...payload, type: 'keyUp' });
}

async function activateFocused(page) {
  const activated = await page.evaluate(`(() => {
    const element = document.activeElement;
    if (!(element instanceof HTMLElement)) return false;
    element.click();
    return true;
  })()`);
  assert.equal(activated, true, 'No focused control was available for keyboard activation.');
}

async function focus(page, selector) {
  const focused = await page.evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!(element instanceof HTMLElement)) return false;
    element.scrollIntoView({ block: 'center' });
    element.focus();
    return document.activeElement === element;
  })()`);
  assert.equal(focused, true, `Could not focus ${selector}`);
}

async function waitForDownload(directory, before) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    const next = fs.readdirSync(directory).find((name) => !before.has(name) && !name.endsWith('.crdownload'));
    if (next) {
      const filePath = path.join(directory, next);
      if (fs.statSync(filePath).size > 0) return filePath;
    }
    await wait(100);
  }
  throw new Error('The confirmed task handoff did not create a real download.');
}

async function inspectCoreExperience(page) {
  return page.evaluate(`(() => {
    const visible = (element) => element instanceof HTMLElement && element.offsetParent !== null;
    const touchSelectors = [
      '.task-form input', '.task-form select', '.task-form textarea', '.task-generate',
      '.candidate-card', '.route-confirmation button:not(:disabled)', '.feedback-loop label',
      '.feedback-loop button:not(:disabled)',
    ];
    const touchTargets = touchSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter(visible)
      .map((element) => {
        const box = element.getBoundingClientRect();
        return { height: box.height, selector: element.matches('.candidate-card') ? '.candidate-card' : element.tagName, width: box.width };
      });
    const textSelectors = [
      '.task-form label > span', '.task-form-status', '.task-generate',
      '.candidate-card__copy p', '.candidate-card__copy small', '.candidate-card__score',
      '.route-confirmation p', '.route-confirmation button', '.feedback-loop legend',
      '.feedback-loop label', '.feedback-loop > p',
    ];
    const textSizes = textSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .filter(visible)
      .map((element) => ({ selector: element.className || element.tagName, size: Number.parseFloat(getComputedStyle(element).fontSize) }));
    const namedControls = [...document.querySelectorAll('.task-form input, .task-form select, .task-form textarea, .task-form button, .route-console button, .route-console input')]
      .filter(visible)
      .map((element) => ({
        name: element.getAttribute('aria-label') || element.labels?.[0]?.innerText?.trim() || element.innerText?.trim() || '',
        tag: element.tagName,
      }));
    return {
      clientWidth: document.documentElement.clientWidth,
      minFontSize: Math.min(...textSizes.map((item) => item.size)),
      minTouchSize: Math.min(...touchTargets.map((item) => Math.min(item.height, item.width))),
      scrollWidth: document.documentElement.scrollWidth,
      textSizes,
      unnamedControls: namedControls.filter((item) => !item.name),
    };
  })()`);
}

test('marketing task journey works at desktop and mobile widths', { timeout: 180_000 }, async () => {
  assert.equal(fs.existsSync(path.join(webRoot, 'index.html')), true, 'Build marketing before running the journey check.');
  const runRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'zuocheng-journey-'));
  const profile = path.join(runRoot, 'profile');
  const downloads = path.join(runRoot, 'downloads');
  fs.mkdirSync(profile);
  fs.mkdirSync(downloads);
  const { port, server } = await startServer();
  const debugPort = 10_100 + Math.floor(Math.random() * 400);
  const browser = childProcess.spawn(findBrowser(), [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-sandbox',
    '--hide-scrollbars',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    await waitForJson(`http://127.0.0.1:${debugPort}/json/version`);
    const url = `http://127.0.0.1:${port}/`;
    const page = await openPage(debugPort, url);
    const results = [];
    for (const viewport of [
      { height: 720, name: 'small', scale: 2, width: 320 },
      { height: 844, name: 'mobile', scale: 3, width: 390 },
      { height: 932, name: 'large-mobile', scale: 3, width: 430 },
      { height: 900, name: 'desktop', scale: 1, width: 1440 },
    ]) {
      const viewportDownloads = path.join(downloads, viewport.name);
      fs.mkdirSync(viewportDownloads);
      await page.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: viewportDownloads });
      await navigate(page, url, viewport);
      await page.evaluate(`localStorage.clear(); location.reload(); true`);
      await waitForExpression(page, `document.readyState === 'complete' && Boolean(window.ZuochengPlanner)`, `${viewport.name} did not reset.`);
      const deadline = new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      await page.evaluate(`(() => {
        const form = document.querySelector('[data-task-form]');
        const values = ${JSON.stringify({
          constraints: '只使用已经核验的课程材料；演讲不超过五分钟',
          dailyMinutes: '35',
          deliverable: '五页课程答辩稿',
          learnerRole: 'undergraduate',
          priority: 'evidence',
          taskName: '学院课程答辩',
        })};
        values.deadline = ${JSON.stringify(deadline)};
        for (const [name, value] of Object.entries(values)) {
          const field = form.elements.namedItem(name);
          field.value = value;
          field.dispatchEvent(new Event('input', { bubbles: true }));
          field.dispatchEvent(new Event('change', { bubbles: true }));
        }
        form.requestSubmit();
        return true;
      })()`);
      await waitForExpression(page, `document.querySelectorAll('[data-route-id]').length === 3`, `${viewport.name} did not render three comparable routes.`);

      const layout = await inspectCoreExperience(page);
      assert.equal(layout.scrollWidth, layout.clientWidth, `${viewport.name} has horizontal page overflow.`);
      assert.ok(layout.minTouchSize >= 44, `${viewport.name} has a ${layout.minTouchSize}px core touch target.`);
      assert.ok(layout.minFontSize >= 12, `${viewport.name} has ${layout.minFontSize}px core task text: ${JSON.stringify(layout.textSizes)}`);
      assert.deepEqual(layout.unnamedControls, [], `${viewport.name} has unnamed task controls.`);

      await focus(page, '[data-route-id="evidence"] input');
      await press(page, ' ', 'Space', ' ');
      await activateFocused(page);
      await waitForExpression(page, `document.querySelector('[data-confirm-route]').disabled === false`, `${viewport.name} could not select a route with the keyboard.`);
      await focus(page, '[data-confirm-route]');
      await press(page, 'Enter', 'Enter');
      await activateFocused(page);
      await waitForExpression(page, `document.querySelector('[data-download-handoff]').disabled === false`, `${viewport.name} could not confirm with the keyboard.`);

      const before = new Set(fs.readdirSync(viewportDownloads));
      await focus(page, '[data-download-handoff]');
      await press(page, 'Enter', 'Enter');
      await activateFocused(page);
      const downloadedPath = await waitForDownload(viewportDownloads, before);
      const handoff = fs.readFileSync(downloadedPath, 'utf8');
      assert.match(handoff, /学院课程答辩｜任务交付单/u);
      assert.match(handoff, /证据先行/u);
      assert.match(handoff, /同尺候选/u);

      await focus(page, '[data-feedback-form] input[value="too-slow"]');
      await press(page, ' ', 'Space', ' ');
      await activateFocused(page);
      await focus(page, '[data-feedback-form] button[type="submit"]');
      await press(page, 'Enter', 'Enter');
      await activateFocused(page);
      await waitForExpression(page, `document.querySelector('[data-decision-round]').textContent.includes('2')`, `${viewport.name} feedback did not create round two.`);
      const reranked = await page.evaluate(`(() => ({
        first: document.querySelector('[data-route-id]')?.dataset.routeId,
        status: document.querySelector('[data-feedback-status]')?.textContent,
      }))()`);
      assert.equal(reranked.first, 'delivery', `${viewport.name} feedback did not reorder the next round.`);
      assert.match(reranked.status, /反馈已进入下一轮/u);

      await page.send('Page.reload', { ignoreCache: true });
      await waitForExpression(page, `document.readyState === 'complete' && document.querySelector('[data-decision-round]')?.textContent.includes('2')`, `${viewport.name} did not restore the feedback round.`);
      const restoredFirst = await page.evaluate(`document.querySelector('[data-route-id]')?.dataset.routeId`);
      assert.equal(restoredFirst, 'delivery', `${viewport.name} restored the wrong candidate order.`);
      results.push({
        candidates: 3,
        downloadBytes: Buffer.byteLength(handoff),
        feedbackReranked: true,
        minFontSize: layout.minFontSize,
        minTouchSize: layout.minTouchSize,
        overflowX: layout.scrollWidth - layout.clientWidth,
        viewport: `${viewport.width}x${viewport.height}`,
      });
    }
    assert.deepEqual(page.errors, [], `Browser errors: ${page.errors.join(' | ')}`);
    process.stdout.write(`${JSON.stringify({ dualEndJourney: true, results })}\n`);
  } finally {
    server.close();
    browser.kill();
    await wait(250);
    fs.rmSync(runRoot, { force: true, recursive: true });
  }
});
