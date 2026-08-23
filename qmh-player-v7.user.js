// ==UserScript==
// @name         QMH HLS Player (lite)
// @namespace    https://github.com/gnadgnaoh
// @version      7.0.0
// @description  Thay player QMH bằng HLS player nhẹ, phát bản playlist đầy đủ. Chỉ để xem.
// @match        https://qmh.kim/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.light.min.js
// @run-at       document-start
// ==/UserScript==

/*
 * v7.0 — GHÉP CƠ CHẾ FULL PLAYLIST TỪ UPSTREAM
 *
 *  Site trả về playlist preview bị cắt cụt (không có #EXT-X-ENDLIST). Bản đầy đủ
 *  nằm ở đường dẫn đoán được: <api>/hls/movies/<movieId>/index.m3u8, và chỉ có
 *  dòng #EXT-X-KEY là được ký. Nên: tải bản đầy đủ, ghép dòng key của preview vào,
 *  phát bản ghép. Hết cảnh reload mỗi lần hết preview.
 *
 *  Khác upstream ở ba chỗ, đều để bớt việc:
 *   - Upstream base64 hoá playlist đã ghép thành data: URL rồi mới postMessage,
 *     phía nhận lại giải mã ngược. v7 làm việc ghép ở frame trên cùng và đưa
 *     thẳng text vào Blob URL — bỏ hẳn vòng base64 (phình 33%) và 2 lần copy.
 *   - Có cache theo movieId, mount lại không phải tải lại index.m3u8.
 *   - Chỉ quét lại URL tương đối khi playlist thật sự có URL tương đối.
 *
 *  Tắt bằng CFG.FULL_PLAYLIST = false → quay về phát đúng preview như v6.2.
 *  Nếu video đen / không phát: đổi "hls.light.min.js" thành "hls.min.js".
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
  const API_ORIGIN = ORIGIN.replace(/^https?:\/\//, (m) => m + 'api.');
  const API_HOST = new URL(API_ORIGIN).hostname;
  const MSG = 'QMH_HLS';

  const RESOLVE_MARK = '/upload/video-hls/resolve';
  const SEL_REGION = 'section[aria-label="Video player"]';
  const SEL_FRAME = '#secure-m3u8-embed-frame';
  const RE_KEYLINE = /^#EXT-X-KEY:.*$/m;
  const RE_MOVIE_ID = /\/hls\/movies\/([^/]+)\//;

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
    FULL_PLAYLIST: true,   // ghép bản đầy đủ thay cho preview bị cắt
    FULL_TIMEOUT: 8000,
    // Vô hiệu iframe gốc để nó thôi buffer song song.
    //  'blank'  = đặt src=about:blank, GIỮ node trong DOM  ← an toàn với React
    //  'remove' = gỡ hẳn node (làm React crash → "This page couldn't load")
    //  false    = không đụng tới
    KILL_FRAME: 'blank',
  };

  /* ---- hook fetch trong iframe: đường lấy playlist chính -------------- */
  const origFetch = window.fetch.bind(window);
  window.fetch = function (...a) {
    const u = typeof a[0] === 'string' ? a[0] : a[0]?.url || '';
    if (!u.includes(RESOLVE_MARK)) return origFetch(...a);   // đường nhanh cho ~99% request
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

  if (!TOP) return;   // ⟵ frame con dừng tại đây. Mọi việc còn lại ở frame trên cùng.

  /* ---- trạng thái ----------------------------------------------------- */
  let url = null;     // playlist preview hiện tại (dùng làm định danh)
  let life = null;    // { ac, url, video, destroy }
  let busy = false;
  let timer = null;
  let lastUrl = location.href;
  let fullCache = null;   // { id, text } — chỉ giữ 1 phim, không phình

  const page = new AbortController();
  const $ = (s) => document.querySelector(s);

  addEventListener('message', (e) => {
    if (e.origin !== ORIGIN || e.data?.t !== MSG || typeof e.data.u !== 'string') return;
    log('playlist ← hook fetch trong iframe');
    if (e.data.u === url && life) return;
    url = e.data.u;
    clearTimeout(timer);
    timer = setTimeout(mount, life ? 150 : 400);
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

  /* ---- gỡ khoá VIP (chỉ chạy khi chưa có playlist) -------------------- */
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

  /* ---- playlist ------------------------------------------------------- */

  /** Giải mã data: URL ra text. Dùng TextDecoder để không hỏng ký tự UTF-8. */
  function dataUrlToText(u) {
    const i = u.indexOf(',');
    if (i < 0) throw new Error('data URL hỏng');
    const body = u.slice(i + 1);
    if (!u.slice(0, i).includes(';base64')) return decodeURIComponent(body);
    const bin = atob(body);
    const bytes = new Uint8Array(bin.length);
    for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
    return new TextDecoder().decode(bytes);
  }

  async function getText(u, ms) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(u, { credentials: 'omit', signal: ac.signal });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } finally {
      clearTimeout(t);
    }
  }

  /** Chỉ duyệt lại từng dòng khi playlist thật sự chứa URL tương đối. */
  function absolutize(text, base) {
    if (!/^(?!#)(?!https?:\/\/)\S/m.test(text)) return text;
    return text.split('\n').map((l) => {
      const s = l.trim();
      if (!s || s[0] === '#' || /^https?:\/\//i.test(s)) return l;
      try { return new URL(s, base).href; } catch { return l; }
    }).join('\n');
  }

  /**
   * Preview bị cắt cụt. Bản đầy đủ nằm ở <api>/hls/movies/<id>/index.m3u8,
   * chỉ dòng #EXT-X-KEY là được ký — nên ghép dòng key của preview vào bản đầy đủ.
   * Trả về text đã ghép, hoặc null nếu không nâng cấp được.
   */
  async function fullPlaylist(previewUrl) {
    if (!previewUrl.startsWith('data:')) return null;

    let preview;
    try { preview = dataUrlToText(previewUrl); } catch { return null; }

    const keyLine = preview.match(RE_KEYLINE)?.[0];
    const id = preview.match(RE_MOVIE_ID)?.[1];
    if (!keyLine || !id) { log('preview thiếu keyLine/movieId'); return null; }

    if (fullCache?.id === id) { log('full playlist ← cache'); return fullCache.text; }

    const indexUrl = `${API_ORIGIN}/hls/movies/${id}/index.m3u8`;
    let full;
    try { full = await getText(indexUrl, CFG.FULL_TIMEOUT); }
    catch (e) { log('tải index.m3u8 hỏng:', e.message); return null; }

    // Không có ENDLIST nghĩa là vẫn là bản cắt cụt → không dùng.
    if (!full.includes('#EXT-X-ENDLIST')) { log('index.m3u8 không có ENDLIST'); return null; }

    const text = absolutize(full.replace(RE_KEYLINE, keyLine), indexUrl);
    fullCache = { id, text };
    log('full playlist ok:', (text.match(/^[^#\s]/gm) || []).length, 'segment');
    return text;
  }

  /** Trả về { src, revoke } sẵn sàng đưa cho hls.js. */
  async function makeSource(previewUrl) {
    if (CFG.FULL_PLAYLIST) {
      const text = await fullPlaylist(previewUrl);
      if (text) return blobSource(text, true);
    }
    if (previewUrl.startsWith('data:')) {
      // hls.js xử lý data: được, nhưng Blob nhẹ hơn cho parser và dễ thu hồi.
      return blobSource(dataUrlToText(previewUrl), false);
    }
    return { src: previewUrl, revoke: null, full: false };
  }

  function blobSource(text, full) {
    const u = URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
    return { src: u, revoke: () => URL.revokeObjectURL(u), full };
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

      // Dựng nguồn TRƯỚC khi chèn <video>, để không bao giờ để lại thẻ video mồ côi.
      const source = await makeSource(src);
      if (src !== url) { source.revoke?.(); return; }

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

      const stop = play(video, source, signal);
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
      log('player đã gắn ·', source.full ? 'full playlist' : 'preview');

      if (CFG.KILL_FRAME) {
        // iframe gốc vẫn tải + decode song song = gấp đôi RAM video cho không.
        // NHƯNG node này do React của site quản lý: remove() làm React ném
        // NotFoundError lúc reconcile → error boundary → "This page couldn't load".
        // Nên mặc định chỉ blank src, giữ node lại.
        setTimeout(() => {
          if (signal.aborted) return;
          const f = $(SEL_FRAME);
          if (!f) return;
          try {
            if (CFG.KILL_FRAME === 'remove') {
              f.remove();
            } else {
              f.src = 'about:blank';        // ngừng tải + ngừng decode ngay
              f.setAttribute('aria-hidden', 'true');
              f.style.visibility = 'hidden';
            }
            log('đã vô hiệu iframe gốc:', CFG.KILL_FRAME);
          } catch (e) { log('không vô hiệu được iframe:', e.message); }
        }, 1200);
      }
    } catch (e) {
      console.warn('[QMH] mount hỏng:', e);
    } finally {
      busy = false;
    }
  }

  /* ---- hls ------------------------------------------------------------ */
  function play(video, source, signal) {
    const { src, revoke } = source;

    if (typeof Hls === 'undefined' || !Hls.isSupported()) {
      video.src = src;
      video.play().catch(() => {});
      return () => revoke?.();
    }

    const hls = new Hls({
      enableWorker: false,           // blob: worker hay bị CSP chặn trong FireMonkey
      lowLatencyMode: false,

      // Key và segment nằm trên host API → cần cookie. (lấy từ upstream)
      xhrSetup: (xhr, u) => {
        try { if (new URL(u, location.href).hostname === API_HOST) xhr.withCredentials = true; }
        catch {}
      },

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
      revoke?.();
    };
  }
})();
