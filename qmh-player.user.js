// ==UserScript==
// @name         QMH HLS Player (lite)
// @namespace    https://github.com/gnadgnaoh
// @version      5.0.0
// @description  Thay player QMH bằng HLS player nhẹ. Chỉ để xem — không tải về.
// @match        https://qmh.kim/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js
// @run-at       document-start
// ==/UserScript==

(() => {
  'use strict';

  const NS = '__qmhLite';
  if (window[NS]) return;
  window[NS] = true;

  const TOP = window === window.top;
  const ORIGIN = location.origin;
  const HOST = location.hostname;
  const MSG = 'QMH_HLS';
  const RESOLVE = '/api/v1/upload/video-hls/resolve';
  const SEL_REGION = 'section[aria-label="Video player"]';
  const SEL_FRAME = '#secure-m3u8-embed-frame';

  /* ---- cấu hình: tự hạ theo RAM máy ---------------------------------- */
  const GB = Number(navigator.deviceMemory) || 3;          // Firefox không báo -> coi như 3GB
  const P = GB <= 2 ? { b: 10, f: 8, m: 16, s: 8e6 }
          : GB <= 4 ? { b: 20, f: 12, m: 24, s: 12e6 }
                    : { b: 30, f: 20, m: 40, s: 24e6 };
  const CFG = {
    BACK: P.b,        // giây ĐÃ xem còn giữ lại (hls.js mặc định: Infinity → phình vô hạn)
    FWD: P.f,         // giây buffer trước
    MAXFWD: P.m,
    BYTES: P.s,       // hls.js mặc định 60MB
    IDLE: 20000,      // pause lâu hơn → ngừng tải
    TICK: 1000,
    VIP_EVERY: 5,
    VIP_MAX: 3,
    KILL_FRAME: true, // gỡ iframe gốc để nó thôi buffer song song
  };

  /* ---- chạy trong MỌI frame: 1 hook, không DOM, không timer ----------- */
  const origFetch = window.fetch.bind(window);
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    if (!u.includes(RESOLVE)) return origFetch(...a);      // đường nhanh cho ~99% request
    return origFetch(...a).then((r) => {
      if (r.ok) {
        // clone() phải đọc hết, không thì Gecko giữ nguyên stream trong RAM
        r.clone().json().then((p) => {
          const x = p?.data?.url;
          if (p?.success && typeof x === 'string') window.top.postMessage({ t: MSG, u: x }, ORIGIN);
        }).catch(() => {});
      }
      return r;
    });
  };

  if (!TOP) return;   // ⟵ frame con dừng tại đây

  /* ---- trạng thái ----------------------------------------------------- */
  let url = null;     // playlist hiện tại
  let life = null;    // { ac, url, video, destroy }
  let busy = false;
  let timer = null;
  let lastUrl = location.href;

  const page = new AbortController();
  const $ = (s) => document.querySelector(s);

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || e.data?.t !== MSG || typeof e.data.u !== 'string') return;
    if (e.data.u === url && life) return;
    url = e.data.u;
    clearTimeout(timer);
    timer = setTimeout(mount, 700);
  }, { signal: page.signal });

  addEventListener('pagehide', () => { reset(); page.abort(); }, { signal: page.signal });

  for (const m of ['pushState', 'replaceState']) {
    const o = history[m].bind(history);
    history[m] = function (...a) { o(...a); queueMicrotask(checkUrl); };
  }
  addEventListener('popstate', checkUrl, { signal: page.signal });

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    reset();
  }

  function reset() {
    clearTimeout(timer);
    timer = null;
    url = null;
    if (!life) return;
    try { life.destroy(); } catch (e) { console.warn('[QMH]', e); }
    life = null;
  }

  /* ---- ticker: MỘT interval cho cả script, mọi việc đều O(1) ---------- */
  let ticks = 0;
  const tickId = setInterval(() => {
    if (document.hidden) return;                 // tab ẩn → nghỉ hẳn
    checkUrl();
    if (life && !life.video.isConnected) {       // site re-render gỡ mất player
      const u = url;
      reset();
      url = u;
      if (url) timer = setTimeout(mount, 150);
    }
    if (++ticks % CFG.VIP_EVERY === 0) vip();
  }, CFG.TICK);
  page.signal.addEventListener('abort', () => clearInterval(tickId), { once: true });

  /* ---- gỡ khoá VIP ---------------------------------------------------- */
  let lastReload = 0;
  function vip() {
    if (url) return;
    const n = +(sessionStorage.getItem('__qmh_r') || 0);
    if (n >= CFG.VIP_MAX) return;

    const region = $(SEL_REGION);
    // textContent chứ không phải innerText: innerText ép reflow cả trang
    const t = region?.textContent || '';
    if (!t.includes('VIP PREVIEW ENDED') && !(t.includes('VIP') && t.includes('Nâng cấp VIP'))) return;

    const lock = (k) => k.startsWith('vip_locked_movie_') || k.startsWith('vip_watch_sec_movie_');
    let hit = 0;
    for (const s of [localStorage, sessionStorage]) {
      for (let i = s.length - 1; i >= 0; i--) {
        const k = s.key(i);
        if (k && lock(k)) { s.removeItem(k); hit++; }
      }
    }
    for (const c of document.cookie.split(';')) {
      const k = c.split('=')[0].trim();
      if (!lock(k)) continue;
      const e = '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
      document.cookie = k + e + '; domain=.' + HOST;
      document.cookie = k + e;
      hit++;
    }

    if (!hit || Date.now() - lastReload < 15000) return;
    lastReload = Date.now();
    sessionStorage.setItem('__qmh_r', String(n + 1));
    location.reload();
  }

  /* ---- mount ---------------------------------------------------------- */
  function surface() {
    const f = $(SEL_FRAME);
    if (f?.parentElement) return f.parentElement;
    const r = $(SEL_REGION);
    return r?.querySelector('[class*="aspect-video"]') || r?.firstElementChild || null;
  }

  async function mount() {
    if (busy) return;                            // khoá: không cho 2 player cùng sống
    busy = true;
    try {
      timer = null;
      const src = url;
      if (!src) return;

      if (document.readyState !== 'complete') {
        await new Promise((r) => addEventListener('load', r, { once: true }));
      }
      if (src !== url) return;

      const box = surface();
      if (!box || (life?.url === src && life.video.isConnected)) return;

      reset();
      url = src;

      const ac = new AbortController();
      const { signal } = ac;

      const video = document.createElement('video');
      Object.assign(video, { controls: true, autoplay: true, playsInline: true, preload: 'metadata' });
      if ('disableRemotePlayback' in video) video.disableRemotePlayback = true;
      video.style.cssText =
        'position:absolute;inset:0;width:100%;height:100%;background:#000;' +
        'object-fit:contain;z-index:2147483647';

      // Nằm ngay trong khung player → trình duyệt tự lo layout.
      // Không cần scroll/resize listener hay getBoundingClientRect mỗi frame.
      if (getComputedStyle(box).position === 'static') box.style.position = 'relative';
      box.appendChild(video);

      const stop = play(video, src, signal);
      if (signal.aborted) { stop(); video.remove(); return; }

      life = {
        ac, url: src, video,
        destroy() {
          ac.abort();
          stop();
          try { video.pause(); video.removeAttribute('src'); video.load(); } catch {}
          video.remove();
        },
      };

      if (CFG.KILL_FRAME) {
        // iframe gốc vẫn tải + decode song song = gấp đôi RAM video cho không
        setTimeout(() => {
          if (signal.aborted) return;
          const f = $(SEL_FRAME);
          if (!f) return;
          try { f.src = 'about:blank'; } catch {}
          f.remove();
        }, 1200);
      }
    } finally {
      busy = false;
    }
  }

  /* ---- hls ------------------------------------------------------------ */
  function play(video, src, signal) {
    let blobUrl = null;
    if (src.startsWith('data:')) {
      const i = src.indexOf(',');
      const body = src.slice(i + 1);
      const text = src.slice(0, i).includes(';base64') ? atob(body) : decodeURIComponent(body);
      blobUrl = URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
      src = blobUrl;
    }
    const revoke = () => blobUrl && URL.revokeObjectURL(blobUrl);

    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      video.src = src;
      video.play().catch(() => {});
      return revoke;
    }

    const hls = new Hls({
      enableWorker: false,           // blob: worker hay bị CSP chặn trong FireMonkey
      lowLatencyMode: false,

      // ⚠️ Mấu chốt của việc tràn RAM: mặc định backBufferLength = Infinity,
      // nghĩa là mọi giây đã xem vẫn nằm nguyên trong SourceBuffer.
      backBufferLength: CFG.BACK,
      frontBufferFlushThreshold: CFG.MAXFWD,
      maxBufferLength: CFG.FWD,
      maxMaxBufferLength: CFG.MAXFWD,
      maxBufferSize: CFG.BYTES,
      maxBufferHole: 0.5,

      capLevelToPlayerSize: true,    // không kéo 1080p/4K vào khung vài trăm px
      capLevelOnFPSDrop: true,
      fragLoadingMaxRetry: 3,
      levelLoadingMaxRetry: 3,
      manifestLoadingMaxRetry: 2,
    });

    hls.attachMedia(video);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(src));
    hls.on(Hls.Events.MANIFEST_PARSED, () => video.play().catch(() => {}));

    // Backoff thay vì startLoad() ngay trong vòng lặp lỗi mạng
    let fails = 0, retry = null;
    hls.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal) return;
      if (++fails > 5) return hls.destroy();
      clearTimeout(retry);
      retry = setTimeout(() => {
        if (d.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
        else if (d.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
        else hls.destroy();
      }, 500 * fails);
    });

    // Ngừng tải khi ẩn tab / pause lâu — lúc đó máy cần RAM nhất
    let idle = null, off = false;
    const halt = () => { if (!off) { off = true; try { hls.stopLoad(); } catch {} } };
    const go = () => { if (off) { off = false; try { hls.startLoad(); } catch {} } };

    document.addEventListener('visibilitychange', () => (document.hidden ? halt() : go()), { signal });
    video.addEventListener('pause', () => { clearTimeout(idle); idle = setTimeout(halt, CFG.IDLE); }, { signal });
    video.addEventListener('play', () => { clearTimeout(idle); go(); }, { signal });

    return () => {
      clearTimeout(retry);
      clearTimeout(idle);
      try { hls.destroy(); } catch {}
      revoke();
    };
  }
})();
