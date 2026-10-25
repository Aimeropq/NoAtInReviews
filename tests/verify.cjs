'use strict';

// 本地 DOM/布局验证，无网络请求、无模型调用。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const base = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(base, 'bilibili-hide-mentions.user.js'), 'utf8');
const results = [];
const errors = [];
const MARK = 'data-bili-at-filter-hidden';
let browser;

async function check(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
  } catch (error) {
    results.push({ name, passed: false, error: error.message });
  }
}

async function openFixture(host = 'www.bilibili.com', pathname = '/video/offline-fixture') {
  const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => route.request().isNavigationRequest()
    ? route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta charset="utf-8">
      <style>body{margin:20px;font:16px sans-serif}.reply-item,.sub-reply-item,.list-item,.reply-wrap{padding:10px 0;border-bottom:1px solid #ccc}bili-comment-thread-renderer,bili-comment-reply-renderer{display:block}</style>
      </head><body><div class="bb-comment"><div class="reply-list" id="legacy"></div></div><bili-comments id="modern"></bili-comments></body></html>` })
    : route.abort());
  await page.addInitScript({ content: source });
  await page.goto(`https://${host}${pathname}`, { waitUntil: 'load' });
  return page;
}

async function setUp(page) {
  await page.evaluate(() => {
    const modern = document.querySelector('#modern');
    modern.attachShadow({ mode: 'open' }).innerHTML = '<div id="feed"></div>';
    window.fixture = {
      mention: name => `<a data-type="mention" data-user-profile-id="123" href="//space.bilibili.com/123">@${name}</a>`,
      oldMention: name => `<a class="user" href="//space.bilibili.com/456?from=reply">@${name}</a>`,
      modern(id, text, reply = false, parentId = null, delayed = false) {
        const feed = modern.shadowRoot.querySelector('#feed');
        let thread;
        if (parentId) thread = feed.querySelector(`#${parentId}`);
        else {
          thread = document.createElement('bili-comment-thread-renderer');
          thread.id = reply ? `${id}-thread` : id;
          thread.attachShadow({ mode: 'open' }).innerHTML = '<div id="replies"></div>';
          feed.append(thread);
        }
        const row = document.createElement(reply ? 'bili-comment-reply-renderer' : 'bili-comment-renderer');
        row.id = `${id}-row`;
        const mount = () => {
          const root = row.attachShadow({ mode: 'open' });
          root.innerHTML = '<div id="main"><bili-comment-user-info><a href="//space.bilibili.com/123">@作者昵称</a></bili-comment-user-info><bili-rich-text></bili-rich-text></div><div id="footer">回复 点赞</div>';
          const rich = root.querySelector('bili-rich-text');
          rich.attachShadow({ mode: 'open' }).innerHTML = `<p id="contents">${text}</p>`;
        };
        if (!delayed) mount();
        const destination = reply ? thread.shadowRoot.querySelector('#replies') : thread.shadowRoot;
        destination.append(row);
        if (delayed) window.fixture.mountLate = mount;
        return row;
      },
      legacy(id, text, options = {}) {
        const row = document.createElement('div');
        row.id = id;
        row.className = options.className || (options.reply ? 'sub-reply-item' : 'reply-item');
        row.innerHTML = options.old
          ? `<div class="con"><div class="user"><a href="//space.bilibili.com/123">@作者昵称</a></div><p class="text">${text}</p></div>`
          : `<div class="user"><a href="//space.bilibili.com/123">@作者昵称</a></div><div class="reply-content">${text}</div>`;
        (options.parent || document.querySelector('#legacy')).append(row);
        return row;
      },
      target(id) {
        return document.getElementById(id) || modern.shadowRoot.querySelector(`#${id}`) ||
          Array.from(modern.shadowRoot.querySelectorAll('bili-comment-thread-renderer'))
            .map(t => t.shadowRoot.querySelector(`#${id}`)).find(Boolean);
      },
    };
  });
}

async function state(page, id, expectedHidden) {
  await page.waitForFunction(({ id, expectedHidden, MARK }) => {
    const node = window.fixture.target(id);
    return Boolean(node) && (getComputedStyle(node).display === 'none') === expectedHidden &&
      node.hasAttribute(MARK) === expectedHidden;
  }, { id, expectedHidden, MARK }, { timeout: 3500 });
}

(async () => {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BILI_TEST_CHROMIUM || undefined });
  const page = await openFixture();
  await setUp(page);

  await check('新版：主评论正文真实提及，隐藏外层整楼', async () => {
    await page.evaluate(() => fixture.modern('modern-at', `正文 ${fixture.mention('朋友')} 来看`));
    await state(page, 'modern-at', true);
  });
  await check('新版：普通 @、邮箱和未链接的 @用户名保留', async () => {
    await page.evaluate(() => fixture.modern('modern-plain', '@ 符号 a@b.com @未选择用户'));
    await state(page, 'modern-plain', false);
  });
  await check('新版：作者昵称里的 @ 不触发', async () => {
    await page.evaluate(() => fixture.modern('modern-author', '正常正文'));
    await state(page, 'modern-author', false);
  });
  await check('新版：楼中楼只有自动回复前缀时保留', async () => {
    await page.evaluate(() => fixture.modern('modern-prefix', `回复 ${fixture.mention('朋友')} : 正常回复`, true, 'modern-plain'));
    await state(page, 'modern-prefix-row', false);
  });
  await check('新版：前缀之后再次 @ 同一用户仍隐藏', async () => {
    await page.evaluate(() => fixture.modern('modern-again', `回复 ${fixture.mention('朋友')} : 再叫 ${fixture.mention('朋友')}`, true, 'modern-plain'));
    await state(page, 'modern-again-row', true);
    await state(page, 'modern-plain', false);
    await state(page, 'modern-prefix-row', false);
  });
  await check('新版：主评论不豁免回复前缀', async () => {
    await page.evaluate(() => fixture.modern('modern-root-prefix', `回复 ${fixture.mention('朋友')}：正文`));
    await state(page, 'modern-root-prefix', true);
  });
  await check('新版：无前缀的首个正文提及仍隐藏', async () => {
    await page.evaluate(() => fixture.modern('modern-first-at', `${fixture.mention('朋友')}：正文`, true, 'modern-plain'));
    await state(page, 'modern-first-at-row', true);
  });
  await check('新版：英文回复前缀保留', async () => {
    await page.evaluate(() => fixture.modern('modern-en', `Reply to ${fixture.mention('朋友')} : hello`, true, 'modern-plain'));
    await state(page, 'modern-en-row', false);
  });
  await check('新版：缺少冒号的“回复 @”作为正文提及隐藏', async () => {
    await page.evaluate(() => fixture.modern('modern-no-colon', `回复 ${fixture.mention('朋友')} 正文`, true, 'modern-plain'));
    await state(page, 'modern-no-colon-row', true);
  });
  await check('新版：主评论隐藏后，普通子回复也没有布局占位', async () => {
    await page.evaluate(() => fixture.modern('modern-child', '正常子回复', true, 'modern-at'));
    assert.equal(await page.evaluate(() => fixture.target('modern-child-row').getClientRects().length), 0);
  });
  await check('新版：隐藏整楼不影响相邻评论的连续布局', async () => {
    await page.evaluate(() => {
      fixture.modern('layout-a', '前一条');
      fixture.modern('layout-hidden', fixture.mention('朋友'));
      fixture.modern('layout-b', '后一条');
    });
    await state(page, 'layout-hidden', true);
    const delta = await page.evaluate(() => fixture.target('layout-b').getBoundingClientRect().top - fixture.target('layout-a').getBoundingClientRect().bottom);
    assert.equal(delta, 0);
  });
  await check('旧版：正文指向用户空间的 @ 链接隐藏', async () => {
    await page.evaluate(() => fixture.legacy('old-at', fixture.oldMention('朋友'), { old: true, className: 'list-item' }));
    await state(page, 'old-at', true);
  });
  await check('旧版：普通 @、邮箱、mailto 和非用户空间链接保留', async () => {
    await page.evaluate(() => fixture.legacy('old-plain', '@ a@b.com <a href="mailto:a@b.com">a@b.com</a> <a href="https://example.com">@示例</a> <a href="//space.bilibili.com">@空间首页</a>'));
    await state(page, 'old-plain', false);
  });
  await check('旧版：普通作者的空间链接不触发', async () => {
    await page.evaluate(() => fixture.legacy('old-author', '正文正常'));
    await state(page, 'old-author', false);
  });
  await check('旧版：回复前缀保留，另有正文提及则只隐藏该子回复', async () => {
    await page.evaluate(() => {
      const parent = document.createElement('div');
      parent.className = 'sub-reply-container';
      document.querySelector('#old-author').append(parent);
      fixture.legacy('old-prefix', `回复 ${fixture.oldMention('朋友')}：正常正文`, { reply: true, parent });
      fixture.legacy('old-extra', `回复 ${fixture.oldMention('朋友')}：来看 ${fixture.oldMention('别人')}`, { reply: true, parent });
    });
    await state(page, 'old-prefix', false);
    await state(page, 'old-extra', true);
    await state(page, 'old-author', false);
  });
  await check('旧版：分离在正文外的自动回复对象保留', async () => {
    await page.evaluate(() => {
      const row = fixture.legacy('old-separate-prefix', '正常正文', { reply: true });
      row.insertAdjacentHTML('afterbegin', `<span class="reply-to">回复 ${fixture.oldMention('朋友')}：</span>`);
    });
    await state(page, 'old-separate-prefix', false);
  });
  await check('旧版：老 .reply-box 回复结构的前缀保留', async () => {
    await page.evaluate(() => {
      const parent = document.createElement('div');
      parent.className = 'reply-box';
      document.querySelector('#old-author').append(parent);
      fixture.legacy('old-box', `回复 ${fixture.oldMention('朋友')} : 正文`, { old: true, parent });
    });
    await state(page, 'old-box', false);
  });
  await check('旧版：主评论命中时正常子回复也不占位', async () => {
    await page.evaluate(() => {
      const root = fixture.legacy('old-thread', fixture.oldMention('朋友'));
      const parent = document.createElement('div');
      parent.className = 'sub-reply-container';
      root.append(parent);
      fixture.legacy('old-child', '正常子回复', { reply: true, parent });
    });
    await state(page, 'old-thread', true);
    assert.equal(await page.evaluate(() => fixture.target('old-child').getClientRects().length), 0);
  });
  await check('旧版：隐藏评论无空白占位', async () => {
    await page.evaluate(() => {
      fixture.legacy('old-layout-a', '前一条');
      fixture.legacy('old-layout-hidden', fixture.oldMention('朋友'));
      fixture.legacy('old-layout-b', '后一条');
    });
    await state(page, 'old-layout-hidden', true);
    assert.equal(await page.evaluate(() => fixture.target('old-layout-b').getBoundingClientRect().top - fixture.target('old-layout-a').getBoundingClientRect().bottom), 0);
  });
  await check('隔离：评论区以外相同类名不隐藏', async () => {
    await page.evaluate(() => fixture.legacy('outside', fixture.oldMention('朋友'), { parent: document.body }));
    await state(page, 'outside', false);
  });
  await check('隔离：视频弹幕、私信面板和编辑框中的相同标记不隐藏', async () => {
    await page.evaluate(() => {
      for (const className of ['bpx-player-container', 'chat-content', 'message-list']) {
        const area = document.createElement('div');
        area.className = className;
        document.body.append(area);
        area.innerHTML = '<div class="comment-list"></div>';
        fixture.legacy(`ignore-${className}`, fixture.oldMention('朋友'), { parent: area.firstElementChild });
      }
      const editor = document.createElement('div');
      editor.contentEditable = 'true';
      document.querySelector('#legacy').append(editor);
      fixture.legacy('ignore-editor', fixture.oldMention('朋友'), { parent: editor });
    });
    for (const id of ['ignore-bpx-player-container', 'ignore-chat-content', 'ignore-message-list', 'ignore-editor']) await state(page, id, false);
  });
  await check('异步：已连接宿主稍后创建的多层 ShadowRoot 能处理', async () => {
    await page.evaluate(() => fixture.modern('late', fixture.mention('朋友'), false, null, true));
    await page.evaluate(() => fixture.mountLate());
    await state(page, 'late', true);
  });
  await check('更新：已隐藏的正文改为普通 @ 后恢复', async () => {
    await page.evaluate(() => fixture.target('late-row').shadowRoot.querySelector('bili-rich-text').shadowRoot.querySelector('#contents').textContent = '@ 普通字符');
    await state(page, 'late', false);
  });
  await check('更新：原有节点的 href 改为用户空间后重新识别', async () => {
    await page.evaluate(() => fixture.legacy('href-change', '<a href="https://example.com">@朋友</a>'));
    await state(page, 'href-change', false);
    await page.evaluate(() => fixture.target('href-change').querySelector('.reply-content a').href = 'https://space.bilibili.com/789');
    await state(page, 'href-change', true);
  });
  await check('更新：text 节点变化重新识别，普通 @ 链接不误杀', async () => {
    await page.evaluate(() => fixture.target('href-change').querySelector('.reply-content a').firstChild.data = '@');
    await state(page, 'href-change', false);
  });
  await check('更新：ShadowRoot 内容重建后样式和隐藏仍有效', async () => {
    await page.evaluate(() => fixture.target('late-row').shadowRoot.querySelector('bili-rich-text').shadowRoot.innerHTML = `<p id="contents">${fixture.mention('朋友')}</p>`);
    await state(page, 'late', true);
  });
  await check('更新：评论移出评论区后撤销脚本隐藏', async () => {
    await page.evaluate(() => document.body.append(fixture.target('old-layout-hidden')));
    await state(page, 'old-layout-hidden', false);
  });
  await check('动态：替换评论根后继续过滤新评论', async () => {
    await page.evaluate(() => {
      const root = document.createElement('div');
      root.className = 'bili-dyn-comment';
      document.body.append(root);
      fixture.legacy('new-dynamic', fixture.oldMention('朋友'), { parent: root });
    });
    await state(page, 'new-dynamic', true);
  });
  await check('资料：语言前缀用户空间链接可识别，仿冒域名不触发', async () => {
    await page.evaluate(() => {
      fixture.legacy('locale-link', '<a href="//space.bilibili.com/en/123">@朋友</a>');
      fixture.legacy('fake-link', '<a href="https://space.bilibili.com.example.com/123">@朋友</a>');
    });
    await state(page, 'locale-link', true);
    await state(page, 'fake-link', false);
  });
  await check('元数据：限定 B站域名，明确排除私信和直播，零额外权限', async () => {
    assert.match(source, /@match\s+\*:\/\/\*\.bilibili\.com\/\*/);
    for (const host of ['message', 'live']) assert.ok(source.includes(`@exclude      *://${host}.bilibili.com/*`));
    assert.match(source, /@grant\s+none/);
    assert.match(source, /@noframes/);
    assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|GM_xmlhttpRequest|document\.cookie|localStorage|attachShadow\s*=/);
  });

  await page.screenshot({ path: path.join(base, 'tests', 'verification.png'), fullPage: true });
  await page.close();

  for (const host of ['t.bilibili.com', 'space.bilibili.com', 'www.bilibili.com']) {
    await check(`页面覆盖：${host} 评论结构正常工作`, async () => {
      const other = await openFixture(host, host === 'www.bilibili.com' ? '/opus/offline-fixture' : '/offline-fixture');
      await setUp(other);
      await other.evaluate(() => {
        fixture.modern('site-at', fixture.mention('朋友'));
        fixture.legacy('site-plain', '@ 普通字符');
      });
      await state(other, 'site-at', true);
      await state(other, 'site-plain', false);
      await other.close();
    });
  }
  for (const host of ['message.bilibili.com', 'live.bilibili.com', 'foo.live.bilibili.com', 'im.bilibili.com', 'example.com']) {
    await check(`域名隔离：${host} 不启动过滤`, async () => {
      const other = await openFixture(host);
      await setUp(other);
      await other.evaluate(() => fixture.legacy('excluded', fixture.oldMention('朋友')));
      await state(other, 'excluded', false);
      assert.equal(await other.locator(`[data-bili-at-filter-style]`).count(), 0);
      await other.close();
    });
  }
  await check('运行时：没有未捕获异常', async () => assert.deepEqual(errors, []));

  const report = {
    timestamp: new Date().toISOString(),
    environment: 'Playwright Chromium; offline fixtures based on inspected Bilibili comment markup',
    network: 'All page requests fulfilled locally or aborted; no Bilibili API calls',
    passed: results.filter(r => r.passed).length,
    failed: results.filter(r => !r.passed).length,
    results,
    limitations: ['未安装到用户油猴扩展中验证', '未登录 B站逐页验收；域名覆盖测试使用本地模拟页面'],
  };
  fs.writeFileSync(path.join(base, 'tests', 'results.json'), JSON.stringify(report, null, 2) + '\n');
  for (const result of results) console.log(`${result.passed ? 'PASS' : 'FAIL'} ${result.name}${result.error ? `: ${result.error}` : ''}`);
  console.log(`TOTAL ${report.passed} passed; ${report.failed} failed`);
  process.exitCode = report.failed ? 1 : 0;
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
});
