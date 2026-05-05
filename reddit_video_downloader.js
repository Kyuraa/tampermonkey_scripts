// ==UserScript==
// @name         Reddit Video Downloader
// @namespace    http://tampermonkey.net/
// @version      1.2.0
// @description  Download Reddit videos at highest quality (video + audio combined, no FFmpeg)
// @author       Kyuraa
// @match        https://www.reddit.com/*
// @match        https://old.reddit.com/*
// @grant        GM_xmlhttpRequest
// @connect      v.redd.it
// @connect      www.reddit.com
// @connect      reddit.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    // ========== NETWORK ==========
    function gmGet(url, type = 'text') {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                responseType: type,
                onload: r => {
                    if (r.status >= 400) reject(new Error(`HTTP ${r.status}: ${url}`));
                    else resolve(type === 'arraybuffer' ? r.response : r.responseText);
                },
                onerror: () => reject(new Error(`Network error: ${url}`)),
            });
        });
    }

    // ========== FRAGMENTED MP4 COMBINER ==========
    // Reddit CMAF files are fMP4: ftyp + moov + [moof+mdat]...
    // Video and audio files each have track_ID=1.
    // We rewrite the audio track to track_ID=2, merge the moov boxes,
    // then concatenate all fragments. No re-encode, pure box-level surgery.

    function combineFragmentedMP4(videoAB, audioAB) {
        // --- primitives ---
        const R = (b, i) => (b[i] << 24 | b[i+1] << 16 | b[i+2] << 8 | b[i+3]) >>> 0;
        const W = (b, i, v) => { b[i]=v>>>24; b[i+1]=(v>>>16)&0xff; b[i+2]=(v>>>8)&0xff; b[i+3]=v&0xff; };
        const TY = (b, i) => String.fromCharCode(b[i+4], b[i+5], b[i+6], b[i+7]);

        // Scan direct children of a container region [from, to)
        function scan(b, from, to) {
            const out = [];
            let i = from;
            while (i + 8 <= to) {
                const size = R(b, i);
                if (size < 8) break;
                out.push({ type: TY(b, i), s: i, e: i + size });
                i += size;
            }
            return out;
        }

        // First child of given type within a container box starting at cs
        function child(b, cs, ce, type) {
            return scan(b, cs + 8, ce).find(x => x.type === type) ?? null;
        }

        // Insert bytes into Uint8Array at absolute position
        function insertAt(arr, pos, bytes) {
            const out = new Uint8Array(arr.length + bytes.length);
            out.set(arr.subarray(0, pos));
            out.set(bytes, pos);
            out.set(arr.subarray(pos), pos + bytes.length);
            return out;
        }

        // --- parse ---
        const vBuf = new Uint8Array(videoAB);
        const aBuf = new Uint8Array(audioAB.slice(0)); // mutable copy

        const vTop = scan(vBuf, 0, vBuf.length);
        const aTop = scan(aBuf, 0, aBuf.length);

        const vMoov = vTop.find(b => b.type === 'moov');
        const aMoov = aTop.find(b => b.type === 'moov');
        const vFtyp = vTop.find(b => b.type === 'ftyp');

        if (!vMoov || !aMoov) throw new Error('Missing moov box in one of the MP4 files.');

        // --- patch audio track ID: 1 → 2 in moov ---
        const aTrak = child(aBuf, aMoov.s, aMoov.e, 'trak');
        if (aTrak) {
            const aTkhd = child(aBuf, aTrak.s, aTrak.e, 'tkhd');
            if (aTkhd) {
                const ver = aBuf[aTkhd.s + 8];
                // track_ID offset: version=0 → 20, version=1 → 28
                W(aBuf, aTkhd.s + (ver === 1 ? 28 : 20), 2);
            }
        }

        const aMvex = child(aBuf, aMoov.s, aMoov.e, 'mvex');
        let aTrex = null;
        if (aMvex) {
            aTrex = child(aBuf, aMvex.s, aMvex.e, 'trex');
            if (aTrex) W(aBuf, aTrex.s + 12, 2); // track_ID at offset 12
        }

        // --- patch audio moof fragments: tfhd track_ID 1 → 2, renumber mfhd ---
        const vMoofs = vTop.filter(b => b.type === 'moof');
        const aMoofs = aTop.filter(b => b.type === 'moof');

        aMoofs.forEach((mb, idx) => {
            const traf = child(aBuf, mb.s, mb.e, 'traf');
            if (traf) {
                const tfhd = child(aBuf, traf.s, traf.e, 'tfhd');
                if (tfhd) W(aBuf, tfhd.s + 12, 2); // track_ID at offset 12
            }
            const mfhd = child(aBuf, mb.s, mb.e, 'mfhd');
            if (mfhd) W(aBuf, mfhd.s + 12, vMoofs.length + idx + 1); // sequence_number
        });

        // --- build combined moov ---
        // Start with a copy of the video moov, then splice in audio trak + trex
        let moov = vBuf.slice(vMoov.s, vMoov.e);

        // 1. Insert audio trak after the last video trak
        {
            const traks = scan(moov, 8, moov.length).filter(b => b.type === 'trak');
            const pos = traks.length ? traks[traks.length - 1].e : moov.length;
            moov = insertAt(moov, pos, aBuf.slice(aTrak.s, aTrak.e));
            W(moov, 0, moov.length); // update moov box size
        }

        // 2. Insert audio trex inside mvex (re-scan since positions shifted)
        if (aTrex) {
            const mvex = scan(moov, 8, moov.length).find(b => b.type === 'mvex');
            if (mvex) {
                const trexes = scan(moov, mvex.s + 8, mvex.e).filter(b => b.type === 'trex');
                const pos = trexes.length ? trexes[trexes.length - 1].e : mvex.e;
                const aTrexSlice = aBuf.slice(aTrex.s, aTrex.e);
                moov = insertAt(moov, pos, aTrexSlice);
                W(moov, 0, moov.length); // update moov box size
                W(moov, mvex.s, (mvex.e - mvex.s) + aTrexSlice.length); // update mvex box size
            }
        }

        // --- assemble output ---
        const parts = [];
        if (vFtyp) parts.push(vBuf.slice(vFtyp.s, vFtyp.e));
        parts.push(moov);

        // All video moof+mdat pairs
        for (let i = 0; i + 1 < vTop.length; i++) {
            if (vTop[i].type === 'moof' && vTop[i+1].type === 'mdat') {
                parts.push(vBuf.slice(vTop[i].s, vTop[i].e));
                parts.push(vBuf.slice(vTop[i+1].s, vTop[i+1].e));
            }
        }

        // All audio moof+mdat pairs (patched)
        for (let i = 0; i + 1 < aTop.length; i++) {
            if (aTop[i].type === 'moof' && aTop[i+1].type === 'mdat') {
                parts.push(aBuf.slice(aTop[i].s, aTop[i].e));
                parts.push(aBuf.slice(aTop[i+1].s, aTop[i+1].e));
            }
        }

        const totalSize = parts.reduce((s, p) => s + p.length, 0);
        const out = new Uint8Array(totalSize);
        let offset = 0;
        for (const p of parts) { out.set(p, offset); offset += p.length; }
        return out;
    }

    // ========== DASH PARSING ==========
    function parseDash(xmlText, baseUrl) {
        const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        let bestVideo = null, bestVideoBw = 0;
        let bestAudio = null, bestAudioBw = 0;

        doc.querySelectorAll('AdaptationSet').forEach(set => {
            const ct   = set.getAttribute('contentType') || '';
            const mime = set.getAttribute('mimeType')    || '';
            const isVideo = ct === 'video' || mime.startsWith('video');
            const isAudio = ct === 'audio' || mime.startsWith('audio');

            set.querySelectorAll('Representation').forEach(rep => {
                const bw   = parseInt(rep.getAttribute('bandwidth') || '0', 10);
                const node = rep.querySelector('BaseURL');
                if (!node) return;
                const url = new URL(node.textContent.trim(), baseUrl).href;
                if (isVideo && bw > bestVideoBw) { bestVideoBw = bw; bestVideo = url; }
                if (isAudio && bw > bestAudioBw) { bestAudioBw = bw; bestAudio = url; }
            });
        });

        return { videoUrl: bestVideo, audioUrl: bestAudio };
    }

    // ========== POST DATA ==========
    async function getVideoInfo(postUrl) {
        const clean = postUrl.split('?')[0].split('#')[0].replace(/\/$/, '');
        const json  = JSON.parse(await gmGet(`${clean}.json`));
        const post  = json[0].data.children[0].data;
        const rv    = post.secure_media?.reddit_video || post.media?.reddit_video;
        if (!rv) throw new Error('This post has no Reddit-hosted video.');
        return { dashUrl: rv.dash_url, title: post.title };
    }

    // ========== CORE DOWNLOAD ==========
    async function runDownload(btn, postUrl) {
        const setStatus = t => { btn.textContent = t; };

        try {
            btn.disabled = true;

            setStatus('Fetching manifest…');
            const { dashUrl, title } = await getVideoInfo(postUrl);
            const baseUrl = dashUrl.replace(/[^/]+\.mpd.*$/, '');
            const manifest = await gmGet(dashUrl);
            const { videoUrl, audioUrl } = parseDash(manifest, baseUrl);
            if (!videoUrl) throw new Error('No video stream in manifest.');

            setStatus('Downloading video…');
            const videoAB = await gmGet(videoUrl, 'arraybuffer');

            let outputData;
            if (audioUrl) {
                setStatus('Downloading audio…');
                const audioAB = await gmGet(audioUrl, 'arraybuffer');

                setStatus('Combining…');
                outputData = combineFragmentedMP4(videoAB, audioAB);
            } else {
                outputData = new Uint8Array(videoAB);
            }

            setStatus('Saving…');
            const safeName = title.slice(0, 120).replace(/[\\/:*?"<>|]/g, '_');
            const blob = new Blob([outputData], { type: 'video/mp4' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${safeName}.mp4`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 10000);

            setStatus('Done!');
            setTimeout(() => { btn.textContent = 'Download Video'; btn.disabled = false; }, 3000);
        } catch (err) {
            console.error('[Reddit DL]', err);
            btn.textContent = `Error: ${err.message}`;
            btn.disabled = false;
        }
    }

    // ========== BUTTON FACTORY ==========
    function makeButton(fixed = false) {
        const btn = document.createElement('button');
        btn.textContent = 'Download Video';
        if (fixed) {
            btn.style.cssText = `
                position: fixed; bottom: 20px; right: 20px; z-index: 9999;
                background: #ff4500; color: #fff; border: none; border-radius: 6px;
                padding: 10px 16px; font-size: 14px; font-weight: bold;
                cursor: pointer; box-shadow: 0 2px 10px rgba(0,0,0,0.35);
            `;
        } else {
            btn.style.cssText = `
                background: #ff4500; color: #fff; border: none; border-radius: 4px;
                padding: 3px 10px; font-size: 12px; cursor: pointer; margin-left: 6px;
            `;
        }
        return btn;
    }

    // ========== INJECT ON FEED ==========
    function injectFeedButton(post) {
        if (post.dataset.rdlDone) return;
        post.dataset.rdlDone = '1';
        if (!post.querySelector('shreddit-player, video')) return;

        const linkEl = post.querySelector('a[href*="/comments/"]');
        if (!linkEl) return;

        const postUrl = linkEl.origin + linkEl.pathname;
        const btn = makeButton(false);
        btn.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); runDownload(btn, postUrl); });

        const actions = post.querySelector('[rpl], nav, ul[class*="action"]');
        (actions || post).appendChild(btn);
    }

    // ========== INJECT ON POST PAGE ==========
    function injectPostPageButton() {
        if (!/\/comments\//.test(location.pathname)) return;
        if (document.getElementById('rdl-fixed-btn')) return;
        if (!document.querySelector('shreddit-player, video')) return;

        const btn = makeButton(true);
        btn.id = 'rdl-fixed-btn';
        btn.addEventListener('click', () => runDownload(btn, location.href));
        document.body.appendChild(btn);
    }

    // ========== OBSERVER ==========
    function scan() {
        document.querySelectorAll('article, shreddit-post').forEach(injectFeedButton);
        injectPostPageButton();
    }

    new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
    scan();

})();
