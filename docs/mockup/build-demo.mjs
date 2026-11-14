#!/usr/bin/env node
// 화면 데모 사이트를 docs/mockup/_site/에 조립한다. 로컬과 GitHub Actions(pages.yml)가 같은 스크립트를 쓴다.
//
//   node docs/mockup/build-demo.mjs
//
// 만들어지는 것
//   _site/index.html   목차(docs/mockup/index.html 그대로)
//   _site/app.html     빌드한 웹 화면 + 맨 앞에 demo.js(가짜 서버)
//   _site/assets/…     웹 화면 자산(vite build --base=./ 결과)
//   _site/demo.js      가짜 서버
//   _site/canvas/…     디자인 캔버스 원본(브라우저에서는 열리지 않음, 보관용)
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const webDir = join(root, 'web');
const site = join(here, '_site');
const tmp = join(site, '_build');

rmSync(site, { recursive: true, force: true });
mkdirSync(site, { recursive: true });

// 1) 웹 화면을 상대 경로로 빌드한다(GitHub Pages는 /c-monitor/ 같은 하위 경로에서 서빙된다).
const { build } = await import('vite');
await build({
  root: webDir,
  configFile: join(webDir, 'vite.config.ts'),
  base: './',
  logLevel: 'warn',
  build: { outDir: tmp, emptyOutDir: true },
});

// 2) 빌드된 index.html에서 자산 태그를 떼어 내고, 그 목록과 demo.js를 맨 앞에 넣어 app.html로 만든다.
//    demo.js가 주소를 /settings 등으로 바꾼 뒤 원래 위치 기준으로 자산을 직접 불러온다.
let html = readFileSync(join(tmp, 'index.html'), 'utf8');
const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`, 'i').exec(tag)?.[1] ?? null;
const clean = (p) => p.replace(/^\.\//, '');
const css = [];
const js = [];
html = html.replace(/<script\b[^>]*><\/script>\s*/gi, (tag) => {
  const src = attr(tag, 'src');
  if (attr(tag, 'type') !== 'module' || !src) return tag;
  js.push(clean(src));
  return '';
});
html = html.replace(/<link\b[^>]*>\s*/gi, (tag) => {
  const rel = attr(tag, 'rel');
  const href = attr(tag, 'href');
  if (rel === 'stylesheet' && href) { css.push(clean(href)); return ''; }
  if (rel === 'modulepreload') return '';
  return tag;
});
if (js.length === 0) throw new Error('빌드 결과에서 앱 스크립트를 찾지 못했습니다.');

const demoSrc = readFileSync(join(here, 'demo', 'demo.js'));
const ver = createHash('sha256').update(demoSrc).digest('hex').slice(0, 10);
// 파비콘을 넣어 두지 않으면 브라우저가 사이트 맨 위 /favicon.ico를 찾다 404를 낸다.
const ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%231268E6'/%3E%3Cpath d='M5 16h5l4-9 5 18 4-9h4' fill='none' stroke='%23fff' stroke-width='2.4' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E";
const inject = [
  `<link rel="icon" href="${ICON}">`,
  `<script>window.__CMON_DEMO_ASSETS__=${JSON.stringify({ css, js })};</script>`,
  `<script src="./demo.js?v=${ver}"></script>`,
].join('\n    ');
if (!/<\/head>/i.test(html)) throw new Error('빌드된 index.html에 </head>가 없습니다.');
html = html
  .replace(/\s*<\/head>/i, `\n    ${inject}\n  </head>`)
  .replace(/<title>[^<]*<\/title>/i, '<title>C-Monitor 데모</title>');
writeFileSync(join(site, 'app.html'), html);

// 3) 자산·가짜 서버·목차·캔버스 원본을 모은다.
renameSync(join(tmp, 'assets'), join(site, 'assets'));
rmSync(tmp, { recursive: true, force: true });
writeFileSync(join(site, 'demo.js'), demoSrc);
cpSync(join(here, 'index.html'), join(site, 'index.html'));
const canvas = join(here, 'canvas');
if (existsSync(canvas)) cpSync(canvas, join(site, 'canvas'), { recursive: true });

console.log(`데모 사이트를 만들었습니다: ${site}`);
console.log(`  app.html 자산: ${[...css, ...js].join(', ')}`);
