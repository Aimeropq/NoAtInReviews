// ==UserScript==
// @name         B站评论屏蔽正文中的 @用户
// @namespace    local.bilibili.hide-mentions
// @version      1.0.1
// @description  隐藏评论正文含真实用户提及的整条评论；保留普通 @ 和楼中楼的回复前缀。
// @homepageURL  https://github.com/Aimeropq/NoAtInReviews
// @downloadURL  https://raw.githubusercontent.com/Aimeropq/NoAtInReviews/main/bilibili-hide-mentions.user.js
// @updateURL    https://raw.githubusercontent.com/Aimeropq/NoAtInReviews/main/bilibili-hide-mentions.user.js
// @match        *://*.bilibili.com/*
// @exclude      *://message.bilibili.com/*
// @exclude      *://*.message.bilibili.com/*
// @exclude      *://live.bilibili.com/*
// @exclude      *://*.live.bilibili.com/*
// @exclude      *://im.bilibili.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  if (!/(^|\.)bilibili\.com$/i.test(location.hostname) ||
      /(^|\.)(message|live|im)\.bilibili\.com$/i.test(location.hostname)) return;

  const MODERN_ROW = 'bili-comment-renderer, bili-comment-reply-renderer';
  const LEGACY_ROW = '.reply-item, .sub-reply-item, .list-item, .reply-wrap';
  const ROW = `${MODERN_ROW}, ${LEGACY_ROW}`;
  const COMMENT_AREA = [
    'bili-comments', 'bili-comments-popup', '.bb-comment', '.bili-comment',
    '.bili-comments', '.bili-dyn-comment', '.reply-list', '.comment-list',
  ].join(',');
  const IGNORE = [
    '.bpx-player-container', '.bilibili-player', '.bili-danmaku-x-video',
    '.danmaku-item', '.barrage-container', '.chat-history', '.chat-content',
    '.message-list', '.msg-list', '.im-container', '.whisper',
    'bili-comment-box', 'bili-comment-rich-textarea', 'bili-comment-textarea',
    '[contenteditable]:not([contenteditable="false"])', 'textarea', 'input',
  ].join(',');
  const MARK = 'data-bili-at-filter-hidden';
  const STYLE_MARK = 'data-bili-at-filter-style';
  const CSS = `[${MARK}="1"] { display: none !important; }
    :host([${MARK}="1"]) { display: none !important; }`;
  const observers = new Map();
  const styles = new WeakMap();
  const targets = new WeakMap();
  const pendingHosts = new Set();
  const queuedRows = new Set();
  let scheduled = false;

  function elementOf(node) {
    if (!node) return null;
    return node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement || node.host || null;
  }

  function parentOf(element) {
    return element.parentElement || element.getRootNode().host || null;
  }

  function closestAcross(node, selector) {
    for (let element = elementOf(node); element; element = element.getRootNode().host || null) {
      const found = element.closest(selector);
      if (found) return found;
    }
    return null;
  }

  function ignored(node) {
    return Boolean(closestAcross(node, IGNORE));
  }

  function ensureStyle(root) {
    const previous = styles.get(root);
    if (previous?.getRootNode() === root) return;
    const parent = root === document ? document.head || document.documentElement : root;
    if (!parent) return;
    const style = document.createElement('style');
    style.setAttribute(STYLE_MARK, '');
    style.textContent = CSS;
    styles.set(root, style);
    parent.appendChild(style);
  }

  function queueRow(node) {
    const row = closestAcross(node, ROW);
    if (!row) return;
    queuedRows.add(row);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      const rows = [...queuedRows];
      queuedRows.clear();
      for (const item of rows) if (item.isConnected) processRow(item);
    });
  }

  // 每个 open ShadowRoot 单独监听；不修改 attachShadow 或网站的网络请求。
  function watchRoot(root) {
    if (observers.has(root)) return;
    const observer = new MutationObserver(records => {
      ensureStyle(root);
      for (const record of records) {
        if (ignored(record.target)) continue;
        queueRow(record.target);
        if (record.type === 'childList') {
          for (const node of record.addedNodes) discover(node);
        } else if (record.type === 'attributes' && record.attributeName === 'class') {
          discover(record.target);
        }
      }
    });
    observers.set(root, observer);
    observer.observe(root, {
      childList: true, subtree: true, characterData: true,
      attributes: true, attributeFilter: ['href', 'data-type', 'data-user-profile-id', 'class'],
    });
    ensureStyle(root);
    if (root.host) queueRow(root.host);
    discover(root);
  }

  function inspect(element) {
    if (ignored(element) || element.matches('style, script, link')) return;
    if (element.matches(ROW)) queueRow(element);
    if (element.shadowRoot) {
      pendingHosts.delete(element);
      watchRoot(element.shadowRoot);
    } else if (element.localName.includes('-')) {
      // 已插入的自定义元素可能稍后才创建 ShadowRoot。
      pendingHosts.add(element);
    }
  }

  function discover(node) {
    if (ignored(node)) return;
    if (node.nodeType === Node.ELEMENT_NODE) inspect(node);
    if (node.querySelectorAll) for (const element of node.querySelectorAll('*')) inspect(element);
    queueRow(node);
  }

  function isReply(row) {
    return row.localName === 'bili-comment-reply-renderer' ||
      row.matches('.sub-reply-item') ||
      Boolean(closestAcross(parentOf(row), '.reply-box, .sub-reply-container, .sub-reply-list'));
  }

  function bodiesOf(row) {
    if (row.matches(MODERN_ROW)) {
      // 不扫描用户名、头像、操作栏、引用卡片或子回复。
      const richText = row.shadowRoot?.querySelector('bili-rich-text');
      const contents = richText?.shadowRoot?.querySelector('#contents');
      return contents ? [contents] : [];
    }
    for (const selector of [
      '.reply-content', '.con > .text, .reply-con > .text', '.reply-content-container',
    ]) {
      const bodies = [...row.querySelectorAll(selector)].filter(body => body.closest(ROW) === row);
      if (bodies.length) return bodies;
    }
    return [];
  }

  function isMention(element) {
    const text = element.textContent.replace(/[\u200b-\u200f\ufeff]/g, '').trim();
    if (!text.startsWith('@') || !text.slice(1).trim()) return false;
    if (element.matches('a[data-type="mention"]')) return true;
    if (!element.matches('a[href]')) return false;
    try {
      const url = new URL(element.getAttribute('href'), location.href);
      return /^https?:$/.test(url.protocol) && url.hostname === 'space.bilibili.com' &&
        /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?[1-9]\d*(?:\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function prefixMention(body, mentions, reply) {
    if (!reply || !mentions.length) return null;
    const first = mentions[0];
    const before = document.createRange();
    before.selectNodeContents(body);
    before.setEndBefore(first);
    const leading = before.toString().replace(/[\u200b-\u200f\ufeff]/g, '').trim();
    if (!/^(?:回复|回覆|回復|reply(?:\s+to)?)\s*$/i.test(leading)) return null;
    const after = document.createRange();
    after.selectNodeContents(body);
    after.setStartAfter(first);
    return /^\s*[:：]/.test(after.toString()) ? first : null;
  }

  function bodyHasMention(body, reply) {
    const mentions = [...body.querySelectorAll('a[data-type="mention"], a[href]')].filter(isMention);
    const prefix = prefixMention(body, mentions, reply);
    return mentions.some(mention => mention !== prefix);
  }

  function hideTarget(row) {
    if (row.localName === 'bili-comment-renderer') {
      // 隐藏外层整楼，连同分隔线、楼中楼和边距一起退出布局。
      return closestAcross(parentOf(row), 'bili-comment-thread-renderer') || row;
    }
    return row.parentElement?.matches('.reply-item-wrap') ? row.parentElement : row;
  }

  function processRow(row) {
    const previous = targets.get(row);
    const target = hideTarget(row);
    const valid = !ignored(row) && Boolean(closestAcross(row, COMMENT_AREA));
    const hidden = valid && bodiesOf(row).some(body => bodyHasMention(body, isReply(row)));
    if (previous && previous !== target) previous.removeAttribute(MARK);
    if (hidden) {
      ensureStyle(target.getRootNode());
      if (target.shadowRoot) ensureStyle(target.shadowRoot);
      target.setAttribute(MARK, '1');
      targets.set(row, target);
    } else {
      (previous || target).removeAttribute(MARK);
      targets.delete(row);
    }
  }

  watchRoot(document);
  // 只检查尚未创建 ShadowRoot 的宿主，并释放已移除评论的监听器；不定时重扫整页。
  setInterval(() => {
    for (const host of pendingHosts) {
      if (!host.isConnected || ignored(host)) pendingHosts.delete(host);
      else if (host.shadowRoot) {
        pendingHosts.delete(host);
        watchRoot(host.shadowRoot);
      }
    }
    for (const [root, observer] of observers) {
      if (root !== document && !root.host.isConnected) {
        observer.disconnect();
        observers.delete(root);
      }
    }
  }, 750);
})();
