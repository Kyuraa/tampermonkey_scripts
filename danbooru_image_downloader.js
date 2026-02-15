// ==UserScript==
// @name         Danbooru Direct Download (Queue)
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Async queue download for Danbooru - click posts to download images/videos in background
// @author       Kyuraa
// @match        https://*.donmai.us/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      danbooru.donmai.us
// @connect      cdn.donmai.us
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ========== CONFIGURATION ==========
    const MAX_CONCURRENT = 2;  // How many downloads at once (Danbooru is stricter)
    const STORAGE_KEY = 'danbooru_download_queue';
    // ===================================

    // Queue state
    const queue = [];
    let activeDownloads = 0;
    let totalQueued = 0;
    let totalCompleted = 0;

    // Create status UI
    const statusDiv = document.createElement('div');
    statusDiv.id = 'zc-download-status';
    statusDiv.innerHTML = `
        <div class="zc-dl-header">
            <span>Downloads</span>
            <span class="zc-dl-counts">0/0</span>
            <button class="zc-dl-minimize" title="Minimize">−</button>
            <button class="zc-dl-close" title="Close (only when idle)">×</button>
        </div>
        <div class="zc-dl-list"></div>
    `;
    statusDiv.style.cssText = `
        position: fixed;
        bottom: 20px;
        right: 20px;
        width: 300px;
        max-height: 400px;
        background: #1a1a2e;
        border: 1px solid #4a4a6a;
        border-radius: 8px;
        font-family: Arial, sans-serif;
        font-size: 12px;
        z-index: 999999;
        display: none;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        overflow: hidden;
    `;

    const style = document.createElement('style');
    style.textContent = `
        #zc-download-status .zc-dl-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 10px 12px;
            background: #2a2a4e;
            color: #fff;
            font-weight: bold;
        }
        #zc-download-status .zc-dl-counts {
            background: #4a4a6a;
            padding: 2px 8px;
            border-radius: 10px;
            font-size: 11px;
        }
        #zc-download-status .zc-dl-minimize,
        #zc-download-status .zc-dl-close {
            background: none;
            border: none;
            color: #888;
            font-size: 18px;
            cursor: pointer;
            padding: 0 4px;
            margin-left: 4px;
        }
        #zc-download-status .zc-dl-minimize:hover,
        #zc-download-status .zc-dl-close:hover {
            color: #fff;
        }
        #zc-download-status.collapsed .zc-dl-list {
            display: none;
        }
        #zc-download-status.collapsed {
            max-height: auto;
        }
        #zc-download-status .zc-dl-list {
            max-height: 300px;
            overflow-y: auto;
        }
        #zc-download-status .zc-dl-item {
            display: flex;
            align-items: center;
            padding: 8px 12px;
            border-bottom: 1px solid #2a2a4e;
            color: #ccc;
        }
        #zc-download-status .zc-dl-item:last-child {
            border-bottom: none;
        }
        #zc-download-status .zc-dl-icon {
            margin-right: 10px;
            font-size: 14px;
        }
        #zc-download-status .zc-dl-type {
            margin-right: 5px;
            font-size: 14px;
        }
        #zc-download-status .zc-dl-name {
            flex: 1;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }
        #zc-download-status .zc-dl-item.pending .zc-dl-icon::after { content: '⏳'; }
        #zc-download-status .zc-dl-item.downloading .zc-dl-icon::after { content: '⬇️'; }
        #zc-download-status .zc-dl-item.done .zc-dl-icon::after { content: '✅'; }
        #zc-download-status .zc-dl-item.error .zc-dl-icon::after { content: '❌'; }
        #zc-download-status .zc-dl-item.downloading {
            color: #6cf;
        }
        #zc-download-status .zc-dl-item.done {
            color: #6c6;
        }
        #zc-download-status .zc-dl-item.error {
            color: #f66;
        }

        /* Click feedback on thumbnails */
        .zc-queued {
            position: relative;
        }
        .zc-queued::after {
            content: '✓ Queued';
            position: absolute;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: rgba(0, 200, 0, 0.8);
            color: white;
            padding: 5px 10px;
            border-radius: 4px;
            font-size: 14px;
            font-weight: bold;
            pointer-events: none;
            animation: zc-fade 1s forwards;
        }
        @keyframes zc-fade {
            0% { opacity: 1; }
            70% { opacity: 1; }
            100% { opacity: 0; }
        }
    `;
    document.head.appendChild(style);
    document.body.appendChild(statusDiv);

    // ========== LOCALSTORAGE PERSISTENCE ==========

    function saveState() {
        const state = {
            queue: queue.map(task => ({ ...task })),
            totalQueued,
            totalCompleted
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    }

    function loadState() {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (!saved) return;

        try {
            const state = JSON.parse(saved);
            queue.push(...state.queue);
            totalQueued = state.totalQueued;
            totalCompleted = state.totalCompleted;

            updateCounts();
            if (queue.length > 0) {
                showStatus();
                rebuildStatusUI();
                processQueue();
            }
        } catch (err) {
            console.error('Failed to load state:', err);
            clearState();
        }
    }

    function clearState() {
        localStorage.removeItem(STORAGE_KEY);
    }

    function rebuildStatusUI() {
        const list = statusDiv.querySelector('.zc-dl-list');
        list.innerHTML = '';

        queue.forEach(task => {
            addToStatusList(task.id, task.filename, task.type);
        });
    }

    // ========== UTILITY FUNCTIONS ==========

    function getMediaType(url) {
        const ext = url.split('.').pop().toLowerCase().split('?')[0];
        return ['mp4', 'webm', 'mov'].includes(ext) ? 'video' : 'image';
    }

    // ========== DANBOORU API ==========

    async function fetchPostFileUrl(postId) {
        try {
            const response = await fetch(`https://kagamihara.donmai.us/posts/${postId}.json`);
            const data = await response.json();
            return data.file_url;
        } catch (err) {
            console.error('Failed to fetch post data:', err);
            return null;
        }
    }

    // ========== UI FUNCTIONS ==========

    // Minimize button handler
    statusDiv.querySelector('.zc-dl-minimize').addEventListener('click', () => {
        const isCollapsed = statusDiv.classList.toggle('collapsed');
        const btn = statusDiv.querySelector('.zc-dl-minimize');
        btn.textContent = isCollapsed ? '+' : '−';
        btn.title = isCollapsed ? 'Expand' : 'Minimize';
        // Save collapsed state
        localStorage.setItem('danbooru_download_collapsed', isCollapsed);
    });

    // Close button handler
    statusDiv.querySelector('.zc-dl-close').addEventListener('click', () => {
        if (activeDownloads === 0) {
            statusDiv.style.display = 'none';
            statusDiv.querySelector('.zc-dl-list').innerHTML = '';
            queue.length = 0;
            totalQueued = 0;
            totalCompleted = 0;
            updateCounts();
            clearState();
        }
    });

    function updateCounts() {
        statusDiv.querySelector('.zc-dl-counts').textContent = `${totalCompleted}/${totalQueued}`;
    }

    function showStatus() {
        statusDiv.style.display = 'block';
        // Restore collapsed state
        const wasCollapsed = localStorage.getItem('danbooru_download_collapsed') === 'true';
        if (wasCollapsed) {
            statusDiv.classList.add('collapsed');
            statusDiv.querySelector('.zc-dl-minimize').textContent = '+';
            statusDiv.querySelector('.zc-dl-minimize').title = 'Expand';
        }
    }

    function addToStatusList(id, filename, type) {
        const existing = document.getElementById(`zc-dl-${id}`);
        if (existing) return;

        const list = statusDiv.querySelector('.zc-dl-list');
        const item = document.createElement('div');
        item.className = 'zc-dl-item pending';
        item.id = `zc-dl-${id}`;
        item.innerHTML = `
            <span class="zc-dl-icon"></span>
            <span class="zc-dl-type">${type === 'video' ? '🎥' : '🖼️'}</span>
            <span class="zc-dl-name" title="${filename}">${filename}</span>
        `;
        list.insertBefore(item, list.firstChild);
    }

    function updateStatus(id, status) {
        const item = document.getElementById(`zc-dl-${id}`);
        if (item) {
            item.className = `zc-dl-item ${status}`;
        }
    }

    // Extract filename from URL
    function getFilename(url) {
        return url.split('/').pop().split('?')[0];
    }

    // ========== DOWNLOAD QUEUE ==========

    // Process queue
    function processQueue() {
        while (activeDownloads < MAX_CONCURRENT && queue.length > 0) {
            const task = queue.shift();
            activeDownloads++;
            downloadImage(task);
            saveState();
        }
    }

    // Add to queue
    function queueDownload(url, type) {
        const id = Date.now() + Math.random().toString(36).substr(2, 9);
        const filename = getFilename(url);

        totalQueued++;
        updateCounts();
        showStatus();
        addToStatusList(id, filename, type);

        queue.push({ id, url, filename, type });
        saveState();
        processQueue();

        return id;
    }

    // Download function
    function downloadImage(task) {
        const { id, url, filename } = task;

        updateStatus(id, 'downloading');

        if (typeof GM_download !== 'undefined') {
            GM_download({
                url: url,
                name: filename,
                onload: function() {
                    onDownloadComplete(id, true);
                },
                onerror: function(err) {
                    console.error('GM_download failed:', err);
                    // Try fallback
                    fallbackDownload(id, url, filename);
                }
            });
        } else {
            fallbackDownload(id, url, filename);
        }
    }

    // Fallback download
    function fallbackDownload(id, url, filename) {
        GM_xmlhttpRequest({
            method: 'GET',
            url: url,
            responseType: 'blob',
            onload: function(response) {
                const blob = response.response;
                const blobUrl = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = blobUrl;
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(blobUrl);
                onDownloadComplete(id, true);
            },
            onerror: function(err) {
                console.error('Fallback download failed:', err);
                onDownloadComplete(id, false);
            }
        });
    }

    function onDownloadComplete(id, success) {
        activeDownloads--;
        totalCompleted++;
        updateCounts();
        updateStatus(id, success ? 'done' : 'error');

        // Remove completed item from queue (for persistence)
        const index = queue.findIndex(task => task.id === id);
        if (index !== -1) {
            queue.splice(index, 1);
        }

        saveState();
        processQueue();
    }

    // ========== DANBOORU CLICK HANDLERS ==========

    // Add download buttons to gallery thumbnails
    function attachDownloadHandlers() {
        // Target post articles in gallery view
        const posts = document.querySelectorAll('article[data-id]');

        posts.forEach(post => {
            if (post.dataset.downloadButtonAdded) return;
            post.dataset.downloadButtonAdded = 'true';

            const postId = post.dataset.id;
            if (!postId) return;

            // Create download button
            const downloadBtn = document.createElement('a');
            downloadBtn.className = 'db-download-btn';
            downloadBtn.textContent = 'Download';
            downloadBtn.href = 'javascript:void(0)';
            downloadBtn.style.cssText = `
                display: block;
                text-align: center;
                padding: 4px 8px;
                margin-top: 4px;
                background: #2a2a4e;
                color: #fff;
                border-radius: 4px;
                font-size: 11px;
                cursor: pointer;
                text-decoration: none;
            `;

            // Add hover effect
            downloadBtn.addEventListener('mouseenter', function() {
                this.style.background = '#3a3a5e';
            });
            downloadBtn.addEventListener('mouseleave', function() {
                this.style.background = '#2a2a4e';
            });

            // Add click handler
            downloadBtn.addEventListener('click', async function(e) {
                e.preventDefault();
                e.stopPropagation();

                // Visual feedback
                const originalText = this.textContent;
                const originalBg = this.style.background;
                this.textContent = '⏳ Fetching...';
                this.style.background = '#555';

                // Fetch file URL from API
                const fileUrl = await fetchPostFileUrl(postId);
                if (!fileUrl) {
                    this.textContent = '❌ Error';
                    this.style.background = '#f66';
                    setTimeout(() => {
                        this.textContent = originalText;
                        this.style.background = originalBg;
                    }, 2000);
                    return;
                }

                // Queue the download
                const type = getMediaType(fileUrl);
                queueDownload(fileUrl, type);

                // Show success feedback
                this.textContent = '✓ Queued';
                this.style.background = '#0c0';
                setTimeout(() => {
                    this.textContent = originalText;
                    this.style.background = originalBg;
                }, 1000);
            });

            // Insert button into post
            post.appendChild(downloadBtn);
        });
    }

    // ========== INITIALIZATION ==========

    // Load saved state from localStorage
    loadState();

    // Initial attachment
    attachDownloadHandlers();

    // Watch for dynamic content
    const observer = new MutationObserver(attachDownloadHandlers);
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('Danbooru Direct Download (Queue) v1.0 loaded - Max concurrent:', MAX_CONCURRENT);
})();
