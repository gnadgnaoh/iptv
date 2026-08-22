// ==UserScript==
// @name         QMH HLS Player & Downloader (lite)
// @namespace    https://github.com/gnadgnaoh
// @version      4.0.0
// @description  Thay player QMH bằng HLS player nhẹ + tải video. Viết lại cho Firefox Android / FireMonkey: RAM có trần, không observer, không polling nặng.
// @match        https://qmh.kim/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js
// @run-at       document-start
// ==/UserScript==

/*
 * ---------------------------------------------------------------------------
 *  GHI CHÚ KIẾN TRÚC (đọc 1 lần rồi quên cũng được)
 * ---------------------------------------------------------------------------
 *  Bản 2.x có 5 nguồn ngốn RAM. Bản này bỏ hẳn từng nguồn:
 *
 *  1. hls.js mặc định backBufferLength = Infinity  -> giới hạn cứng (§6)
 *  2. Download gom cả phim vào Array<ArrayBuffer>  -> tải theo phần, ra Blob ngay (§7)
 *  3. mountPlayer chạy song song -> nhiều Hls sống -> máy trạng thái 1 chiều (§5)
 *  4. MutationObserver trên document.body + 2 setInterval
 *                                                  -> 1 ticker duy nhất, việc O(1) (§4)
 *  5. iframe player gốc vẫn buffer song song       -> gỡ bỏ sau khi lấy được key (§5)
 *
 *  Ngoài ra: mọi listener đều gắn { signal } của một AbortController theo vòng đời,
 *  nên không thể rò rỉ - huỷ controller là sạch toàn bộ.
 *
 *  MUỐN NHẸ THÊM ~800KB MỖI FRAME: xoá dòng "@require ...hls.min.js" ở trên.
 *  Script sẽ tự nạp hls.js chỉ trong frame trên cùng và chỉ khi thật sự cần.
 *  Nếu site chặn bằng CSP thì thêm lại dòng đó.
 * ---------------------------------------------------------------------------
 */

