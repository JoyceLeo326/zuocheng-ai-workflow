import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('brand mark is the flat path-to-done system and ships everywhere', () => {
  const mark = read('apps', 'marketing', 'assets', 'brand', 'zuocheng-mark.svg');
  assert.match(mark, /data-brand-system="path-to-done-v2"/u);
  assert.doesNotMatch(mark, /linearGradient|radialGradient|filter=/u);
  assert.match(mark, /#D7FF4F/u);

  for (const target of [
    ['apps', 'student', 'public', 'brand', 'zuocheng-mark.svg'],
    ['apps', 'admin', 'public', 'brand', 'zuocheng-mark.svg'],
    ['apps', 'marketing', 'assets', 'brand', 'zuocheng-lockup.svg'],
    ['apps', 'marketing', 'assets', 'brand', 'zuocheng-favicon.svg'],
  ]) {
    assert.equal(fs.existsSync(path.join(root, ...target)), true, `${target.join('/')} is missing`);
  }
});

test('marketing begins with task archetypes and a visible outcome route', () => {
  const html = read('apps', 'marketing', 'index.html');
  const script = read('apps', 'marketing', 'script.js');

  assert.equal((html.match(/data-task-template=/gu) ?? []).length, 3);
  assert.match(html, /data-outcome-route/u);
  assert.match(html, /从任务到成品/u);
  assert.match(script, /applyTaskTemplate/u);
  assert.match(script, /data-task-template/u);
  assert.doesNotMatch(html, /做成■/u);
});

test('student and admin use the same real brand asset instead of a text square', () => {
  const student = read('apps', 'student', 'src', 'workbench', 'workbench-shell.tsx');
  const admin = read('apps', 'admin', 'src', 'admin-app.tsx');

  assert.match(student, /brand\/zuocheng-mark\.svg/u);
  assert.match(student, /workbench-outcome-bar/u);
  assert.match(admin, /brand\/zuocheng-mark\.svg/u);
  assert.doesNotMatch(student, /<span aria-hidden="true">■<\/span>/u);
});
