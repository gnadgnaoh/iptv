// ==UserScript==
// @name         QMH HLS Player (lite)
// @namespace    https://github.com/gnadgnaoh
// @version      6.1.0
// @description  Thay player QMH bằng HLS player nhẹ. Chỉ để xem — không tải về.
// @match        https://qmh.kim/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.light.min.js
// @run-at       document-start
// ==/UserScript==

/*
 * v6.1 — QUAY VỀ CƠ CHẾ ĐÃ CHẠY ĐƯỢC
 *
 *  @allFrames đã được bật lại. Script lấy URL m3u8 bằng cách hook fetch bên
 *  trong iframe player (giống v5) — đường này đã kiểm chứng là chạy.
 *
 *  Đường /api/hls-token vẫn còn trong code nhưng MẶC ĐỊNH TẮT (CFG.TOKEN_PATH).
 *  Bật lên chỉ để thử nghiệm: nếu nó chạy thì bỏ được @allFrames, hls.js không
 *  phải nhét vào iframe nữa. Bật kèm DEBUG rồi xem console.
 *
 *  Nếu video ra khung đen / không phát: đổi "hls.light.min.js" ở trên thành
 *  "hls.min.js".
 */

(() => {
  'use strict';

  const NS = '__qmhLite';
  if (window[NS]) return;
  window[NS] = true;

  const DEBUG = false;
  const log = DEBUG ? (...a) => console.info('[QMH]', ...a) : () => {};

  const TOP = window === window.top;
  const ORIGIN = location.origin;
  const HOST = location.hostname;
  const API_BASE = ORIGIN.replace(/^https?:\/\//, (m) => m + 'api.') + '/api/v1';
  const MSG = 'QMH_HLS';

  const PATH_TOKEN = '/api/hls-token';
  const RESOLVE_SUFFIX = '/upload/video-hls/resolve';
  const SEL_REGION = 'section[aria-label="Video player"]';
  const SEL_FRAME = '#secure-m3u8-embed-frame';

  /* ---- cấu hình: tự hạ theo RAM máy ---------------------------------- */
  const GB = Number(navigator.deviceMemory) || 3;   // Firefox không báo → coi như 3GB
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
    TOKEN_PATH: false, // true = thử lấy playlist thẳng từ /api/hls-token
    TOKEN_TRIES: 4,    // số lần thử cho mỗi trang
  };

  /* ---- hook fetch trong iframe: đây là đường lấy playlist chính --------- */
  const origFetch = window.fetch.bind(window);
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    if (!u.includes(RESOLVE_SUFFIX)) return origFetch(...a);   // đường nhanh cho ~99% request
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
  let tries = 0, lastTry = 0, trying = false;

  const page = new AbortController();
  const $ = (s) => document.querySelector(s);

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || e.data?.t !== MSG || typeof e.data.u !== 'string') return;
    log('playlist ← hook fetch trong iframe');
    setPlaylist(e.data.u);
  }, { signal: page.signal });

  addEventListener('pagehide', () => { reset(); page.abort(); }, { signal: page.signal });

  for (const m of ['pushState', 'replaceState']) {
    const o = history[m].bind(history);
    history[m] = function (...a) { o(...a); queueMicrotask(checkUrl); };
  }
  addEventListener('popstate', checkUrl, { signal: page.signal });

  function setPlaylist(u) {
    if (u === url && life) return;
    url = u;
    clearTimeout(timer);
    timer = setTimeout(mount, life ? 150 : 400);
  }

  function checkUrl() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    reset();
    tries = 0; lastTry = 0;          // trang mới → cho phép thử token lại
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

    if (CFG.TOKEN_PATH && !url && !trying && ($(SEL_FRAME) || $(SEL_REGION))) grabToken();

    if (++ticks % CFG.VIP_EVERY === 0) vip();
  }, CFG.TICK);
  page.signal.addEventListener('abort', () => clearInterval(tickId), { once: true });

  /* ---- lấy playlist thẳng từ /api/hls-token --------------------------- */
  function b64url(s) {
    s = s.replace(/-/g, '+').replace(/_/g, '/');
    return atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  }

  async function grabToken() {
    if (tries >= CFG.TOKEN_TRIES) return;
    const wait = [0, 3000, 6000, 10000][tries] ?? 10000;    // backoff
    if (Date.now() - lastTry < wait) return;
    lastTry = Date.now();
    tries++;
    trying = true;

    try {
      const r = await fetch(PATH_TOKEN, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: page.signal,
      });
      if (!r.ok) throw new Error('hls-token ' + r.status);
      const tk = await r.json();
      if (!tk?.token) throw new Error('không có token');

      // (a) URL nằm sẵn trong payload của JWT
      try {
        const claims = JSON.parse(b64url(tk.token.split('.')[1]));
        if (typeof claims?.u === 'string' && claims.u.includes('.m3u8')) {
          log('playlist ← JWT claims');
          setPlaylist(claims.u);
          return;
        }
      } catch { /* không có u → thử (b) */ }

      // (b) gọi resolve bằng token + hash vừa nhận
      if (!tk.hash) throw new Error('không có hash để resolve');
      const rr = await fetch(API_BASE + RESOLVE_SUFFIX, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: tk.token, hash: tk.hash, apiBase: API_BASE, embedRequired: true }),
        signal: page.signal,
      });
      if (!rr.ok) throw new Error('resolve ' + rr.status);
      const p = await rr.json();
      if (p?.success && typeof p?.data?.url === 'string') {
        log('playlist ← resolve trực tiếp');
        setPlaylist(p.data.url);
      } else {
        throw new Error('resolve không trả url');
      }
    } catch (e) {
      if (e?.name === 'AbortError') return;
      log(`token ${tries}/${CFG.TOKEN_TRIES} hỏng:`, e.message);
      if (tries >= CFG.TOKEN_TRIES) {
        console.warn('[QMH] /api/hls-token không dùng được — vẫn chạy bằng hook iframe.');
      }
    } finally {
      trying = false;
    }
  }

  /* ---- gỡ khoá VIP ---------------------------------------------------- */
  let lastReload = 0;
  function vip() {
    if (url) return;
    const n = +(sessionStorage.getItem('__qmh_r') || 0);
    if (n >= CFG.VIP_MAX) return;

    // textContent chứ không phải innerText: innerText ép reflow cả trang
    const t = $(SEL_REGION)?.textContent || '';
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
      log('player đã gắn');

      if (CFG.KILL_FRAME) {
        // iframe gốc vẫn tải + decode song song = gấp đôi RAM video cho không
        setTimeout(() => {
          if (signal.aborted) return;
          const f = $(SEL_FRAME);
          if (!f) return;
          try { f.src = 'about:blank'; } catch {}
          f.remove();
          log('đã gỡ iframe gốc');
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