(() => {
  'use strict';

  /* ===========================================================================
   * §1  HẰNG SỐ + CHỐNG NHÚNG TRÙNG
   * ======================================================================== */

  const NS = '__qmhHls4';
  if (window[NS]) return;              // FireMonkey có thể chạy lại khi SPA đổi state
  window[NS] = true;

  const TOP = window === window.top;
  const ORIGIN = location.origin;
  const HOST = location.hostname;
  const API_ORIGIN = ORIGIN.replace(/^https?:\/\//, (m) => m + 'api.');

  const PATH_RESOLVE = '/api/v1/upload/video-hls/resolve';
  const PATH_TOKEN = '/api/hls-token';
  const PATH_KEY = '/video-hls-key/';

  const MSG_PLAYLIST = 'QMH_RESOLVED_HLS';
  const MSG_KEY = 'QMH_AES_KEY';

  const SEL_REGION = 'section[aria-label="Video player"]';
  const SEL_FRAME = '#secure-m3u8-embed-frame';
  const ID_WRAPPER = 'qmh-hls-root';

  /* ===========================================================================
   * §2  CẤU HÌNH — tự dò theo RAM máy, sửa tay được
   * ======================================================================== */

  // navigator.deviceMemory: Firefox không hỗ trợ -> mặc định coi như máy 3GB.
  const DEVICE_GB = Number(navigator.deviceMemory) || 3;
  const TIER = DEVICE_GB <= 2 ? 'low' : DEVICE_GB <= 4 ? 'mid' : 'high';

  const PRESET = {
    low:  { back: 10, fwd: 8,  maxFwd: 16, bufBytes:  8e6, part:  64, conc: 1 },
    mid:  { back: 20, fwd: 12, maxFwd: 24, bufBytes: 12e6, part: 128, conc: 2 },
    high: { back: 30, fwd: 20, maxFwd: 40, bufBytes: 24e6, part: 256, conc: 3 },
  }[TIER];

  const CFG = {
    DEBUG: false,

    // --- Phát ---
    BACK_BUFFER_SEC: PRESET.back,      // giây ĐÃ xem còn giữ trong SourceBuffer
    FWD_BUFFER_SEC: PRESET.fwd,
    MAX_FWD_BUFFER_SEC: PRESET.maxFwd,
    MAX_BUFFER_BYTES: PRESET.bufBytes,
    CAP_TO_PLAYER_SIZE: true,          // không kéo 1080p vào khung 360px
    ENABLE_WORKER: false,              // blob: worker hay bị CSP chặn trong FireMonkey
    IDLE_STOP_MS: 20000,               // pause lâu hơn ngần này -> ngừng tải

    // --- Tải về ---
    PART_MB: PRESET.part,              // 0 = một file duy nhất (KHÔNG khuyến nghị trên mobile)
    CONCURRENCY: PRESET.conc,
    SEG_TIMEOUT_MS: 20000,
    SEG_RETRY: 3,

    // --- Vòng đời ---
    TICK_MS: 1000,                     // ticker duy nhất của cả script
    VIP_EVERY: 5,                      // -> kiểm tra khoá VIP mỗi 5s
    VIP_MAX_RELOAD: 3,
    KILL_ORIGINAL_FRAME: true,         // gỡ iframe gốc để nó thôi buffer song song
    KILL_FRAME_GRACE_MS: 8000,
    MOUNT_MODE: 'inline',              // 'inline' (rẻ) | 'portal' (position:fixed, đắt hơn)
  };

  const PART_BYTES = CFG.PART_MB * 1024 * 1024;

  /* ===========================================================================
   * §3  TIỆN ÍCH
   * ======================================================================== */

  const log = CFG.DEBUG ? (...a) => console.info('[QMH]', ...a) : () => {};
  const warn = (...a) => console.warn('[QMH]', ...a);

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel, root = document) => root.querySelector(sel);

  function fmtBytes(n) {
    const u = ['B', 'KB', 'MB', 'GB'];
    let v = n, i = 0;
    while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
    return `${v.toFixed(i ? 1 : 0)} ${u[i]}`;
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function seqIv(seq) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, seq);
    return iv;
  }

  function absUrl(base, val) {
    if (/^https?:\/\//i.test(val)) return val;
    if (base.startsWith('data:')) throw new Error(`URL tương đối trong data playlist: ${val}`);
    return new URL(val, base).href;
  }

  /** fetch có timeout riêng + nối vào signal bên ngoài, luôn dọn timer. */
  async function req(url, as, outerSignal) {
    const ac = new AbortController();
    const onAbort = () => ac.abort();
    outerSignal?.addEventListener('abort', onAbort, { once: true });
    const t = setTimeout(() => ac.abort(), CFG.SEG_TIMEOUT_MS);
    try {
      const r = await fetch(url, {
        credentials: new URL(url).hostname === HOST ? 'include' : 'omit',
        signal: ac.signal,
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return as === 'text' ? r.text() : r.arrayBuffer();
    } catch (e) {
      if (e?.name === 'AbortError' && !outerSignal?.aborted) {
        throw new Error(`Hết thời gian chờ: ${url}`);
      }
      throw e;
    } finally {
      clearTimeout(t);
      outerSignal?.removeEventListener('abort', onAbort);
    }
  }

  /** Không .slice() thêm: response.arrayBuffer() vốn đã là buffer mới. */
  async function reqBuffer(url, signal, retry = CFG.SEG_RETRY) {
    let last;
    for (let i = 1; i <= retry; i++) {
      try {
        return await req(url, 'buffer', signal);
      } catch (e) {
        if (signal?.aborted) throw e;
        last = e;
        if (i < retry) await sleep(400 * 2 ** (i - 1));
      }
    }
    throw last;
  }

  /* ===========================================================================
   * §4  SNIFFER — phần DUY NHẤT chạy trong mọi frame
   *     Giữ cực mỏng: 2 hook, không DOM, không timer, không hls.
   * ======================================================================== */

  const store = {
    playlistUrl: null,
    key: null,          // Uint8Array(16)
    resolveBody: null,  // { token, hash, apiBase, embedRequired }
  };

  function sniffFetch() {
    const orig = window.fetch.bind(window);
    window.fetch = function (...args) {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      // Đường nhanh: ~99% request không liên quan, trả thẳng, không clone/parse.
      if (!url.includes(PATH_RESOLVE)) return orig(...args);

      const init = args[1];
      if (init && typeof init.body === 'string') {
        try {
          const b = JSON.parse(init.body);
          if (b?.token && b?.hash) {
            store.resolveBody = {
              token: b.token, hash: b.hash,
              apiBase: b.apiBase, embedRequired: b.embedRequired,
            };
          }
        } catch { /* bỏ qua */ }
      }

      return orig(...args).then((res) => {
        if (!res.ok) return res;
        // clone() BẮT BUỘC phải đọc hết, nếu không Gecko giữ stream trong RAM.
        res.clone().json().then((p) => {
          const u = p?.data?.url;
          if (p?.success && typeof u === 'string') {
            window.top.postMessage({ type: MSG_PLAYLIST, url: u }, ORIGIN);
          }
        }).catch(() => {});
        return res;
      });
    };
  }

  function sniffKey() {
    const { open, send } = XMLHttpRequest.prototype;

    XMLHttpRequest.prototype.open = function (m, u, ...rest) {
      this[NS] = typeof u === 'string' && u.includes(PATH_KEY);
      return open.call(this, m, u, ...rest);
    };

    XMLHttpRequest.prototype.send = function (...a) {
      if (this[NS]) {
        this.addEventListener('load', () => {
          const b = this.response;
          if (this.status === 200 && b?.byteLength === 16) {
            const key = new Uint8Array(b.slice(0));
            store.key = key;
            if (!TOP) window.top.postMessage({ type: MSG_KEY, key: [...key] }, ORIGIN);
            log('bắt được AES key');
          }
        }, { once: true });
      }
      return send.apply(this, a);
    };
  }

  sniffFetch();
  sniffKey();

  if (!TOP) return;   // ⟵ frame con dừng ở đây. Không DOM, không timer, không RAM.

  /* ===========================================================================
   * §5  CONTROLLER — máy trạng thái 1 chiều, chỉ frame trên cùng
   * ======================================================================== */

  /**
   * Vòng đời hiện tại. Mỗi lần đổi phim/URL, huỷ cả cụm bằng ac.abort()
   * -> mọi listener, hls instance, timer trong cụm đó tự biến mất.
   */
  let life = null;
  /**
   * @typedef {{ ac: AbortController, url: string, wrapper: HTMLElement,
   *             surface: HTMLElement, destroy: () => void }} Life
   */

  let mounting = false;     // khoá chống mount song song (nguồn RAM #3)
  let mountTimer = null;
  let download = null;      // AbortController của lần tải đang chạy

  const pageAc = new AbortController();
  const pageSignal = pageAc.signal;

  window.addEventListener('message', onMessage, { signal: pageSignal });
  window.addEventListener('pagehide', shutdown, { signal: pageSignal });
  patchHistory();
  startTicker();

  function onMessage(e) {
    if (e.origin !== ORIGIN) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;

    if (d.type === MSG_KEY && Array.isArray(d.key) && d.key.length === 16) {
      store.key = new Uint8Array(d.key);
      return;
    }
    if (d.type === MSG_PLAYLIST && typeof d.url === 'string') {
      if (d.url === store.playlistUrl && life) return;   // chặn mount lặp
      store.playlistUrl = d.url;
      scheduleMount(700);
    }
  }

  function scheduleMount(delay) {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(() => {
      mountTimer = null;
      mount().catch((e) => warn('mount lỗi:', e));
    }, delay);
  }

  function destroyLife() {
    if (!life) return;
    try { life.destroy(); } catch (e) { warn(e); }
    life = null;
  }

  function resetPage() {
    clearTimeout(mountTimer);
    mountTimer = null;
    download?.abort();
    store.playlistUrl = null;
    destroyLife();
  }

  function shutdown() {
    resetPage();
    pageAc.abort();
    store.key = null;
    store.resolveBody = null;
  }

  /* --- §5.1 Ticker: MỘT setInterval cho toàn script ---------------------- */

  function patchHistory() {
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m].bind(history);
      history[m] = function (...a) { orig(...a); queueMicrotask(checkUrl); };
    }
    window.addEventListener('popstate', checkUrl, { signal: pageSignal });
  }

  let lastUrl = location.href;
  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    log('đổi URL -> reset');
    resetPage();
  }

  function startTicker() {
    let tick = 0;
    const id = setInterval(() => {
      // Tab ẩn: không làm gì cả. Đây là lúc trình duyệt cần RAM nhất.
      if (document.hidden) return;
      tick++;

      checkUrl();                       // so sánh chuỗi, O(1)

      // Tự lành: player bị React gỡ mất thì dựng lại. isConnected là O(1),
      // rẻ hơn MutationObserver hàng nghìn lần trên một SPA.
      if (life && !life.wrapper.isConnected) {
        log('player bị gỡ -> mount lại');
        destroyLife();
        if (store.playlistUrl) scheduleMount(150);
      }

      if (tick % CFG.VIP_EVERY === 0) checkVipLock();
    }, CFG.TICK_MS);

    pageSignal.addEventListener('abort', () => clearInterval(id), { once: true });
  }

  /* --- §5.2 Gỡ khoá VIP (giới hạn số lần reload) ------------------------- */

  const KEY_RELOADS = '__qmh_vip_reloads';
  let lastReload = 0;

  function checkVipLock() {
    if (store.playlistUrl) return;
    const reloads = Number(sessionStorage.getItem(KEY_RELOADS) || 0);
    if (reloads >= CFG.VIP_MAX_RELOAD) return;

    const region = $(SEL_REGION);
    if (!region) return;

    // textContent, KHÔNG dùng innerText: innerText ép reflow cả trang mỗi lần gọi.
    const t = region.textContent || '';
    if (!t.includes('VIP PREVIEW ENDED') && !(t.includes('VIP') && t.includes('Nâng cấp VIP'))) return;

    const isLock = (n) => n.startsWith('vip_locked_movie_') || n.startsWith('vip_watch_sec_movie_');
    let cleared = 0;

    for (const s of [localStorage, sessionStorage]) {
      for (let i = s.length - 1; i >= 0; i--) {
        const n = s.key(i);
        if (n && isLock(n)) { s.removeItem(n); cleared++; }
      }
    }
    for (const c of document.cookie.split(';')) {
      const n = c.split('=')[0].trim();
      if (!isLock(n)) continue;
      const exp = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = n + exp + '; domain=.' + HOST;
      document.cookie = n + exp;
      cleared++;
    }

    if (!cleared) return;
    const now = Date.now();
    if (now - lastReload < 15000) return;
    lastReload = now;
    sessionStorage.setItem(KEY_RELOADS, String(reloads + 1));
    warn(`gỡ ${cleared} khoá VIP, reload ${reloads + 1}/${CFG.VIP_MAX_RELOAD}`);
    location.reload();
  }

  /* --- §5.3 Mount ------------------------------------------------------- */

  function findSurface() {
    const frame = $(SEL_FRAME);
    if (frame?.parentElement) return frame.parentElement;
    const region = $(SEL_REGION);
    return region?.querySelector('[class*="aspect-video"]') || region?.firstElementChild || null;
  }

  async function mount() {
    if (mounting) return;               // ⟵ khoá: bản cũ dựng được N player song song
    mounting = true;
    try {
      const url = store.playlistUrl;
      if (!url) return;

      await pageReady();
      if (url !== store.playlistUrl) return;   // đã đổi phim trong lúc chờ

      const surface = findSurface();
      if (!surface) return;

      if (life?.url === url && life.wrapper.isConnected && life.surface === surface) return;
      destroyLife();

      const ac = new AbortController();
      const ui = buildUi(url, ac.signal);
      attach(ui.wrapper, surface, ac.signal);

      const player = await createPlayer(ui.video, url, ui.setStatus, ac.signal);
      if (ac.signal.aborted) { player.destroy(); return; }

      life = {
        ac, url, surface,
        wrapper: ui.wrapper,
        destroy() {
          ac.abort();                    // gỡ sạch listener của cụm này
          player.destroy();
          try {
            ui.video.pause();
            ui.video.removeAttribute('src');
            ui.video.load();             // giải phóng MSE SourceBuffer
          } catch { /* bỏ qua */ }
          ui.wrapper.remove();
        },
      };

      killOriginalFrame(ac.signal);
    } finally {
      mounting = false;
    }
  }

  function pageReady() {
    if (document.readyState === 'complete') return Promise.resolve();
    return new Promise((r) => window.addEventListener('load', r, { once: true }));
  }

  /**
   * iframe player gốc vẫn tải + decode video song song với player của ta.
   * Trên Android đó là gấp đôi RAM video cho không. Gỡ sau khi đã có AES key
   * (hoặc sau grace period) để không mất khả năng tải về.
   */
  function killOriginalFrame(signal) {
    if (!CFG.KILL_ORIGINAL_FRAME) return;
    const t0 = Date.now();
    const tryKill = () => {
      if (signal.aborted) return;
      const frame = $(SEL_FRAME);
      if (!frame) return;
      if (!store.key && Date.now() - t0 < CFG.KILL_FRAME_GRACE_MS) {
        setTimeout(tryKill, 1000);
        return;
      }
      try { frame.src = 'about:blank'; } catch { /* bỏ qua */ }
      frame.remove();
      log('đã gỡ iframe gốc');
    };
    setTimeout(tryKill, 1200);
  }

  /* --- §5.4 Gắn vào DOM ------------------------------------------------- */

  function attach(wrapper, surface, signal) {
    if (CFG.MOUNT_MODE === 'inline') {
      // Rẻ nhất: nằm ngay trong khung player, trình duyệt tự lo layout.
      // Không cần scroll/resize listener, không getBoundingClientRect mỗi frame.
      if (getComputedStyle(surface).position === 'static') surface.style.position = 'relative';
      wrapper.style.cssText += ';position:absolute;inset:0';
      surface.appendChild(wrapper);
      return;
    }

    // Chế độ portal: position:fixed + đồng bộ toạ độ. Chỉ dùng nếu inline bị site đè.
    wrapper.style.cssText += ';position:fixed';
    document.body.appendChild(wrapper);

    let raf = 0;
    let radius = '';
    const sync = () => {
      raf = 0;
      if (!wrapper.isConnected || !surface.isConnected) return;
      const r = surface.getBoundingClientRect();
      const s = wrapper.style;
      s.setProperty('left', `${r.left}px`, 'important');
      s.setProperty('top', `${r.top}px`, 'important');
      s.setProperty('width', `${r.width}px`, 'important');
      s.setProperty('height', `${r.height}px`, 'important');
      if (!radius) {                     // getComputedStyle rất đắt, đọc 1 lần
        radius = getComputedStyle(surface).borderRadius;
        s.setProperty('border-radius', radius, 'important');
      }
    };
    const ask = () => { if (!raf && !document.hidden) raf = requestAnimationFrame(sync); };

    const ro = new ResizeObserver(ask);
    ro.observe(surface);
    addEventListener('resize', ask, { passive: true, signal });
    addEventListener('scroll', ask, { passive: true, capture: true, signal });
    signal.addEventListener('abort', () => { if (raf) cancelAnimationFrame(raf); ro.disconnect(); }, { once: true });
    sync();
  }

  /* --- §5.5 Giao diện --------------------------------------------------- */

  const CSS = {
    wrap: 'display:flex;flex-direction:column;background:#000;overflow:hidden;' +
          'z-index:2147483647;contain:layout paint;isolation:isolate',
    video: 'width:100%;flex:1;min-height:0;background:#000;object-fit:contain',
    bar: 'display:flex;align-items:center;gap:8px;padding:7px 9px;background:#151515;' +
         'color:#fff;font:13px/1.3 system-ui,sans-serif;flex:none',
    btn: 'flex:none;border:1px solid #555;background:#fff;color:#111;padding:6px 10px;' +
         'font-weight:600;border-radius:4px;cursor:pointer',
    btn2: 'flex:none;border:1px solid #555;background:#333;color:#fff;padding:6px 10px;' +
          'border-radius:4px;cursor:pointer;display:none',
    txt: 'min-width:0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;opacity:.85',
  };

  function buildUi(url, signal) {
    const wrapper = document.createElement('div');
    wrapper.id = ID_WRAPPER;
    wrapper.dataset.url = url;
    wrapper.style.cssText = CSS.wrap;

    const video = document.createElement('video');
    Object.assign(video, { controls: true, autoplay: true, playsInline: true, preload: 'metadata' });
    if ('disableRemotePlayback' in video) video.disableRemotePlayback = true;
    video.style.cssText = CSS.video;

    const bar = document.createElement('div');
    bar.style.cssText = CSS.bar;

    const dl = document.createElement('button');
    dl.type = 'button';
    dl.textContent = 'Tải video';
    dl.style.cssText = CSS.btn;

    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Huỷ';
    cancel.style.cssText = CSS.btn2;

    const status = document.createElement('span');
    status.style.cssText = CSS.txt;
    status.textContent = 'Đang nạp HLS…';

    // Cập nhật text qua rAF: tránh ép layout khi tiến độ chạy nhanh.
    let pending = null, raf = 0;
    const setStatus = (s) => {
      pending = s;
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; status.textContent = pending; });
    };

    dl.addEventListener('click', () => runDownload(wrapper.dataset.url, { dl, cancel, setStatus }), { signal });
    cancel.addEventListener('click', () => download?.abort(), { signal });

    bar.append(dl, cancel, status);
    wrapper.append(video, bar);
    return { wrapper, video, setStatus };
  }

  /* ===========================================================================
   * §6  PLAYER — hls.js với buffer bị chặn trần
   * ======================================================================== */

  let hlsLoading = null;
  function ensureHls() {
    if (typeof Hls !== 'undefined') return Promise.resolve(true);
    // Chỉ chạy khi bạn đã xoá dòng @require. Nạp 1 lần duy nhất, ở top frame.
    hlsLoading ||= new Promise((resolve) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js';
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(s);
    });
    return hlsLoading;
  }

  async function playbackSource(url) {
    if (!url.startsWith('data:')) return { src: url, revoke: null };
    const text = await readPlaylist(url);
    const blobUrl = URL.createObjectURL(
      new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
    return { src: blobUrl, revoke: () => URL.revokeObjectURL(blobUrl) };
  }

  async function createPlayer(video, url, setStatus, signal) {
    await ensureHls();
    const { src, revoke } = await playbackSource(url);
    if (signal.aborted) { revoke?.(); return { destroy() {} }; }

    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.addEventListener('error',
          () => setStatus(`Lỗi media: ${video.error?.message || 'định dạng không hỗ trợ'}`),
          { signal });
        video.src = src;
        video.play().catch(() => {});
        setStatus('Sẵn sàng');
        return { destroy: () => revoke?.() };
      }
      setStatus('Trình duyệt không phát được HLS');
      revoke?.();
      return { destroy() {} };
    }

    const hls = new Hls({
      enableWorker: CFG.ENABLE_WORKER,
      lowLatencyMode: false,
      progressive: false,

      // ⚠️ Mấu chốt: mặc định của hls.js là Infinity — mọi giây đã xem đều nằm
      // nguyên trong SourceBuffer. Phim 2 tiếng = vài GB = sập máy.
      backBufferLength: CFG.BACK_BUFFER_SEC,
      frontBufferFlushThreshold: CFG.MAX_FWD_BUFFER_SEC,

      maxBufferLength: CFG.FWD_BUFFER_SEC,
      maxMaxBufferLength: CFG.MAX_FWD_BUFFER_SEC,
      maxBufferSize: CFG.MAX_BUFFER_BYTES,
      maxBufferHole: 0.5,

      capLevelToPlayerSize: CFG.CAP_TO_PLAYER_SIZE,
      capLevelOnFPSDrop: true,
      startLevel: -1,

      fragLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 3,
      manifestLoadingMaxRetry: 2,
    });

    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      setStatus(`Sẵn sàng · buffer ${CFG.FWD_BUFFER_SEC}s / giữ lại ${CFG.BACK_BUFFER_SEC}s`);
      video.play().catch(() => {});
    });

    // Backoff: bản cũ gọi startLoad() ngay trong vòng lặp lỗi mạng -> spam
    // request, sinh rác nhanh hơn tốc độ GC.
    let fails = 0, retryTimer = null;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      setStatus(`Lỗi: ${d.details}`);
      if (++fails > 5) { hls.destroy(); return; }
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else hls.destroy();
      }, 500 * fails);
    });

    // Ngừng tải khi ẩn tab / pause lâu — trên Android đây là lúc RAM căng nhất.
    let idleTimer = null, stopped = false;
    const stop = () => { if (!stopped) { stopped = true; try { hls.stopLoad(); } catch {} } };
    const start = () => { if (stopped) { stopped = false; try { hls.startLoad(); } catch {} } };

    document.addEventListener('visibilitychange',
      () => (document.hidden ? stop() : start()), { signal });
    video.addEventListener('pause', () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(stop, CFG.IDLE_STOP_MS);
    }, { signal });
    video.addEventListener('play', () => { clearTimeout(idleTimer); start(); }, { signal });

    return {
      destroy() {
        clearTimeout(retryTimer);
        clearTimeout(idleTimer);
        try { hls.destroy(); } catch (e) { warn(e); }
        revoke?.();
      },
    };
  }

  /* ===========================================================================
   * §7  TẢI VỀ — cửa sổ trượt + cắt phần, RAM có trần cứng
   * ======================================================================== */

  async function readPlaylist(url, signal) {
    if (!url.startsWith('data:')) return req(url, 'text', signal);
    const i = url.indexOf(',');
    if (i < 0) throw new Error('data playlist không hợp lệ');
    const body = url.slice(i + 1);
    return url.slice(0, i).includes(';base64') ? atob(body) : decodeURIComponent(body);
  }

  function parsePlaylist(text, base) {
    const out = { segs: [], keyUrl: null, iv: null, seq: 0, map: null };
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;

      if (line[0] !== '#') { out.segs.push(absUrl(base, line)); continue; }

      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        out.seq = Number(line.slice(22)) || 0;
      } else if (line.startsWith('#EXT-X-MAP:')) {
        const u = line.match(/URI="([^"]+)"/)?.[1];
        if (u) out.map = absUrl(base, u);          // fMP4: segment khởi tạo
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const method = line.match(/METHOD=([^,]+)/)?.[1];
        if (method && method !== 'NONE' && method !== 'AES-128') {
          throw new Error(`Không hỗ trợ mã hoá: ${method}`);
        }
        const u = line.match(/URI="([^"]+)"/)?.[1];
        if (method === 'AES-128' && u) out.keyUrl = absUrl(base, u);
        const ivHex = line.match(/IV=0x([0-9a-f]+)/i)?.[1];
        if (ivHex) out.iv = hexToBytes(ivHex.padStart(32, '0'));
      }
    }
    return out;
  }

  function safeName() {
    const t = $('h1')?.textContent?.trim() || document.title || 'qmh-video';
    return t.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 110);
  }

  function saveBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 10000);   // bản cũ giữ 60s
  }

  async function freshPlaylist(signal) {
    try {
      const tr = await fetch(PATH_TOKEN, {
        method: 'POST', credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}', signal,
      });
      if (!tr.ok) throw new Error(`hls-token ${tr.status}`);
      const tk = await tr.json();
      if (!tk?.token) throw new Error('hls-token không trả token');

      if (store.resolveBody) {
        const apiBase = store.resolveBody.apiBase || API_ORIGIN + '/api/v1';
        const rr = await fetch(apiBase + PATH_RESOLVE, {
          method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: tk.token,
            hash: tk.hash || store.resolveBody.hash,
            apiBase,
            embedRequired: store.resolveBody.embedRequired ?? true,
          }),
          signal,
        });
        if (!rr.ok) throw new Error(`resolve ${rr.status}`);
        const p = await rr.json();
        const u = p?.data?.url;
        if (p?.success && typeof u === 'string') {
          return { url: u, text: await readPlaylist(u, signal) };
        }
      }

      const claims = JSON.parse(
        atob(tk.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')) || '{}');
      if (typeof claims?.u === 'string' && claims.u.includes('.m3u8')) {
        return { url: claims.u, text: await req(claims.u, 'text', signal) };
      }
      return null;
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      warn('resolve mới thất bại:', e);
      return null;
    }
  }

  function waitKey(ms) {
    if (store.key?.byteLength === 16) return Promise.resolve();
    return new Promise((res) => {
      const t0 = Date.now();
      const poll = () => {
        if (store.key?.byteLength === 16 || Date.now() - t0 > ms) return res();
        setTimeout(poll, 150);
      };
      poll();
    });
  }

  async function runDownload(url, ui) {
    if (download) return;
    const ac = new AbortController();
    download = ac;
    const { signal } = ac;

    ui.dl.disabled = true;
    ui.dl.style.opacity = '.5';
    ui.cancel.style.display = '';

    let part = [];          // Blob[] của phần đang gom
    let pl = null;

    try {
      ui.setStatus('Đọc playlist…');
      let text = await readPlaylist(url, signal);

      if (store.key?.byteLength !== 16) {
        const fresh = await freshPlaylist(signal);
        if (fresh) { url = fresh.url; text = fresh.text; }
      }

      pl = parsePlaylist(text, url);
      text = null;
      const total = pl.segs.length;
      if (!total) throw new Error('Playlist không có segment nào');

      // --- Khoá AES ---
      let cryptoKey = null;
      if (pl.keyUrl) {
        if (store.key?.byteLength !== 16) {
          ui.setStatus('Chờ AES key…');
          await waitKey(3000);
        }
        if (store.key?.byteLength !== 16) {
          ui.setStatus('Tải AES key…');
          const kb = new Uint8Array(await reqBuffer(pl.keyUrl, signal));
          if (kb.byteLength !== 16) throw new Error(`Key sai độ dài: ${kb.byteLength}`);
          store.key = kb;
        }
        cryptoKey = await crypto.subtle.importKey(
          'raw', store.key, { name: 'AES-CBC' }, false, ['decrypt']);
      }

      // --- Segment khởi tạo cho fMP4: mỗi phần cần một bản để phát được ---
      const isFmp4 = !!pl.map;
      let initBlob = null;
      if (isFmp4) {
        initBlob = new Blob([await reqBuffer(pl.map, signal)]);
      }

      const base = safeName();
      const ext = isFmp4 ? 'mp4' : 'ts';
      const multi = PART_BYTES > 0;

      let produced = 0;     // segment đã tải xong
      let written = 0;      // segment đã ghi vào phần (con trỏ thứ tự)
      let next = 0;         // segment tiếp theo để phát cho worker
      let partBytes = 0;
      let totalBytes = 0;
      let partNo = 1;
      const ready = new Map();   // index -> Blob (chờ tới lượt ghi)

      const newPart = () => { part = initBlob ? [initBlob] : []; partBytes = 0; };
      newPart();

      const flush = async (force) => {
        const hasData = part.length > (initBlob ? 1 : 0);
        if (!hasData) return;
        if (!force && !(multi && partBytes >= PART_BYTES)) return;

        ui.setStatus(`Đang lưu phần ${partNo}…`);
        // Blob-của-Blob trong Gecko là multipart: KHÔNG copy lại dữ liệu.
        const blob = new Blob(part, { type: isFmp4 ? 'video/mp4' : 'video/mp2t' });
        newPart();                                  // thả tham chiếu ngay lập tức
        const many = multi && (partNo > 1 || !force);
        saveBlob(blob, many
          ? `${base}.part${String(partNo).padStart(2, '0')}.${ext}`
          : `${base}.${ext}`);
        partNo++;
        await sleep(350);                           // cho trình duyệt kịp ghi ra đĩa
      };

      const drain = async () => {
        while (ready.has(written)) {
          const b = ready.get(written);
          ready.delete(written);
          written++;
          part.push(b);
          partBytes += b.size;
          totalBytes += b.size;
          await flush(false);
        }
      };

      // Cửa sổ trượt: worker không được chạy trước con trỏ ghi quá CONCURRENCY+1
      // segment => số buffer sống cùng lúc luôn bị chặn, không phụ thuộc độ dài phim.
      const worker = async () => {
        while (next < total) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          while (next - written > CFG.CONCURRENCY + 1) {
            await sleep(40);
            if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          }

          const i = next++;
          let buf = await reqBuffer(pl.segs[i], signal);

          if (cryptoKey) {
            const iv = pl.iv || seqIv(pl.seq + i);
            if (buf.byteLength % 16) throw new Error(`Segment ${i + 1} không đúng block AES`);
            const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buf);
            buf = null;                          // bỏ bản mã hoá ngay
            ready.set(i, new Blob([dec]));       // ArrayBuffer -> Blob: rời khỏi JS heap
          } else {
            ready.set(i, new Blob([buf]));
            buf = null;
          }

          if (++produced % 4 === 0 || produced === total) {
            ui.setStatus(`Tải ${produced}/${total} · ${fmtBytes(totalBytes)}`);
          }
          await drain();
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(CFG.CONCURRENCY, total) }, worker));
      await drain();
      await flush(true);

      ui.setStatus(`Xong · ${fmtBytes(totalBytes)}${partNo > 2 ? ` · ${partNo - 1} phần` : ''}`);
    } catch (e) {
      if (e?.name === 'AbortError') ui.setStatus('Đã huỷ');
      else { console.error('[QMH] tải lỗi:', e); ui.setStatus(`Lỗi: ${e.message}`); }
    } finally {
      part = null;
      pl = null;
      download = null;
      ui.dl.disabled = false;
      ui.dl.style.opacity = '';
      ui.cancel.style.display = 'none';
    }
  }

  log(`sẵn sàng · máy ${DEVICE_GB}GB · preset ${TIER} · phần ${CFG.PART_MB}MB · ${CFG.CONCURRENCY} luồng`);
})();
