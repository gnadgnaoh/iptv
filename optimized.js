// ==UserScript==
// @name         QMH Monster HLS Player & Downloader
// @namespace    https://github.com/gnadgnaoh
// @version      3.0.0
// @description  Replace the QMH player with a simple HLS player and download its resolved stream (low-memory build for Firefox Android / FireMonkey)
// @match        https://qmh.kim/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   *  CONFIG — chỉnh ở đây nếu máy còn yếu / còn khoẻ
   * ------------------------------------------------------------------ */
  const CFG = {
    DEBUG: false,

    // ---- Playback (nguyên nhân RAM phình khi xem lâu) ----
    BACK_BUFFER_SEC: 20,          // giữ lại bao nhiêu giây ĐÃ xem (hls.js mặc định: Infinity!)
    FWD_BUFFER_SEC: 12,           // buffer trước bao nhiêu giây
    MAX_FWD_BUFFER_SEC: 24,
    MAX_BUFFER_BYTES: 12 * 1000 * 1000,  // hls.js mặc định 60MB
    CAP_LEVEL_TO_PLAYER_SIZE: true,      // không tải 1080p/4K vào khung 360px
    ENABLE_WORKER: false,         // giữ false cho FireMonkey (blob: worker hay bị CSP chặn)
    STOP_LOAD_WHEN_HIDDEN: true,  // ngừng tải khi chuyển tab / tắt màn hình
    STOP_LOAD_AFTER_PAUSE_MS: 20000,

    // ---- Download (nguyên nhân sập máy) ----
    PART_SIZE_BYTES: 150 * 1024 * 1024, // cắt file thành nhiều phần ~150MB -> RAM có trần
    DOWNLOAD_CONCURRENCY: 2,            // 3 -> 2 cho mobile
    SEGMENT_TIMEOUT_MS: 20000,
    SEGMENT_RETRY: 3,

    // ---- Polling / observer ----
    TICK_MS: 1000,                // 1 timer duy nhất thay cho 2 setInterval
    VIP_CHECK_EVERY_TICKS: 5,     // -> 5s/lần
    VIP_MAX_RELOADS: 3,           // chặn vòng lặp reload vô hạn
    MUTATION_THROTTLE_MS: 400,
  };

  const log = CFG.DEBUG ? console.info.bind(console, '[QMH]') : () => {};
  const warn = console.warn.bind(console, '[QMH]');

  /* ------------------------------------------------------------------ */

  const MESSAGE_TYPE = 'QMH_RESOLVED_HLS';
  const KEY_MESSAGE_TYPE = 'QMH_AES_KEY';
  const RESOLVE_PATH = '/api/v1/upload/video-hls/resolve';
  const HLS_TOKEN_PATH = '/api/hls-token';
  const isTopFrame = window === window.top;

  const SITE_ORIGIN = location.origin;
  const SITE_HOST = location.hostname;
  const API_ORIGIN = SITE_ORIGIN.replace(/^https?:\/\//, (m) => m + 'api.');

  let currentPlaylistUrl = null;
  let playerCleanup = null;
  let mountTimer = null;
  let mountGeneration = 0;
  let mountInFlight = false;
  let playerObserver = null;
  let playerPortal = null;
  let portalPositionCleanup = null;
  let currentSurface = null;
  let cachedKey = null;
  let resolveBody = null;
  let masterTick = null;
  let activeDownload = null;

  installFetchInterceptor();
  installKeyCapture();

  // Frame con chỉ cần 2 hook ở trên -> thoát sớm, không dựng observer/timer/DOM.
  if (!isTopFrame) return;

  window.addEventListener('message', handleWindowMessage);
  window.addEventListener('pagehide', teardownAll, { once: true });
  startMasterTick();

  /* ================================================================== *
   *  1. TIMER GỘP  (thay cho setInterval 300ms + setInterval 5000ms)
   * ================================================================== */

  function startMasterTick() {
    let lastUrl = location.href;
    let ticks = 0;
    let vipReloads = Number(sessionStorage.getItem('__qmh_vip_reloads') || 0);
    let lastReload = 0;

    const originalPushState = history.pushState.bind(history);
    const originalReplaceState = history.replaceState.bind(history);
    history.pushState = function (...args) {
      originalPushState(...args);
      checkUrl();
    };
    history.replaceState = function (...args) {
      originalReplaceState(...args);
      checkUrl();
    };
    window.addEventListener('popstate', checkUrl);

    function checkUrl() {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      resetPlayerState();
    }

    function checkVipLock() {
      if (currentPlaylistUrl) return;
      if (vipReloads >= CFG.VIP_MAX_RELOADS) return;

      const region = document.querySelector('section[aria-label="Video player"]');
      if (!region) return;

      // textContent thay vì innerText: KHÔNG ép reflow/layout mỗi 5 giây.
      const text = region.textContent || '';
      if (!text.includes('VIP PREVIEW ENDED') &&
          !(text.includes('VIP') && text.includes('Nâng cấp VIP'))) return;

      const isLockKey = (name) =>
        name.startsWith('vip_locked_movie_') || name.startsWith('vip_watch_sec_movie_');

      let cleared = 0;
      for (const store of [localStorage, sessionStorage]) {
        for (let i = store.length - 1; i >= 0; i--) {
          const name = store.key(i);
          if (name && isLockKey(name)) { store.removeItem(name); cleared++; }
        }
      }
      for (const c of document.cookie.split(';')) {
        const name = c.split('=')[0].trim();
        if (isLockKey(name)) {
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; domain=.' + SITE_HOST;
          document.cookie = name + '=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/';
          cleared++;
        }
      }

      if (!cleared) return;
      const now = Date.now();
      if (now - lastReload <= 15000) return;
      lastReload = now;
      vipReloads++;
      sessionStorage.setItem('__qmh_vip_reloads', String(vipReloads));
      warn(`VIP lock detected, cleared ${cleared} key(s). Reload ${vipReloads}/${CFG.VIP_MAX_RELOADS}`);
      location.reload();
    }

    masterTick = setInterval(() => {
      // Tab ẩn -> khỏi làm gì cả, tiết kiệm CPU/RAM khi ở background.
      if (document.hidden) return;
      ticks++;
      checkUrl();
      if (ticks % CFG.VIP_CHECK_EVERY_TICKS === 0) checkVipLock();
    }, CFG.TICK_MS);
  }

  function resetPlayerState() {
    clearTimeout(mountTimer);
    mountTimer = null;
    mountGeneration++;
    currentPlaylistUrl = null;
    currentSurface = null;
    try { playerCleanup?.(); } catch (e) { warn(e); }
    playerCleanup = null;
    try { portalPositionCleanup?.(); } catch (e) { warn(e); }
    portalPositionCleanup = null;
    playerObserver?.disconnect();
    playerObserver = null;
    playerPortal?.remove();
    playerPortal = null;
  }

  function teardownAll() {
    activeDownload?.abort();
    activeDownload = null;
    clearInterval(masterTick);
    masterTick = null;
    resetPlayerState();
    cachedKey = null;
    resolveBody = null;
  }

  /* ================================================================== *
   *  2. HOOK FETCH / XHR
   * ================================================================== */

  function installFetchInterceptor() {
    if (window.__qmhHlsFetchInstalled) return;
    window.__qmhHlsFetchInstalled = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      // Fast path: 99% request không liên quan -> trả thẳng, không clone, không parse.
      if (!requestUrl.includes(RESOLVE_PATH)) return originalFetch(...args);

      const requestInit = typeof args[1] === 'object' && args[1] ? args[1] : {};
      if (typeof requestInit.body === 'string') {
        try {
          const parsed = JSON.parse(requestInit.body);
          if (parsed?.token && parsed?.hash) {
            resolveBody = { token: parsed.token, hash: parsed.hash, apiBase: parsed.apiBase, embedRequired: parsed.embedRequired };
          }
        } catch (e) { /* ignore */ }
      }

      const response = await originalFetch(...args);
      if (response.ok) {
        // clone() phải được ĐỌC HẾT, nếu không Gecko giữ nguyên stream trong bộ nhớ.
        response.clone().json()
          .then((payload) => {
            const playlistUrl = payload?.data?.url;
            if (payload?.success && typeof playlistUrl === 'string') {
              window.top.postMessage({ type: MESSAGE_TYPE, playlistUrl }, SITE_ORIGIN);
            }
          })
          .catch(() => {});
      }
      return response;
    };
  }

  function installKeyCapture() {
    if (window.__qmhKeyCaptureInstalled) return;
    window.__qmhKeyCaptureInstalled = true;

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__qmhKeyUrl = typeof url === 'string' && url.includes('/video-hls-key/');
      return originalOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (...args) {
      if (this.__qmhKeyUrl) {
        const xhr = this;
        xhr.addEventListener('load', function onLoad() {
          xhr.removeEventListener('load', onLoad);
          const buf = xhr.response;
          if (xhr.status === 200 && buf && buf.byteLength === 16) {
            cachedKey = new Uint8Array(buf.slice(0));
            if (!isTopFrame) {
              window.top.postMessage(
                { type: KEY_MESSAGE_TYPE, keyBytes: Array.from(cachedKey) }, SITE_ORIGIN);
            }
          }
        }, { once: true });
      }
      return originalSend.apply(this, args);
    };
  }

  function handleWindowMessage(event) {
    if (event.origin !== SITE_ORIGIN) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === KEY_MESSAGE_TYPE && Array.isArray(data.keyBytes) && data.keyBytes.length === 16) {
      cachedKey = new Uint8Array(data.keyBytes);
      log('AES key received from player frame');
      return;
    }
    if (data.type === MESSAGE_TYPE && typeof data.playlistUrl === 'string') {
      if (data.playlistUrl === currentPlaylistUrl) return;   // chặn mount lặp
      currentPlaylistUrl = data.playlistUrl;
      scheduleMount(750);
    }
  }

  /* ================================================================== *
   *  3. MOUNT PLAYER  (chống re-entrancy / nhân bản Hls instance)
   * ================================================================== */

  function scheduleMount(delayMs) {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(async () => {
      mountTimer = null;
      await waitForPageReady();
      if (!currentPlaylistUrl) return;
      mountPlayer(currentPlaylistUrl).catch((e) => warn('mount failed:', e));
    }, delayMs);
  }

  async function waitForPageReady() {
    if (document.readyState !== 'complete') {
      await new Promise((r) => window.addEventListener('load', r, { once: true }));
    }
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  }

  async function mountPlayer(playlistUrl) {
    // KHOÁ: bản cũ có thể chạy song song nhiều lần -> nhiều <video> + nhiều Hls
    // cùng buffer => RAM nhân đôi/ba. Đây là thủ phạm chính khi SPA re-render.
    if (mountInFlight) return;
    mountInFlight = true;
    try {
      const surface = findPlayerSurface(document.getElementById('secure-m3u8-embed-frame'));
      if (!surface) return;

      const existing = playerPortal;
      if (existing?.isConnected && existing.dataset.playlistUrl === playlistUrl) {
        if (currentSurface !== surface) {
          portalPositionCleanup?.();
          portalPositionCleanup = positionPortal(existing, surface);
          currentSurface = surface;
        }
        watchPlayer();
        return;
      }

      const generation = ++mountGeneration;

      playerCleanup?.();
      playerCleanup = null;
      portalPositionCleanup?.();
      portalPositionCleanup = null;
      playerPortal?.remove();
      playerPortal = null;

      const { wrapper, video, status, downloadButton } = buildUi(playlistUrl);
      document.body.appendChild(wrapper);
      playerPortal = wrapper;
      currentSurface = surface;
      portalPositionCleanup = positionPortal(wrapper, surface);
      watchPlayer();

      const cleanup = await startHls(video, playlistUrl, status);

      if (generation !== mountGeneration || !wrapper.isConnected) {
        cleanup();                       // huỷ ngay nếu đã bị thay thế trong lúc await
        video.removeAttribute('src');
        video.load();
        return;
      }

      playerCleanup = () => {
        try { cleanup(); } catch (e) { warn(e); }
        try {
          video.pause();
          video.removeAttribute('src');
          video.load();               // giải phóng SourceBuffer/MSE
        } catch (e) { /* ignore */ }
        downloadButton.replaceWith(downloadButton.cloneNode(true)); // xoá listener
      };
    } finally {
      mountInFlight = false;
    }
  }

  function buildUi(playlistUrl) {
    const wrapper = document.createElement('div');
    wrapper.id = 'qmh-simple-hls-player';
    wrapper.dataset.playlistUrl = playlistUrl;
    wrapper.style.cssText =
      'position:fixed !important;display:flex;flex-direction:column;background:#000;' +
      'z-index:2147483647 !important;visibility:visible !important;' +
      'pointer-events:auto !important;overflow:hidden;contain:layout paint';

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.preload = 'metadata';
    if ('disableRemotePlayback' in video) video.disableRemotePlayback = true;
    video.style.cssText = 'width:100%;min-height:0;flex:1;background:#000;object-fit:contain';

    const toolbar = document.createElement('div');
    toolbar.style.cssText =
      'display:flex;align-items:center;gap:8px;padding:8px 10px;background:#151515;color:#fff;font:13px sans-serif';

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = 'Download video';
    downloadButton.style.cssText =
      'border:1px solid #555;background:#fff;color:#111;padding:6px 10px;cursor:pointer;font-weight:600;flex:none';

    const cancelButton = document.createElement('button');
    cancelButton.type = 'button';
    cancelButton.textContent = 'Huỷ';
    cancelButton.style.cssText =
      'border:1px solid #555;background:#333;color:#fff;padding:6px 10px;cursor:pointer;flex:none;display:none';

    const status = document.createElement('span');
    status.textContent = 'Loading HLS...';
    status.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    downloadButton.addEventListener('click', () =>
      downloadVideo(playlistUrl, downloadButton, cancelButton, status));
    cancelButton.addEventListener('click', () => activeDownload?.abort());

    toolbar.append(downloadButton, cancelButton, status);
    wrapper.append(video, toolbar);
    return { wrapper, video, status, downloadButton };
  }

  function findPlayerSurface(frame) {
    if (frame?.parentElement) return frame.parentElement;
    const region = document.querySelector('section[aria-label="Video player"]');
    return region?.querySelector('[class*="aspect-video"]') || region?.firstElementChild || null;
  }

  function isVideoPage() {
    return !!document.getElementById('secure-m3u8-embed-frame') ||
      !!document.querySelector('section[aria-label="Video player"]');
  }

  /* ---- Observer: 1 instance duy nhất, có throttle, không đệ quy ---- */
  function watchPlayer() {
    if (playerObserver) return;

    let pending = false;
    let lastRun = 0;

    const run = () => {
      pending = false;
      lastRun = Date.now();

      if (!playerPortal?.isConnected) {
        if (currentPlaylistUrl && isVideoPage() && !mountInFlight && !mountTimer) scheduleMount(150);
        return;
      }
      if (!currentSurface?.isConnected) {
        const replacement = findPlayerSurface(document.getElementById('secure-m3u8-embed-frame'));
        if (replacement) {
          portalPositionCleanup?.();
          portalPositionCleanup = positionPortal(playerPortal, replacement);
          currentSurface = replacement;
        }
      }
    };

    playerObserver = new MutationObserver(() => {
      if (pending) return;
      pending = true;
      const wait = Math.max(0, CFG.MUTATION_THROTTLE_MS - (Date.now() - lastRun));
      setTimeout(() => requestAnimationFrame(run), wait);
    });

    // Chỉ theo dõi childList; attributes/characterData trên SPA bắn liên tục vô ích.
    playerObserver.observe(document.body, { childList: true, subtree: true });
  }

  function positionPortal(portal, surface) {
    let rafId = 0;
    let lastRadius = '';

    const update = () => {
      rafId = 0;
      if (!portal.isConnected || !surface.isConnected) return;
      const rect = surface.getBoundingClientRect();
      const s = portal.style;
      s.setProperty('left', `${rect.left}px`, 'important');
      s.setProperty('top', `${rect.top}px`, 'important');
      s.setProperty('width', `${rect.width}px`, 'important');
      s.setProperty('height', `${rect.height}px`, 'important');
      // getComputedStyle mỗi frame rất đắt -> chỉ đọc khi cần
      if (!lastRadius) {
        lastRadius = getComputedStyle(surface).borderRadius;
        s.setProperty('border-radius', lastRadius, 'important');
      }
    };
    const requestUpdate = () => {
      if (!rafId && !document.hidden) rafId = requestAnimationFrame(update);
    };

    const ro = new ResizeObserver(requestUpdate);
    ro.observe(surface);
    window.addEventListener('resize', requestUpdate, { passive: true });
    window.addEventListener('scroll', requestUpdate, { passive: true, capture: true });
    update();

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
      window.removeEventListener('resize', requestUpdate);
      window.removeEventListener('scroll', requestUpdate, { capture: true });
    };
  }

  /* ================================================================== *
   *  4. HLS  — cấu hình chặn buffer vô hạn
   * ================================================================== */

  function waitForHls(timeoutMs = 10000) {
    if (typeof Hls !== 'undefined') return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (typeof Hls !== 'undefined' || Date.now() - started > timeoutMs) return resolve();
        setTimeout(check, 150);
      };
      check();
    });
  }

  async function startHls(video, playlistUrl, status) {
    await waitForHls(10000);

    const playbackUrl = await createPlaybackUrl(playlistUrl);
    const revoke = playbackUrl.startsWith('blob:')
      ? () => URL.revokeObjectURL(playbackUrl)
      : () => {};

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: CFG.ENABLE_WORKER,
        lowLatencyMode: false,
        progressive: false,

        // *** QUAN TRỌNG NHẤT ***
        // hls.js mặc định backBufferLength = Infinity: mọi giây đã xem đều nằm
        // trong SourceBuffer. Xem phim 2 tiếng = vài GB RAM -> sập máy.
        backBufferLength: CFG.BACK_BUFFER_SEC,
        frontBufferFlushThreshold: CFG.MAX_FWD_BUFFER_SEC,

        maxBufferLength: CFG.FWD_BUFFER_SEC,
        maxMaxBufferLength: CFG.MAX_FWD_BUFFER_SEC,
        maxBufferSize: CFG.MAX_BUFFER_BYTES,
        maxBufferHole: 0.5,

        // Không kéo 1080p/4K về khung hình nhỏ trên điện thoại
        capLevelToPlayerSize: CFG.CAP_LEVEL_TO_PLAYER_SIZE,
        capLevelOnFPSDrop: true,
        startLevel: -1,

        fragLoadingMaxRetry: 3,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 3,
      });

      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playbackUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        status.textContent = 'HLS ready';
        video.play().catch(() => {});
      });

      // Backoff: bản cũ gọi startLoad() ngay lập tức trong vòng lặp lỗi mạng
      // -> spam request + rác không kịp GC.
      let recover = 0;
      let recoverTimer = null;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        status.textContent = `Player error: ${data.details}`;
        if (recover >= 5) { hls.destroy(); return; }
        recover++;
        clearTimeout(recoverTimer);
        recoverTimer = setTimeout(() => {
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else hls.destroy();
        }, 500 * recover);
      });

      // Ngừng tải khi tab ẩn / video pause lâu -> không phình buffer nền.
      let pauseTimer = null;
      let loadStopped = false;
      const stopLoad = () => { if (!loadStopped) { loadStopped = true; try { hls.stopLoad(); } catch (e) {} } };
      const startLoad = () => { if (loadStopped) { loadStopped = false; try { hls.startLoad(); } catch (e) {} } };

      const onVisibility = () => {
        if (!CFG.STOP_LOAD_WHEN_HIDDEN) return;
        document.hidden ? stopLoad() : startLoad();
      };
      const onPause = () => {
        clearTimeout(pauseTimer);
        pauseTimer = setTimeout(stopLoad, CFG.STOP_LOAD_AFTER_PAUSE_MS);
      };
      const onPlay = () => { clearTimeout(pauseTimer); startLoad(); };

      document.addEventListener('visibilitychange', onVisibility);
      video.addEventListener('pause', onPause);
      video.addEventListener('play', onPlay);

      return () => {
        clearTimeout(recoverTimer);
        clearTimeout(pauseTimer);
        document.removeEventListener('visibilitychange', onVisibility);
        video.removeEventListener('pause', onPause);
        video.removeEventListener('play', onPlay);
        try { hls.destroy(); } catch (e) { warn(e); }
        revoke();
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const onError = () => {
        status.textContent = `Media error: ${video.error?.message || 'unsupported video format'}`;
      };
      video.addEventListener('error', onError);
      video.src = playbackUrl;
      video.play().catch(() => {});
      status.textContent = 'HLS ready';
      return () => {
        video.removeEventListener('error', onError);
        revoke();
      };
    }

    revoke();
    status.textContent = 'HLS playback is not supported in this browser';
    return () => {};
  }

  async function createPlaybackUrl(playlistUrl) {
    if (!playlistUrl.startsWith('data:')) return playlistUrl;
    const text = await readPlaylist(playlistUrl);
    return URL.createObjectURL(new Blob([text], { type: 'application/vnd.apple.mpegurl' }));
  }

  /* ================================================================== *
   *  5. DOWNLOAD — streaming theo phần, RAM có trần
   * ================================================================== */

  async function downloadVideo(playlistUrl, button, cancelButton, status) {
    if (activeDownload) return;
    const ctrl = new AbortController();
    activeDownload = ctrl;

    button.disabled = true;
    button.style.cursor = 'wait';
    cancelButton.style.display = '';

    // Giữ ở scope ngoài để finally có thể chủ động xoá tham chiếu.
    let parts = [];
    let playlist = null;

    try {
      status.textContent = 'Reading playlist...';
      let playlistText = await readPlaylist(playlistUrl, ctrl.signal);

      if (!(cachedKey && cachedKey.byteLength === 16)) {
        const fresh = await resolveFreshPlaylist(ctrl.signal);
        if (fresh) {
          playlistUrl = fresh.playlistUrl;
          playlistText = fresh.playlistText;
          status.textContent = 'Reading fresh playlist...';
        }
      }

      playlist = parsePlaylist(playlistText, playlistUrl);
      playlistText = null;
      if (!playlist.segments.length) throw new Error('The playlist has no media segments');

      let cryptoKey = null;
      if (playlist.keyUrl) {
        if (!(cachedKey && cachedKey.byteLength === 16)) {
          status.textContent = 'Waiting for AES key...';
          await waitForKey(3000);
        }
        if (!(cachedKey && cachedKey.byteLength === 16)) {
          status.textContent = 'Loading encryption key...';
          const keyBytes = new Uint8Array(await fetchBuffer(playlist.keyUrl, ctrl.signal));
          if (keyBytes.byteLength !== 16) throw new Error(`Invalid AES key length: ${keyBytes.byteLength}`);
          cachedKey = keyBytes;
        }
        cryptoKey = await crypto.subtle.importKey('raw', cachedKey, { name: 'AES-CBC' }, false, ['decrypt']);
      }

      const total = playlist.segments.length;
      const baseName = makeFilename();
      const multiPart = CFG.PART_SIZE_BYTES > 0;

      let nextIndex = 0;
      let completed = 0;
      let partBytes = 0;
      let totalBytes = 0;
      let partNo = 1;

      // Cửa sổ trượt: worker chỉ được chạy trước con trỏ ghi tối đa N segment,
      // nên số ArrayBuffer sống cùng lúc luôn <= concurrency + 1.
      const pending = new Map();      // index -> Blob
      let writeIndex = 0;

      const flushPart = async (force) => {
        if (!parts.length) return;
        if (!force && (!multiPart || partBytes < CFG.PART_SIZE_BYTES)) return;

        status.textContent = `Saving part ${partNo}...`;
        // Blob-of-Blobs trong Gecko là multipart, KHÔNG copy lại dữ liệu.
        const blob = new Blob(parts, { type: 'video/mp2t' });
        parts = [];                                     // thả tham chiếu ngay
        const name = multiPart && (partNo > 1 || !force)
          ? baseName.replace(/\.ts$/i, `.part${String(partNo).padStart(2, '0')}.ts`)
          : baseName;
        triggerDownload(blob, name);
        partNo++;
        partBytes = 0;
        await delay(300);                               // cho trình duyệt kịp ghi ra đĩa
      };

      const drain = async () => {
        while (pending.has(writeIndex)) {
          const blob = pending.get(writeIndex);
          pending.delete(writeIndex);
          writeIndex++;
          parts.push(blob);
          partBytes += blob.size;
          totalBytes += blob.size;
          await flushPart(false);
        }
      };

      async function worker() {
        while (nextIndex < total) {
          if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');

          // chặn chạy quá xa con trỏ ghi
          while (nextIndex - writeIndex > CFG.DOWNLOAD_CONCURRENCY + 1) {
            await delay(50);
            if (ctrl.signal.aborted) throw new DOMException('Aborted', 'AbortError');
          }

          const index = nextIndex++;
          let buf = await fetchBufferWithRetry(playlist.segments[index], CFG.SEGMENT_RETRY, ctrl.signal);

          if (cryptoKey) {
            const iv = playlist.iv || sequenceIv(playlist.mediaSequence + index);
            if (iv.byteLength !== 16) throw new Error(`Invalid IV length at segment ${index + 1}`);
            if (buf.byteLength % 16 !== 0) throw new Error(`Segment ${index + 1} is not AES block-aligned`);
            try {
              const dec = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, buf);
              buf = null;                               // bỏ bản mã hoá ngay
              pending.set(index, new Blob([dec]));      // ArrayBuffer -> Blob (ra khỏi JS heap)
            } catch (error) {
              throw new Error(`Could not decrypt segment ${index + 1}: ${error.message}`);
            }
          } else {
            pending.set(index, new Blob([buf]));
            buf = null;
          }

          completed++;
          if (completed % 3 === 0 || completed === total) {
            status.textContent = `Downloading ${completed}/${total} (${formatBytes(totalBytes)})`;
          }
          await drain();
        }
      }

      const workerCount = Math.min(CFG.DOWNLOAD_CONCURRENCY, total);
      await Promise.all(Array.from({ length: workerCount }, worker));
      await drain();
      await flushPart(true);

      status.textContent = `Xong — ${formatBytes(totalBytes)}` +
        (partNo > 2 ? ` (${partNo - 1} phần)` : '');
    } catch (error) {
      if (error?.name === 'AbortError') {
        status.textContent = 'Đã huỷ tải';
      } else {
        console.error('[QMH] Download failed:', error);
        status.textContent = `Download failed: ${error.message}`;
      }
    } finally {
      parts = null;
      playlist = null;
      activeDownload = null;
      button.disabled = false;
      button.style.cursor = 'pointer';
      cancelButton.style.display = 'none';
    }
  }

  /* ================================================================== *
   *  6. NETWORK HELPERS
   * ================================================================== */

  async function resolveFreshPlaylist(signal) {
    try {
      const tokenResp = await fetch(HLS_TOKEN_PATH, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
        signal,
      });
      if (!tokenResp.ok) throw new Error(`hls-token failed: ${tokenResp.status}`);
      const tokenPayload = await tokenResp.json();
      if (!tokenPayload?.token) throw new Error('hls-token returned no token');

      if (resolveBody) {
        const apiBase = resolveBody.apiBase || API_ORIGIN + '/api/v1';
        const resolveResp = await fetch(`${apiBase}${RESOLVE_PATH}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            token: tokenPayload.token,
            hash: tokenPayload.hash || resolveBody.hash,
            apiBase,
            embedRequired: resolveBody.embedRequired ?? true,
          }),
          signal,
        });
        if (!resolveResp.ok) throw new Error(`resolve failed: ${resolveResp.status}`);
        const payload = await resolveResp.json();
        const url = payload?.data?.url;
        if (payload?.success && typeof url === 'string') {
          return { playlistUrl: url, playlistText: await readPlaylist(url, signal) };
        }
      }

      const decoded = JSON.parse(
        atob(tokenPayload.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')) || '{}');
      const m3u8Url = decoded?.u;
      if (typeof m3u8Url === 'string' && /\.m3u8/.test(m3u8Url)) {
        return { playlistUrl: m3u8Url, playlistText: await requestWithFetch(m3u8Url, 'text', signal) };
      }
      return null;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      warn('Fresh resolve failed:', error);
      return null;
    }
  }

  async function readPlaylist(url, signal) {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) throw new Error('Invalid data playlist URL');
      const meta = url.slice(0, comma);
      const content = url.slice(comma + 1);
      return meta.includes(';base64') ? atob(content) : decodeURIComponent(content);
    }
    return requestWithFetch(url, 'text', signal);
  }

  function parsePlaylist(text, playlistUrl) {
    const segments = [];
    let keyUrl = null;
    let iv = null;
    let mediaSequence = 0;

    // Duyệt từng dòng không tạo mảng trung gian .map().filter() cho playlist lớn.
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
        mediaSequence = Number(line.split(':')[1]) || 0;
      } else if (line.startsWith('#EXT-X-KEY:')) {
        const method = line.match(/METHOD=([^,]+)/)?.[1];
        if (method && method !== 'NONE' && method !== 'AES-128') {
          throw new Error(`Unsupported encryption method: ${method}`);
        }
        const uri = line.match(/URI="([^"]+)"/)?.[1];
        if (method === 'AES-128' && uri) keyUrl = resolveUrl(playlistUrl, uri);
        const ivHex = line.match(/IV=0x([0-9a-f]+)/i)?.[1];
        if (ivHex) iv = hexToBytes(ivHex.padStart(32, '0'));
      } else if (line[0] !== '#') {
        segments.push(resolveUrl(playlistUrl, line));
      }
    }
    return { segments, keyUrl, iv, mediaSequence };
  }

  async function requestWithFetch(url, responseType, signal) {
    const ctrl = new AbortController();
    const onAbort = () => ctrl.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    const timeout = setTimeout(() => ctrl.abort(), CFG.SEGMENT_TIMEOUT_MS);
    try {
      const response = await fetch(url, {
        credentials: new URL(url).hostname === location.hostname ? 'include' : 'omit',
        signal: ctrl.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return responseType === 'text' ? response.text() : response.arrayBuffer();
    } catch (error) {
      if (error?.name === 'AbortError') {
        if (signal?.aborted) throw error;
        throw new Error(`Request timed out: ${url}`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  // Bỏ .slice(0) của bản cũ: response.arrayBuffer() vốn đã là buffer mới,
  // copy thêm một lần nữa = nhân đôi RAM cho MỌI segment.
  async function fetchBuffer(url, signal) {
    const value = await requestWithFetch(url, 'arraybuffer', signal);
    if (value instanceof ArrayBuffer) return value;
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error(`Invalid binary response from ${new URL(url).hostname}`);
  }

  async function fetchBufferWithRetry(url, maxAttempts, signal) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fetchBuffer(url, signal);
      } catch (error) {
        if (error?.name === 'AbortError' && signal?.aborted) throw error;
        lastError = error;
        if (attempt < maxAttempts) await delay(500 * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

  /* ================================================================== *
   *  7. UTILS
   * ================================================================== */

  function resolveUrl(base, value) {
    if (/^https?:\/\//i.test(value)) return value;
    if (base.startsWith('data:')) throw new Error(`Relative URL in data playlist: ${value}`);
    return new URL(value, base).href;
  }

  function sequenceIv(sequence) {
    const iv = new Uint8Array(16);
    new DataView(iv.buffer).setUint32(12, sequence);
    return iv;
  }

  function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  function triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Bản cũ giữ blob 60s. 10s là quá đủ và giải phóng sớm hơn nhiều.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
  }

  function makeFilename() {
    const title = document.querySelector('h1')?.textContent?.trim() || document.title || 'qmh-video';
    return `${title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 120)}.ts`;
  }

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let i = 0;
    while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
    return `${value.toFixed(i ? 1 : 0)} ${units[i]}`;
  }

  function delay(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function waitForKey(timeoutMs = 5000) {
    if (cachedKey?.byteLength === 16) return Promise.resolve();
    return new Promise((resolve) => {
      const started = Date.now();
      const check = () => {
        if (cachedKey?.byteLength === 16 || Date.now() - started > timeoutMs) return resolve();
        setTimeout(check, 150);
      };
      check();
    });
  }
})();
