// ==UserScript==
// @name         QMH Monster HLS Player & Downloader
// @namespace    https://github.com/siritami
// @version      2.4.0
// @description  Replace the QMH player with a simple HLS player and download its resolved stream
// @match        https://qmh.monster/*
// @grant        none
// @allFrames    true
// @require      https://cdn.jsdelivr.net/npm/hls.js@1.6.13/dist/hls.min.js
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const MESSAGE_TYPE = 'QMH_RESOLVED_HLS';
  const RESOLVE_PATH = '/api/v1/upload/video-hls/resolve';
  const isTopFrame = window === window.top;

  let currentPlaylistUrl = null;
  let playerCleanup = null;
  let mountTimer = null;
  let mountGeneration = 0;
  let playerObserver = null;
  let playerPortal = null;
  let portalPositionCleanup = null;

  installFetchInterceptor();
  if (isTopFrame) window.addEventListener('message', handleResolvedPlaylist);

  // ── @grant none: script chạy trong page context, patch fetch trực tiếp ───
  function installFetchInterceptor() {
    if (window.__qmhHlsFetchInstalled) return;
    window.__qmhHlsFetchInstalled = true;

    const originalFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const response = await originalFetch(...args);
      const requestUrl = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';

      if (requestUrl.includes(RESOLVE_PATH) && response.ok) {
        response.clone().json().then((payload) => {
          const playlistUrl = payload?.data?.url;
          if (payload?.success && typeof playlistUrl === 'string') {
            window.top.postMessage({ type: MESSAGE_TYPE, playlistUrl }, '*');
          }
        }).catch((e) => console.warn('[QMH HLS] Could not read resolve response:', e));
      }

      return response;
    };
  }

  function handleResolvedPlaylist(event) {
    if (!isTopFrame) return;
    if (event.data?.type !== MESSAGE_TYPE || typeof event.data.playlistUrl !== 'string') return;
    currentPlaylistUrl = event.data.playlistUrl;
    scheduleMount(750);
  }

  function scheduleMount(delayMilliseconds) {
    clearTimeout(mountTimer);
    mountTimer = setTimeout(async () => {
      await waitForPageReady();
      if (!currentPlaylistUrl) return;
      mountPlayer(currentPlaylistUrl).catch((error) => {
        console.error('[QMH HLS] Could not mount player:', error);
      });
    }, delayMilliseconds);
  }

  async function waitForPageReady() {
    if (document.readyState !== 'complete') {
      await new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  async function mountPlayer(playlistUrl) {
    const oldFrame = document.getElementById('secure-m3u8-embed-frame');
    const playerSurface = findPlayerSurface(oldFrame);
    if (!playerSurface) return;
    const generation = ++mountGeneration;

    const existingPlayer = document.getElementById('qmh-simple-hls-player');
    if (existingPlayer?.dataset.playlistUrl === playlistUrl) {
      portalPositionCleanup?.();
      portalPositionCleanup = positionPortal(existingPlayer, playerSurface);
      watchPlayer(playerSurface);
      return;
    }

    playerCleanup?.();
    playerCleanup = null;
    portalPositionCleanup?.();
    portalPositionCleanup = null;
    playerPortal?.remove();
    playerPortal = null;

    const wrapper = document.createElement('div');
    wrapper.id = 'qmh-simple-hls-player';
    wrapper.dataset.playlistUrl = playlistUrl;
    wrapper.style.cssText = [
      'position:fixed !important',
      'display:flex',
      'flex-direction:column',
      'background:#000',
      'z-index:2147483647 !important',
      'visibility:visible !important',
      'pointer-events:auto !important',
      'overflow:hidden',
    ].join(';');

    const video = document.createElement('video');
    video.controls = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText = 'width:100%;min-height:0;flex:1;background:#000;object-fit:contain';

    const toolbar = document.createElement('div');
    toolbar.style.cssText = [
      'display:flex',
      'align-items:center',
      'gap:10px',
      'padding:8px 10px',
      'background:#151515',
      'color:#fff',
      'font:13px sans-serif',
    ].join(';');

    const downloadButton = document.createElement('button');
    downloadButton.type = 'button';
    downloadButton.textContent = 'Download video';
    downloadButton.style.cssText = [
      'border:1px solid #555',
      'background:#fff',
      'color:#111',
      'padding:6px 10px',
      'cursor:pointer',
      'font-weight:600',
    ].join(';');

    const status = document.createElement('span');
    status.textContent = 'Loading HLS...';
    status.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap';

    downloadButton.addEventListener('click', () => downloadVideo(playlistUrl, downloadButton, status));
    toolbar.append(downloadButton, status);
    wrapper.append(video, toolbar);
    document.body.appendChild(wrapper);
    playerPortal = wrapper;
    portalPositionCleanup = positionPortal(wrapper, playerSurface);
    watchPlayer(playerSurface);

    const cleanup = await startHls(video, playlistUrl, status);
    if (generation !== mountGeneration || !wrapper.isConnected) {
      cleanup();
      return;
    }

    playerCleanup = () => {
      cleanup();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
  }

  function findPlayerSurface(frame) {
    if (frame?.parentElement) return frame.parentElement;
    const playerRegion = document.querySelector('section[aria-label="Video player"]');
    return playerRegion?.querySelector('[class*="aspect-video"]') || playerRegion?.firstElementChild;
  }

  function positionPortal(portal, surface) {
    let animationFrame = 0;
    const update = () => {
      animationFrame = 0;
      if (!portal.isConnected || !surface.isConnected) return;
      const rect = surface.getBoundingClientRect();
      portal.style.setProperty('left', `${rect.left}px`, 'important');
      portal.style.setProperty('top', `${rect.top}px`, 'important');
      portal.style.setProperty('width', `${rect.width}px`, 'important');
      portal.style.setProperty('height', `${rect.height}px`, 'important');
      portal.style.setProperty('border-radius', getComputedStyle(surface).borderRadius, 'important');
    };
    const requestUpdate = () => {
      if (!animationFrame) animationFrame = requestAnimationFrame(update);
    };
    const resizeObserver = new ResizeObserver(requestUpdate);
    resizeObserver.observe(surface);
    window.addEventListener('resize', requestUpdate);
    window.addEventListener('scroll', requestUpdate, true);
    update();

    return () => {
      if (animationFrame) cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      window.removeEventListener('resize', requestUpdate);
      window.removeEventListener('scroll', requestUpdate, true);
    };
  }

  function watchPlayer(surface) {
    playerObserver?.disconnect();
    playerObserver = new MutationObserver(() => {
      if (!playerPortal?.isConnected) {
        scheduleMount(100);
        return;
      }
      if (!surface.isConnected) {
        const replacementSurface = findPlayerSurface(document.getElementById('secure-m3u8-embed-frame'));
        if (replacementSurface) {
          portalPositionCleanup?.();
          portalPositionCleanup = positionPortal(playerPortal, replacementSurface);
          watchPlayer(replacementSurface);
        }
      }
    });
    playerObserver.observe(document.body, { childList: true, subtree: true });
  }

  async function startHls(video, playlistUrl, status) {
    const playbackUrl = await createPlaybackUrl(playlistUrl);
    const revokePlaybackUrl = playbackUrl.startsWith('blob:')
      ? () => URL.revokeObjectURL(playbackUrl)
      : () => {};

    if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: false });
      hls.attachMedia(video);
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(playbackUrl));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        status.textContent = 'HLS ready';
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        status.textContent = `Player error: ${data.details}`;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          hls.destroy();
        }
      });

      return () => {
        hls.destroy();
        revokePlaybackUrl();
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const handleMediaError = () => {
        status.textContent = `Media error: ${video.error?.message || 'unsupported video format'}`;
      };
      video.addEventListener('error', handleMediaError);
      video.src = playbackUrl;
      video.play().catch(() => {});
      status.textContent = 'HLS ready';
      return () => {
        video.removeEventListener('error', handleMediaError);
        revokePlaybackUrl();
      };
    }

    revokePlaybackUrl();
    status.textContent = 'HLS playback is not supported in this browser';
    return () => {};
  }

  async function createPlaybackUrl(playlistUrl) {
    if (!playlistUrl.startsWith('data:')) return playlistUrl;
    const playlistText = await readPlaylist(playlistUrl);
    return URL.createObjectURL(new Blob([playlistText], {
      type: 'application/vnd.apple.mpegurl',
    }));
  }

  async function downloadVideo(playlistUrl, button, status) {
    button.disabled = true;
    button.style.cursor = 'wait';

    try {
      status.textContent = 'Reading playlist...';
      const playlistText = await readPlaylist(playlistUrl);
      const playlist = parsePlaylist(playlistText, playlistUrl);
      if (!playlist.segments.length) throw new Error('The playlist has no media segments');

      let cryptoKey = null;
      if (playlist.keyUrl) {
        status.textContent = 'Loading encryption key...';
        const keyBytes = new Uint8Array(await fetchBuffer(playlist.keyUrl));
        if (keyBytes.byteLength !== 16) throw new Error(`Invalid AES key length: ${keyBytes.byteLength} bytes`);
        cryptoKey = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
      }

      const segments = new Array(playlist.segments.length);
      let nextIndex = 0;
      let completed = 0;
      const workerCount = Math.min(3, playlist.segments.length);

      async function worker() {
        while (nextIndex < playlist.segments.length) {
          const index = nextIndex++;
          const encrypted = await fetchBufferWithRetry(playlist.segments[index], 4);
          if (cryptoKey) {
            const iv = new Uint8Array(playlist.iv || sequenceIv(playlist.mediaSequence + index));
            if (iv.byteLength !== 16) throw new Error(`Invalid IV length at segment ${index + 1}`);
            if (encrypted.byteLength % 16 !== 0) throw new Error(`Encrypted segment ${index + 1} is not AES block-aligned`);
            try {
              segments[index] = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, encrypted);
            } catch (error) {
              throw new Error(`Could not decrypt segment ${index + 1}: ${error.message}`);
            }
          } else {
            segments[index] = encrypted;
          }
          completed++;
          status.textContent = `Downloading ${completed}/${playlist.segments.length}`;
        }
      }

      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      status.textContent = 'Merging video...';
      const blob = new Blob(segments, { type: 'video/mp2t' });
      triggerDownload(blob, makeFilename());
      status.textContent = `Download started (${formatBytes(blob.size)})`;
    } catch (error) {
      console.error('[QMH HLS] Download failed:', error);
      status.textContent = `Download failed: ${error.message}`;
    } finally {
      button.disabled = false;
      button.style.cursor = 'pointer';
    }
  }

  async function readPlaylist(url) {
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',');
      if (comma < 0) throw new Error('Invalid data playlist URL');
      const metadata = url.slice(0, comma);
      const content = url.slice(comma + 1);
      return metadata.includes(';base64') ? atob(content) : decodeURIComponent(content);
    }
    return requestWithFetch(url, 'text');
  }

  function parsePlaylist(text, playlistUrl) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const segments = [];
    let keyUrl = null;
    let iv = null;
    let mediaSequence = 0;

    for (const line of lines) {
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
      } else if (!line.startsWith('#')) {
        segments.push(resolveUrl(playlistUrl, line));
      }
    }

    return { segments, keyUrl, iv, mediaSequence };
  }

  // ── @grant none: dùng native fetch thẳng, không cần GM API ───────────────
  async function fetchBuffer(url) {
    return requestWithFetch(url, 'arraybuffer').then((v) => normalizeArrayBuffer(v, url));
  }

  async function requestWithFetch(url, responseType) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    try {
      const response = await fetch(url, {
        credentials: 'omit',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
      return responseType === 'text' ? response.text() : response.arrayBuffer();
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`Request timed out: ${url}`);
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  function normalizeArrayBuffer(value, url) {
    if (value instanceof ArrayBuffer) return value.slice(0);
    if (ArrayBuffer.isView(value)) {
      return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
    }
    throw new Error(`Invalid binary response from ${new URL(url).hostname}`);
  }

  async function fetchBufferWithRetry(url, maxAttempts) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fetchBuffer(url);
      } catch (error) {
        lastError = error;
        if (attempt < maxAttempts) await delay(500 * (2 ** (attempt - 1)));
      }
    }
    throw lastError;
  }

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
    for (let index = 0; index < bytes.length; index++) {
      bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return bytes;
  }

  function triggerDownload(blob, filename) {
    const blobUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = blobUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
  }

  function makeFilename() {
    const title = document.querySelector('h1')?.textContent?.trim() || document.title || 'qmh-video';
    return `${title.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim()}.ts`;
  }

  function formatBytes(bytes) {
    const units = ['B', 'KB', 'MB', 'GB'];
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
      value /= 1024;
      unitIndex++;
    }
    return `${value.toFixed(unitIndex ? 1 : 0)} ${units[unitIndex]}`;
  }

  function delay(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
})();
