// ==UserScript==
// @name         滑鼠側鍵「下一頁」自動翻頁
// @namespace    local.mouse-forward-next
// @version      1.0.0
// @description  沒有可前進的歷史紀錄時,按滑鼠側鍵「下一頁」會自動跳到網頁的下一頁
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const FORWARD_BUTTON = 4; // 滑鼠側鍵:3 = 上一頁, 4 = 下一頁

  const NEXT_TEXT = /^(下一頁|下一页|下頁|下页|下一章|下一篇|下一話|下一话|下一節|下一节|後一頁|后一页|next|next page|next »|older|older posts|›|»|>|>>|→|▶|‹?\s*次へ|次のページ)$/i;

  // ---------- 是否還有「下一頁」的瀏覽紀錄 ----------
  function canGoForward() {
    // Chrome 102+ / Edge 的 Navigation API
    if (window.navigation && typeof navigation.canGoForward === 'boolean') {
      return navigation.canGoForward;
    }
    return false; // 無法判斷時,視為沒有(Firefox 會走這裡)
  }

  // ---------- 找下一頁連結 ----------
  function isUsable(a) {
    if (!a || !a.href) return false;
    if (a.getAttribute('href') === '#' || a.href.startsWith('javascript:')) return false;
    if (a.href.split('#')[0] === location.href.split('#')[0]) return false;
    return true;
  }

  function findNextByRel() {
    return document.querySelector('link[rel~="next"][href], a[rel~="next"][href]');
  }

  function findNextByText() {
    const anchors = document.querySelectorAll('a[href], button');
    for (const el of anchors) {
      const label = [
        el.textContent,
        el.getAttribute('aria-label'),
        el.getAttribute('title'),
      ];
      for (const t of label) {
        if (t && NEXT_TEXT.test(t.trim())) {
          if (el.tagName === 'A' && !isUsable(el)) continue;
          return el;
        }
      }
    }
    return null;
  }

  function findNextByClass() {
    return document.querySelector(
      'a.next, a.nextpage, a.next-page, a.page-next, a.pagination-next, ' +
      '.next > a, .next-page > a, li.next a, .pagination .next a, #pnnext, a[id*="next" i][href]'
    );
  }

  // 目前頁碼(.active / .current / aria-current)的下一個兄弟
  function findNextByCurrent() {
    const cur = document.querySelector(
      '.pagination .active, .pager .active, .pagination .current, .pager .current, ' +
      '.page-numbers.current, [aria-current="page"], .pagenavi .current, .page .current'
    );
    if (!cur) return null;
    let node = cur.closest('li') || cur;
    for (let n = node.nextElementSibling; n; n = n.nextElementSibling) {
      const a = n.tagName === 'A' ? n : n.querySelector('a[href]');
      if (a && isUsable(a) && /^\d+$/.test(a.textContent.trim())) return a;
    }
    return null;
  }

  // 由網址推算:?page=N / &p=N / /page/N / 結尾數字
  function guessNextUrl() {
    const url = new URL(location.href);
    for (const key of ['page', 'p', 'pn', 'paged', 'pageNum', 'pageno', 'pg']) {
      if (url.searchParams.has(key)) {
        const n = parseInt(url.searchParams.get(key), 10);
        if (!isNaN(n)) {
          url.searchParams.set(key, String(n + 1));
          return url.href;
        }
      }
    }
    const m = url.pathname.match(/^(.*\/page\/)(\d+)(\/?)$/i) ||
              url.pathname.match(/^(.*[-_\/])(\d+)(\.html?|\/)?$/i);
    if (m) {
      url.pathname = m[1] + (parseInt(m[2], 10) + 1) + (m[3] || '');
      return url.href;
    }
    return null;
  }

  // 連結或其外層是否被停用(最後一頁時,「下一頁」通常會變成停用狀態)
  function isDisabled(el) {
    for (let n = el, i = 0; n && i < 2; n = n.parentElement, i++) {
      if (n.disabled || n.getAttribute('aria-disabled') === 'true') return true;
      if (/(^|[\s_-])(disabled|inactive|is-disabled)([\s_-]|$)/i.test(n.className || '')) return true;
    }
    return false;
  }

  // 驗證猜出來的網址:不存在(404)或被導回原頁就當作已是最後一頁
  async function guessExists(guess) {
    try {
      const res = await fetch(guess, { credentials: 'include' });
      if (!res.ok) return false;
      const strip = u => u.split('#')[0];
      if (strip(res.url) === strip(location.href)) return false;
      return true;
    } catch (e) {
      return false; // 跨網域或網路錯誤:保守起見不跳轉
    }
  }

  // 找「頁碼參數 = 目前頁 + 1」的連結(pixiv 這類 class 被雜湊、按鈕只有圖示的網站)
  const PAGE_KEYS = ['p', 'page', 'pn', 'paged', 'pageNum', 'pageno', 'pg'];
  function findNextByPageParam() {
    const cur = new URL(location.href);
    let key = PAGE_KEYS.find(k => cur.searchParams.has(k));
    const curNum = key ? parseInt(cur.searchParams.get(key), 10) : 1;
    if (isNaN(curNum)) return null;
    for (const a of document.querySelectorAll('a[href]')) {
      let u;
      try { u = new URL(a.href, location.href); } catch (e) { continue; }
      if (u.origin !== cur.origin || u.pathname !== cur.pathname) continue;
      const k = key || PAGE_KEYS.find(x => u.searchParams.has(x));
      if (!k) continue;
      paginationSeen = true; // 頁面上有分頁連結
      if (parseInt(u.searchParams.get(k), 10) === curNum + 1) return a;
    }
    return null;
  }

  // 回傳:true = 已觸發翻頁;false = 已是最後一頁/找不到;Promise = 非同步驗證網址猜測
  let paginationSeen = false;
  function goNext() {
    paginationSeen = false;
    const finders = [findNextByRel, findNextByPageParam, findNextByClass, findNextByText, findNextByCurrent];
    let sawDisabled = false;
    for (const find of finders) {
      const el = find();
      if (!el) continue;
      if (isDisabled(el)) { sawDisabled = true; continue; }
      if (el.tagName === 'LINK') { location.href = el.href; }
      else {
        // 強制在同一個分頁開啟,避免被 AdGuard 之類的彈出視窗阻擋器攔下
        if (el.tagName === 'A') {
          el.target = '_self';
          el.removeAttribute('rel');
        }
        el.click();
      }
      return true;
    }
    // 下一頁按鈕被停用,或頁面有分頁但沒有更後面的頁碼 → 已是最後一頁
    if (sawDisabled || paginationSeen) return false;
    const guess = guessNextUrl();
    if (!guess) return false;
    return guessExists(guess).then(ok => {
      if (ok) location.href = guess;
      return ok;
    });
  }

  // ---------- 事件 ----------
  function isEditing(e) {
    const t = e.target;
    return t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));
  }

  function handler(e) {
    if (e.button !== FORWARD_BUTTON || isEditing(e)) return;
    if (canGoForward()) return; // 有下一頁歷史就交給瀏覽器
    // 先擋掉瀏覽器預設(避免沒作用或誤觸),再嘗試翻頁
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'mouseup') {
      Promise.resolve(goNext()).then(ok => { if (!ok) toast('已經是最後一頁'); });
    }
  }

  function toast(msg) {
    const d = document.createElement('div');
    d.textContent = msg;
    d.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;' +
      'background:#000c;color:#fff;padding:8px 14px;border-radius:6px;font:14px sans-serif';
    document.documentElement.appendChild(d);
    setTimeout(() => d.remove(), 1500);
  }

  // 注意:不能監聽 pointerdown/pointerup 並 preventDefault,
  // 否則瀏覽器會取消後續的 mouse 事件,導致 mouseup 收不到
  for (const type of ['mousedown', 'mouseup', 'auxclick']) {
    window.addEventListener(type, handler, true);
  }
})();
