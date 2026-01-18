// ==UserScript==
// @name         Zerochan Direct Download (Queue)
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Async queue download for Zerochan - click multiple images, they download in background
// @author       Kyuraa
// @match        https://www.zerochan.net/*
// @match        https://zerochan.net/*
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      static.zerochan.net
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    // ========== CONFIGURATION ==========
    const MAX_CONCURRENT = 3;  // How many downloads at once
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
            <button class="zc-dl-close">×</button>
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
        #zc-download-status .zc-dl-close {
            background: none;
            border: none;
            color: #888;
            font-size: 18px;
            cursor: pointer;
            padding: 0 4px;
        }
        #zc-download-status .zc-dl-close:hover {
            color: #fff;
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

    // Close button handler
    statusDiv.querySelector('.zc-dl-close').addEventListener('click', () => {
        if (activeDownloads === 0) {
            statusDiv.style.display = 'none';
            // Clear completed items
            statusDiv.querySelector('.zc-dl-list').innerHTML = '';
            totalQueued = 0;
            totalCompleted = 0;
            updateCounts();
        }
    });

    function updateCounts() {
        statusDiv.querySelector('.zc-dl-counts').textContent = `${totalCompleted}/${totalQueued}`;
    }

    function showStatus() {
        statusDiv.style.display = 'block';
    }

    function addToStatusList(id, filename) {
        const list = statusDiv.querySelector('.zc-dl-list');
        const item = document.createElement('div');
        item.className = 'zc-dl-item pending';
        item.id = `zc-dl-${id}`;
        item.innerHTML = `
            <span class="zc-dl-icon"></span>
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
        return url.split('/').pop();
    }

    // Process queue
    function processQueue() {
        while (activeDownloads < MAX_CONCURRENT && queue.length > 0) {
            const task = queue.shift();
            activeDownloads++;
            downloadImage(task);
        }
    }

    // Add to queue
    function queueDownload(url) {
        const id = Date.now() + Math.random().toString(36).substr(2, 9);
        const filename = getFilename(url);
        
        totalQueued++;
        updateCounts();
        showStatus();
        addToStatusList(id, filename);
        
        queue.push({ id, url, filename });
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
        processQueue();
    }

    // Attach click handlers
    function attachDownloadHandlers() {
        const downloadLinks = document.querySelectorAll('a[href*="static.zerochan.net"][href*=".full."]');
        
        downloadLinks.forEach(link => {
            if (link.dataset.directDownload) return;
            link.dataset.directDownload = 'true';
            
            link.addEventListener('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                
                const url = this.href;
                queueDownload(url);
                
                // Visual feedback on the thumbnail
                const container = this.closest('li') || this.closest('div');
                if (container && !container.classList.contains('zc-queued')) {
                    container.classList.add('zc-queued');
                    setTimeout(() => container.classList.remove('zc-queued'), 1000);
                }
            });
        });
    }

    // Initial attachment
    attachDownloadHandlers();

    // Watch for dynamic content
    const observer = new MutationObserver(attachDownloadHandlers);
    observer.observe(document.body, { childList: true, subtree: true });

    console.log('Zerochan Direct Download (Queue) v2.0 loaded - Max concurrent:', MAX_CONCURRENT);
})();