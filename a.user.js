// ==UserScript==
// @name         YFantasy Clean Player (Enforced UI)
// @namespace    https://yfantasy.me/
// @version      4.0
// @description  Bắt buộc hiển thị trình phát video sạch, xóa bỏ vĩnh viễn UI gốc và ngăn chặn Next.js hydrate
// @match        https://yfantasy.me/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const nativeFetch = window.fetch.bind(window);

    /* ========================================================
     * 1. DỌN SẠCH ĐỊNH DANH (COOKIE & STORAGE) LIÊN TỤC
     * ======================================================== */
    function wipeIdentity() {
        try { localStorage.clear(); } catch (e) {}
        try { sessionStorage.clear(); } catch (e) {}
        try {
            const cookies = document.cookie.split(";");
            const domain = window.location.hostname;
            for (let c of cookies) {
                const name = c.split("=")[0].trim();
                if (name) {
                    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=${domain}`;
                    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;domain=.${domain}`;
                    document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
                }
            }
        } catch (e) {}
    }
    wipeIdentity();
    setInterval(wipeIdentity, 500);

    /* ========================================================
     * 2. CSS LOCK: ẨN VĨNH VIỄN TẤT CẢ ELEMENT CỦA WEB GỐC
     * ======================================================== */
    const lockStyle = document.createElement('style');
    lockStyle.id = 'yfantasy-lock-style';
    lockStyle.textContent = `
        /* Ẩn tất cả thẻ con trực tiếp của body TRỪ container của app ta */
        body > *:not(#clean-player-root) {
            display: none !important;
            visibility: hidden !important;
            opacity: 0 !important;
            pointer-events: none !important;
            height: 0 !important;
            width: 0 !important;
            overflow: hidden !important;
        }

        :root {
            --bg: #0b0f19;
            --card: #151d30;
            --hover: #1f2b48;
            --accent: #38bdf8;
            --accent-hover: #0ea5e9;
            --text: #f8fafc;
            --text-sub: #94a3b8;
            --green: #22c55e;
            --green-hover: #16a34a;
        }

        body {
            background-color: var(--bg) !important;
            margin: 0 !important;
            padding: 0 !important;
            color: var(--text) !important;
            font-family: system-ui, -apple-system, sans-serif !important;
            overflow-x: hidden !important;
        }

        #clean-player-root {
            position: relative;
            z-index: 999999999 !important;
            min-height: 100vh;
            display: flex;
            flex-direction: column;
            background: var(--bg);
        }

        #clean-player-root * {
            box-sizing: border-box;
            font-family: inherit;
        }

        .header-bar {
            display: flex; justify-content: space-between; align-items: center;
            padding: 14px 24px; background: var(--card); border-bottom: 1px solid #23304e;
        }
        .main-title { font-size: 1.25rem; font-weight: bold; color: var(--accent); }
        .btn {
            background: var(--accent); color: #0b0f19; font-weight: 600; padding: 8px 16px;
            border-radius: 6px; border: none; cursor: pointer; text-decoration: none;
            display: inline-flex; align-items: center; gap: 6px; font-size: 14px; transition: 0.2s;
        }
        .btn:hover { background: var(--accent-hover); }
        .btn-green { background: var(--green); color: #fff; }
        .btn-green:hover { background: var(--green-hover); }
        .btn:disabled { opacity: 0.5; cursor: not-allowed; }

        .player-grid {
            display: grid; grid-template-columns: 1fr 380px; gap: 20px;
            max-width: 1400px; width: 100%; margin: 0 auto; padding: 20px; flex: 1;
        }
        @media(max-width: 1024px) { .player-grid { grid-template-columns: 1fr; } }

        .video-box {
            background: #000; border-radius: 8px; overflow: hidden;
            aspect-ratio: 16 / 9; max-height: 560px; display: flex; align-items: center; justify-content: center;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
        }
        .video-box video { width: 100%; height: 100%; object-fit: contain; }

        .details-box {
            background: var(--card); padding: 16px; border-radius: 8px;
            display: flex; flex-direction: column; gap: 12px; margin-top: 15px;
        }
        .details-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px; }
        .episodes-bar { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 6px; }
        .ep-btn {
            background: #23304e; color: #fff; border: 1px solid #33446b;
            padding: 6px 12px; border-radius: 4px; cursor: pointer; font-size: 13px; font-weight: 500;
        }
        .ep-btn.active { background: var(--accent); color: #0b0f19; font-weight: bold; border-color: var(--accent); }

        .playlist-box {
            background: var(--card); border-radius: 8px; padding: 14px;
            height: calc(100vh - 100px); overflow-y: auto; display: flex; flex-direction: column; gap: 10px;
        }
        .video-card {
            display: flex; gap: 10px; padding: 8px; background: #0f1626;
            border-radius: 6px; cursor: pointer; border: 1px solid transparent; transition: 0.2s;
        }
        .video-card:hover { background: var(--hover); }
        .video-card.active { border-color: var(--accent); background: #1a2744; }
        .video-card img { width: 65px; height: 90px; object-fit: cover; border-radius: 4px; flex-shrink: 0; }
        .card-meta { display: flex; flex-direction: column; justify-content: space-between; overflow: hidden; }
        .card-title { font-size: 14px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .card-tags { font-size: 12px; color: var(--text-sub); }
        .badge {
            display: inline-block; background: #3b82f6; color: #fff; font-size: 10px;
            padding: 2px 6px; border-radius: 4px; margin-top: 4px; align-self: flex-start;
        }
    `;

    function injectCSSLock() {
        if (!document.getElementById('yfantasy-lock-style')) {
            (document.head || document.documentElement).appendChild(lockStyle);
        }
    }
    injectCSSLock();

    // Giữ Referrer hợp lệ để CDN không chặn
    let metaRef = document.querySelector('meta[name="referrer"]');
    if (!metaRef) {
        metaRef = document.createElement('meta');
        metaRef.name = "referrer";
        metaRef.content = "strict-origin-when-cross-origin";
        (document.head || document.documentElement).appendChild(metaRef);
    }

    /* ========================================================
     * 3. KHỞI TẠO VÀ BẢO VỆ GIAO DIỆN (DOM GUARD)
     * ======================================================== */
    let isInitialized = false;

    function buildUI() {
        if (document.getElementById('clean-player-root')) return;

        const appRoot = document.createElement('div');
        appRoot.id = 'clean-player-root';
        appRoot.innerHTML = `
            <header class="header-bar">
                <div class="main-title">🎬 YFantasy Clean Player</div>
                <button id="btn-fetch-feed" class="btn">🔄 Lấy Video Mới</button>
            </header>
            <div class="player-grid">
                <div>
                    <div class="video-box">
                        <video id="v-player" controls autoplay playsinline></video>
                    </div>
                    <div class="details-box">
                        <div class="details-head">
                            <div>
                                <h2 id="v-title" style="font-size: 1.3rem;">Đang tải dữ liệu...</h2>
                                <div id="v-meta" style="color: var(--text-sub); font-size: 13px; margin-top: 4px;">--</div>
                            </div>
                            <div style="display: flex; gap: 8px;">
                                <button id="btn-unlock" class="btn btn-green">🔓 Mở khóa tập mới</button>
                                <button id="btn-download" class="btn">⬇ Tải MP4</button>
                            </div>
                        </div>
                        <div>
                            <div style="font-size: 13px; font-weight: 600; margin-bottom: 4px;">Danh sách tập:</div>
                            <div id="v-episodes" class="episodes-bar"></div>
                        </div>
                    </div>
                </div>
                <div class="playlist-box">
                    <div style="font-weight: bold; font-size: 15px; border-bottom: 1px solid #23304e; padding-bottom: 6px;">
                        Danh sách Phim (<span id="count">0</span>)
                    </div>
                    <div id="v-list" style="display: flex; flex-direction: column; gap: 8px;"></div>
                </div>
            </div>
        `;

        if (document.body) {
            document.body.prepend(appRoot);
        } else {
            document.documentElement.appendChild(appRoot);
        }

        if (!isInitialized) {
            isInitialized = true;
            setupLogic();
        }
    }

    // Dùng MutationObserver để kiểm tra nếu UI bị Next.js tháo gỡ thì lập tức gắn lại
    const domObserver = new MutationObserver(() => {
        injectCSSLock();
        if (!document.getElementById('clean-player-root')) {
            buildUI();
        }
    });

    domObserver.observe(document.documentElement, { childList: true, subtree: true });

    document.addEventListener('DOMContentLoaded', () => {
        injectCSSLock();
        buildUI();
    });

    /* ========================================================
     * 4. LOGIC PHÁT VIDEO, UNLOCK & TẢI MP4
     * ======================================================== */
    function setupLogic() {
        let videoData = [];
        let activeVideo = null;
        let activeSegmentIdx = 0;

        const player = document.getElementById('v-player');
        const vTitle = document.getElementById('v-title');
        const vMeta = document.getElementById('v-meta');
        const vEpisodes = document.getElementById('v-episodes');
        const vList = document.getElementById('v-list');
        const vCount = document.getElementById('count');
        const btnDownload = document.getElementById('btn-download');
        const btnUnlock = document.getElementById('btn-unlock');
        const btnFetchFeed = document.getElementById('btn-fetch-feed');

        async function fetchFeed() {
            wipeIdentity();
            btnFetchFeed.disabled = true;
            btnFetchFeed.textContent = "Đang tải...";

            const url = "https://yfantasy.me/api/videos/feed?limit=12&language=en&shuffleTop=1&firstVisitBucket=0&firstVisitStrategyVersion=fv3-jxdx18&videoId=99999999999";
            try {
                const res = await nativeFetch(url, { cache: "no-store" });
                const data = await res.json();
                if (data.items && data.items.length > 0) {
                    videoData = data.items.map(item => ({
                        id: item.id,
                        title: item.title,
                        tags: item.tags || [],
                        thumb: item.publicSegment ? item.publicSegment.imageUrl : '',
                        segments: item.publicSegment ? [
                            {
                                name: "Tập 1 (Gốc)",
                                url: item.publicSegment.fallbackUrl,
                                duration: Math.floor((item.publicSegment.durationMs || 0) / 1000) + 's'
                            }
                        ] : []
                    }));
                    renderPlaylist();
                    if (videoData.length > 0) selectVideo(videoData[0], 0);
                }
            } catch (err) {
                alert("Lỗi tải feed: " + err.message);
            } finally {
                btnFetchFeed.disabled = false;
                btnFetchFeed.textContent = "🔄 Lấy Video Mới";
            }
        }

        function renderPlaylist() {
            vList.innerHTML = '';
            vCount.textContent = videoData.length;

            videoData.forEach((v, index) => {
                const card = document.createElement('div');
                card.className = `video-card ${activeVideo && activeVideo.id === v.id ? 'active' : ''}`;
                card.innerHTML = `
                    <img src="${v.thumb}" loading="lazy" />
                    <div class="card-meta">
                        <div class="card-title">${v.title}</div>
                        <div class="card-tags">${v.tags.join(', ')}</div>
                        <span class="badge">${v.segments.length} Tập</span>
                    </div>
                `;
                card.onclick = () => selectVideo(v, index);
                vList.appendChild(card);
            });
        }

        function selectVideo(v, cardIndex) {
            activeVideo = v;
            activeSegmentIdx = 0;

            document.querySelectorAll('.video-card').forEach((c, idx) => {
                c.classList.toggle('active', idx === cardIndex);
            });

            vTitle.textContent = v.title;
            vMeta.textContent = `ID: ${v.id} • Thể loại: ${v.tags.join(', ')}`;
            renderEpisodes();
            if (v.segments.length > 0) playSegment(0);
        }

        function renderEpisodes() {
            vEpisodes.innerHTML = '';
            activeVideo.segments.forEach((seg, idx) => {
                const btn = document.createElement('button');
                btn.className = `ep-btn ${idx === activeSegmentIdx ? 'active' : ''}`;
                btn.textContent = `${seg.name} [${seg.duration}]`;
                btn.onclick = () => playSegment(idx);
                vEpisodes.appendChild(btn);
            });
        }

        function playSegment(idx) {
            activeSegmentIdx = idx;
            const seg = activeVideo.segments[idx];
            player.src = seg.url;
            player.play().catch(() => {});

            document.querySelectorAll('.ep-btn').forEach((b, i) => {
                b.classList.toggle('active', i === idx);
            });
        }

        btnDownload.onclick = async () => {
            if (!activeVideo || !activeVideo.segments[activeSegmentIdx]) return;
            const seg = activeVideo.segments[activeSegmentIdx];
            const prevText = btnDownload.textContent;
            btnDownload.textContent = "⏳ Đang tải...";
            btnDownload.disabled = true;

            try {
                const res = await nativeFetch(seg.url);
                const blob = await res.blob();
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = `${activeVideo.title}_${seg.name}.mp4`.replace(/[/\\?%*:|"<>]/g, '-');
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);
            } catch (e) {
                alert("Lỗi tải video: " + e.message);
            } finally {
                btnDownload.textContent = prevText;
                btnDownload.disabled = false;
            }
        };

        btnUnlock.onclick = async () => {
            if (!activeVideo) return;
            wipeIdentity();
            btnUnlock.disabled = true;
            btnUnlock.textContent = "Đang mở khóa...";

            try {
                const res = await nativeFetch(`https://yfantasy.me/api/videos/${activeVideo.id}/guest-first-unlock`, {
                    method: 'POST',
                    headers: { 'accept': '*/*' }
                });

                const data = await res.json();
                if (data.outcome === "unlock" && data.segment) {
                    const newSeg = {
                        name: `Tập ${data.segment.segmentIndex + 1} (Đã mở)`,
                        url: data.segment.fallbackUrl,
                        duration: Math.floor((data.segment.durationMs || 0) / 1000) + 's'
                    };

                    const exists = activeVideo.segments.some(s => s.url === newSeg.url);
                    if (!exists) {
                        activeVideo.segments.push(newSeg);
                        renderEpisodes();
                        renderPlaylist();
                        playSegment(activeVideo.segments.length - 1);
                    } else {
                        alert("Tập này đã có trong danh sách!");
                    }
                } else {
                    alert("Không thể mở thêm tập ẩn cho phim này!");
                }
            } catch (err) {
                alert("Lỗi khi gọi unlock: " + err.message);
            } finally {
                btnUnlock.disabled = false;
                btnUnlock.textContent = "🔓 Mở khóa tập mới";
            }
        };

        btnFetchFeed.onclick = fetchFeed;
        fetchFeed();
    }
})();
