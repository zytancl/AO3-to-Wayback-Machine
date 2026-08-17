// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them.
// @version      2.0
// @author       zytancl
// @downloadURL  https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js
// @updateURL    https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js
// @match        https://archiveofourown.org/*
// @match        https://archiveofourown.com/*
// @match        https://archiveofourown.net/*
// @match        https://archiveofourown.gay/*
// @match        https://ao3.org/*
// @match        https://archive.transformativeworks.org/*
// @match        http://insecure.archiveofourown.org/*
// @connect      web.archive.org
// @connect      archive.org
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @grant        GM_notification
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_cookie
// @run-at       document-idle
// @license      GPL-3.0
// ==/UserScript==

(function () {
    'use strict';
// this file is appended to the header already written

    // Promise.allSettled polyfill
    if (typeof Promise.allSettled !== 'function') {
        Promise.allSettled = function (promises) {
            return Promise.all(promises.map(function (p) {
                return Promise.resolve(p).then(
                    function (value) { return { status: 'fulfilled', value: value }; },
                    function (reason) { return { status: 'rejected', reason: reason }; }
                );
            }));
        };
    }

    var _scriptStartTime = Date.now();

    // ================================================================
    // settings
    // ================================================================

    var SETTINGS_KEY = 'ao3wayback_settings';

    var DEFAULTS = {
        alsoArchivePlainUrl: false,
        dateFormat: 'DD/MM/YYYY',
        noteDivider: 'Last Bookmarked: ',
        maxRetries: 2,
        retryDelayMs: 20000,
        iaAccessKey: '',
        iaSecretKey: '',
    };

    function loadSettings() {
        try {
            var raw = GM_getValue(SETTINGS_KEY, null);
            if (raw) return Object.assign({}, DEFAULTS, JSON.parse(raw));
        } catch (_) {}
        return Object.assign({}, DEFAULTS);
    }

    function saveSettings(s) {
        GM_setValue(SETTINGS_KEY, JSON.stringify(s));
    }

    var settings = loadSettings();


    // ================================================================
    // error log
    // ================================================================

    var _errorLog = [];

    function logError(context, detail) {
        _errorLog.push({
            time: new Date().toISOString(),
            url: window.location.href,
            context: context,
            detail: String(detail),
        });
        console.warn('[AO3\u2192Wayback]', context, detail);
    }

    function fallbackCopyLog(text) {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try {
            document.execCommand('copy');
            showBanner('Log copied to clipboard.', 'info');
        } catch (_) {
            showBanner('Could not copy log -- check the browser console.', 'error');
        }
        document.body.removeChild(ta);
    }

    function exportErrorLog() {
        var text = JSON.stringify({
            script: 'AO3 to Wayback Machine',
            version: '2.0',
            userAgent: navigator.userAgent,
            exportedAt: new Date().toISOString(),
            errors: _errorLog,
        }, null, 2);
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showBanner('Error log copied to clipboard.', 'info');
            }).catch(function () { fallbackCopyLog(text); });
        } else {
            fallbackCopyLog(text);
        }
    }


    // ================================================================
    // persistent archive status
    // ================================================================

    var ARCHIVE_STATUS_KEY = 'ao3wayback_pending';

    function loadPending() {
        try {
            var raw = GM_getValue(ARCHIVE_STATUS_KEY, null);
            if (!raw) return [];
            var items = JSON.parse(raw);
            var cutoff = Date.now() - 900000;
            return items.filter(function (i) { return i.startedAt > cutoff; });
        } catch (_) { return []; }
    }

    function savePending(items) { GM_setValue(ARCHIVE_STATUS_KEY, JSON.stringify(items)); }

    function addPendingItem(item) {
        var items = loadPending();
        items = items.filter(function (i) {
            if (item.type === 'spn2') return i.jobId !== item.jobId;
            return !(i.type === 'tab' && i.url === item.url);
        });
        items.push(item);
        savePending(items);
    }

    function removePendingItem(type, id) {
        var items = loadPending().filter(function (i) {
            if (type === 'spn2') return !(i.type === 'spn2' && i.jobId === id);
            return !(i.type === 'tab' && i.url === id);
        });
        savePending(items);
    }


    // ================================================================
    // result persistence across page navigation
    // ================================================================

    var ARCHIVE_RESULT_KEY = 'ao3wayback_result';
    var _resultShownLiveThisPage = false;

    function notify(type, message) {
        if (typeof GM_notification === 'function') {
            try {
                GM_notification({ title: 'AO3 to Wayback Machine', text: message, timeout: 8000 });
            } catch (_) {}
        }
    }

    function storeResult(type, message) {
        _resultShownLiveThisPage = true;
        GM_setValue(ARCHIVE_RESULT_KEY, JSON.stringify({
            type: type, message: message, timestamp: Date.now(),
        }));
        notify(type, message);
    }

    function checkAndShowStoredResult() {
        if (_resultShownLiveThisPage) return;
        try {
            var raw = GM_getValue(ARCHIVE_RESULT_KEY, null);
            if (!raw) return;
            var result = JSON.parse(raw);
            if (Date.now() - result.timestamp > 600000) { GM_setValue(ARCHIVE_RESULT_KEY, null); return; }
            GM_setValue(ARCHIVE_RESULT_KEY, null);
            showBanner(result.message, result.type, result.type === 'success' ? 12000 : 20000);
        } catch (_) {}
    }


    // ================================================================
    // url utilities
    // ================================================================

    var MIRROR_DOMAINS = [
        'archiveofourown.com', 'archiveofourown.net', 'archiveofourown.gay',
        'ao3.org', 'archive.transformativeworks.org', 'insecure.archiveofourown.org',
    ];

    function canonicaliseHost(url) {
        try {
            var parsed = new URL(url);
            if (MIRROR_DOMAINS.indexOf(parsed.hostname) !== -1) {
                parsed.hostname = 'archiveofourown.org';
                parsed.protocol = 'https:';
            }
            return parsed.toString();
        } catch (e) { logError('canonicaliseHost', e); return url; }
    }

    function waybackHref(url) {
        return 'https://web.archive.org/web/*/' + url.replace(/&/g, '&amp;');
    }

    function formatDate() {
        var d = new Date();
        var dd = String(d.getDate()).padStart(2, '0');
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var yyyy = String(d.getFullYear());
        return settings.dateFormat.replace('YYYY', yyyy).replace('MM', mm).replace('DD', dd);
    }


    // ================================================================
    // page data collection
    // ================================================================

    function collectPageData() {
        var href = window.location.href;
        var isSeries = /\/series\/\d+/.test(href);
        var series = null;
        var works = [];
        var urls = new Set();

        if (isSeries) {
            var h2 = document.querySelector('h2.heading');
            var seriesTitle = h2 ? h2.textContent.trim() : document.title;
            var seriesAuthorEl = document.querySelector('.series.meta.group dd');
            var seriesAuthor = seriesAuthorEl ? seriesAuthorEl.textContent.trim() : '';
            var seriesUrl = canonicaliseHost(href.split('?')[0]);
            series = { title: seriesTitle, author: seriesAuthor, url: seriesUrl };
            urls.add(seriesUrl);

            document.querySelectorAll('.work.blurb.group').forEach(function (blurb) {
                var workLink = blurb.querySelector('h4.heading a[href*="/works/"]');
                if (!workLink) workLink = blurb.querySelector('a[href*="/works/"]');
                if (!workLink) return;
                var authorLink = blurb.querySelector('[rel="author"]');
                var workTitle = workLink.textContent.trim();
                var workAuthor = authorLink ? authorLink.textContent.trim() : '';
                var rawPath = workLink.getAttribute('href').split('?')[0].replace(/\/chapters\/\d+/, '');
                var workUrl = canonicaliseHost(new URL(rawPath, window.location.origin).toString()) +
                    '?view_adult=true&view_full_work=true';
                works.push({ title: workTitle, author: workAuthor, url: workUrl });
                urls.add(workUrl);
            });
        } else {
            var titleEl = document.querySelector('h2.title.heading');
            var workTitle = titleEl ? titleEl.textContent.trim() : document.title;
            var authorLinks = document.querySelectorAll('.byline.heading [rel="author"]');
            var workAuthor = authorLinks.length > 0
                ? Array.from(authorLinks).map(function (a) { return a.textContent.trim(); }).join(', ')
                : (document.querySelector('.byline.heading') || { textContent: '' }).textContent.trim();
            var base = canonicaliseHost(href.split('?')[0].replace(/\/chapters\/\d+/, ''));
            var workUrl = base + '?view_adult=true&view_full_work=true';
            works.push({ title: workTitle, author: workAuthor, url: workUrl });
            urls.add(workUrl);
            if (settings.alsoArchivePlainUrl) urls.add(base);
        }

        return { isSeries: isSeries, series: series, works: works, urls: urls };
    }


    // ================================================================
    // bookmark note injection
    // ================================================================

    function injectBookmarkNote(pageData) {
        var field = document.getElementById('bookmark_notes');
        if (!field) return;
        var date = formatDate();
        var lines = [];

        if (pageData.isSeries && pageData.series) {
            lines.push('<a href="' + waybackHref(pageData.series.url) + '">' +
                pageData.series.title + '</a> by ' + pageData.series.author);
            pageData.works.forEach(function (w) {
                lines.push('<a href="' + waybackHref(w.url) + '">' + w.title + '</a> by ' + w.author);
            });
        } else if (pageData.works.length > 0) {
            var w = pageData.works[0];
            lines.push('<a href="' + waybackHref(w.url) + '">' + w.title + '</a> by ' + w.author);
        }
        lines.push(settings.noteDivider + date);
        var noteSnippet = lines.join('<br>');

        var existing = field.value || '';
        var waybackIdx = existing.indexOf('<a href="https://web.archive.org/web/*/');
        var divIdx = existing.indexOf(settings.noteDivider);
        var autoStart = -1;
        if (waybackIdx !== -1 && divIdx !== -1) autoStart = Math.min(waybackIdx, divIdx);
        else if (waybackIdx !== -1) autoStart = waybackIdx;
        else if (divIdx !== -1) autoStart = divIdx;

        var userNotes = autoStart !== -1 ? existing.slice(0, autoStart).trimEnd() : existing.trimEnd();
        field.value = userNotes ? userNotes + '\n\n' + noteSnippet : noteSnippet;
    }


    // ================================================================
    // status banner
    // ================================================================

    function getOrCreateBanner() {
        var el = document.getElementById('ao3-wayback-banner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ao3-wayback-banner';
            Object.assign(el.style, {
                position: 'fixed', bottom: '18px', right: '70px', zIndex: '99999',
                maxWidth: '320px', padding: '10px 15px', borderRadius: '6px',
                fontFamily: 'sans-serif', fontSize: '13px', lineHeight: '1.5',
                boxShadow: '0 2px 10px rgba(0,0,0,0.3)', cursor: 'default',
                transition: 'opacity 0.4s ease', opacity: '0', pointerEvents: 'none',
            });
            document.body.appendChild(el);
        }
        return el;
    }

    var BANNER_THEMES = {
        info:    { background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a' },
        success: { background: '#1e2e22', color: '#a6e3a1', border: '1px solid #40a04a' },
        error:   { background: '#2e1e1e', color: '#f38ba8', border: '1px solid #a03040' },
    };

    var _bannerTimer = null;

    function showBanner(message, type, duration) {
        type = type || 'info';
        duration = duration || 6000;
        var banner = getOrCreateBanner();
        var theme = BANNER_THEMES[type] || BANNER_THEMES.info;
        Object.assign(banner.style, theme);
        banner.textContent = message;
        banner.style.opacity = '1';
        clearTimeout(_bannerTimer);
        _bannerTimer = setTimeout(function () { banner.style.opacity = '0'; }, duration);
    }


    // ================================================================
    // ia login status cache
    // ================================================================

    var _iaStatusCache = null;

    function getCachedIaStatus() {
        if (_iaStatusCache !== null) return Promise.resolve(_iaStatusCache);
        return getIaLoginStatus().then(function (s) { _iaStatusCache = s; return s; });
    }

    function getIaLoginStatus() {
        return new Promise(function (resolve) {
            var fallback = { loggedIn: false, username: null };
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://archive.org/account/s3.php',
                timeout: 8000,
                onload: function (r) {
                    var finalUrl = r.finalUrl || '';
                    var loggedIn = r.status === 200 && finalUrl.indexOf('login') === -1;
                    var username = null;
                    if (loggedIn) {
                        var pats = [/"username"\s*:\s*"([^"]+)"/, /logged[- ]in as[^<]*<[^>]+>([^<]+)/i];
                        for (var i = 0; i < pats.length; i++) {
                            var m = r.responseText.match(pats[i]);
                            if (m) { username = m[1].trim(); break; }
                        }
                    }
                    console.log('[AO3\u2192Wayback] ia auth: loggedIn=' + loggedIn + ' user=' + username);
                    resolve({ loggedIn: loggedIn, username: username });
                },
                onerror: function () { resolve(fallback); },
                ontimeout: function () { resolve(fallback); },
            });
        });
    }


    // ================================================================
    // ao3 cookie collection
    // ================================================================

    function getAo3Cookies() {
        return new Promise(function (resolve) {
            var fallback = document.cookie;
            var settled = false;
            function done(val) {
                if (settled) return;
                settled = true;
                resolve(val || fallback);
            }
            setTimeout(function () { if (!settled) { done(fallback); } }, 1500);
            try {
                if (typeof GM_cookie !== 'undefined' && typeof GM_cookie.list === 'function') {
                    GM_cookie.list({}, function (cookies, error) {
                        if (error || !Array.isArray(cookies) || cookies.length === 0) { done(fallback); return; }
                        done(cookies.map(function (c) { return c.name + '=' + c.value; }).join('; '));
                    });
                } else { done(fallback); }
            } catch (e) { done(fallback); }
        });
    }


    // ================================================================
    // spn2 api
    // ================================================================

    var SPN2_PARAM_SETS = [
        '',
        'capture_screenshot=on',
        'capture_all=on&capture_screenshot=on',
    ];

    function checkCdx(url) {
        return new Promise(function (resolve) {
            var today = new Date();
            var yyyymmdd = String(today.getFullYear()) +
                String(today.getMonth() + 1).padStart(2, '0') +
                String(today.getDate()).padStart(2, '0');
            var cdxUrl = 'https://web.archive.org/cdx/search/cdx' +
                '?output=json&limit=1&fl=timestamp&matchType=prefix&from=' + yyyymmdd +
                '&url=' + encodeURIComponent(url.split('?')[0]);
            GM_xmlhttpRequest({
                method: 'GET', url: cdxUrl, timeout: 15000,
                onload: function (r) {
                    try {
                        var rows = JSON.parse(r.responseText || '[]');
                        resolve(Array.isArray(rows) && rows.length > 1);
                    } catch (_) { resolve(false); }
                },
                onerror: function () { resolve(false); },
                ontimeout: function () { resolve(false); },
            });
        });
    }

    function pollSpn2Job(jobId, url, resolve, reject) {
        var polls = 0;
        var maxPolls = 60;
        function poll() {
            polls++;
            var elapsed = Math.round(polls * 5);
            showBanner('IA API: archiving in progress... (' + elapsed + 's)', 'info', 8000);
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://web.archive.org/save/status/' + jobId,
                headers: { 'Accept': 'application/json' },
                timeout: 10000,
                onload: function (r) {
                    if (r.status === 429) {
                        console.log('[AO3→Wayback] poll rate limited (429), backing off 60s');
                        setTimeout(poll, 60000);
                        return;
                    }
                    if (r.status === 503 || r.status === 502) {
                        // ia service temporarily unavailable -- back off and retry poll
                        console.log('[AO3→Wayback] poll service unavailable (' + r.status + '), backing off 30s');
                        setTimeout(poll, 30000);
                        return;
                    }
                    var data;
                    try { data = JSON.parse(r.responseText); } catch (_) { data = {}; }
                    if (data.status === 'success') {
                        resolve({ url: url, method: 'spn2' });
                    } else if (data.status === 'error') {
                        var reason = data.message || 'unknown';
                        var statusExt = data.status_ext || '';

                        // transient wayback-side error (503/502) inside the job body.
                        // this is different from ao3 returning 503 to wayback -- it means
                        // wayback's own capture infrastructure is temporarily overloaded.
                        // back off and retry the poll rather than treating it as fatal.
                        var isTransient503 =
                            reason.indexOf('503') !== -1 ||
                            reason.indexOf('502') !== -1 ||
                            reason.indexOf('No server is available') !== -1 ||
                            statusExt === 'error:service-unavailable' ||
                            statusExt === 'error:gateway-timeout';
                        if (isTransient503 && polls < maxPolls) {
                            console.log('[AO3→Wayback] job 503/unavailable in body, backing off 60s and retrying poll');
                            showBanner('Wayback server unavailable -- retrying in 60s...', 'info', 65000);
                            setTimeout(poll, 60000);
                            return;
                        }

                        var is404 = (statusExt === 'error:not-found') ||
                            reason.indexOf('404') !== -1 || reason.indexOf('does not exist') !== -1;
                        var msg = 'spn2 job failed: ' + reason + ' | raw: ' + r.responseText.slice(0, 200);
                        logError('spn2:job-error', msg);
                        var err = new Error(msg);
                        err.is404 = is404;
                        reject(err);
                    } else if (polls < maxPolls) {
                        setTimeout(poll, 5000);
                    } else {
                        logError('spn2:timeout', 'job ' + jobId + ' timed out');
                        reject(new Error('spn2 job timed out'));
                    }
                },
                onerror: function () { if (polls < maxPolls) setTimeout(poll, 5000); else reject(new Error('poll network error')); },
                ontimeout: function () { if (polls < maxPolls) setTimeout(poll, 5000); else reject(new Error('poll timed out')); },
            });
        }
        setTimeout(poll, 5000);
    }

    function submitSpn2(url, extraParams, headers) {
        return new Promise(function (resolve, reject) {
            var body = 'url=' + encodeURIComponent(url);
            if (extraParams) body += '&' + extraParams;
            GM_xmlhttpRequest({
                method: 'POST', url: 'https://web.archive.org/save',
                headers: headers, data: body, timeout: 30000,
                onload: function (r) {
                    if (r.status === 429) {
                        logError('spn2:ratelimit', 'rate limited (429) -- backing off 90s');
                        reject({ status: 429, msg: 'rate limited (429)', retryAfter: 90000 });
                        return;
                    }
                    if (r.status === 503 || r.status === 502) {
                        // ia save service temporarily unavailable -- back off and retry
                        logError('spn2:unavailable', 'service unavailable (' + r.status + ') -- backing off 60s');
                        reject({ status: r.status, msg: 'service unavailable (' + r.status + ')', retryAfter: 60000, transient: true });
                        return;
                    }
                    var data;
                    try { data = JSON.parse(r.responseText); } catch (_) { data = {}; }
                    if (data.job_id) {
                        resolve(data.job_id);
                    } else {
                        var msg = 'submit failed (status ' + r.status + '): ' + r.responseText.slice(0, 200);
                        logError('spn2:submit', msg);
                        reject({ status: r.status, msg: msg });
                    }
                },
                onerror: function (e) {
                    var msg = 'network error: ' + (e.statusText || 'unknown');
                    logError('spn2:network', msg);
                    reject({ status: 0, msg: msg });
                },
                ontimeout: function () {
                    logError('spn2:timeout', 'submit timed out');
                    reject({ status: 0, msg: 'submit timed out' });
                },
            });
        });
    }

    function saveViaSPN2(url) {
        return new Promise(function (resolve, reject) {
            Promise.all([getAo3Cookies(), getCachedIaStatus()]).then(function (res) {
                var ao3Cookies = res[0];
                var iaStatus = res[1];
                var headers = { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' };
                if (iaStatus.loggedIn) {
                    console.log('[AO3\u2192Wayback] spn2 using ia session (' + iaStatus.username + ')');
                } else if (settings.iaAccessKey && settings.iaSecretKey) {
                    headers['Authorization'] = 'LOW ' + settings.iaAccessKey + ':' + settings.iaSecretKey;
                }
                var baseParams = ao3Cookies ? 'capture_cookie=' + encodeURIComponent(ao3Cookies) : '';
                var authMode = iaStatus.loggedIn ? 'session' : (settings.iaAccessKey ? 'api keys' : 'anon');
                var attempt = 0;

                function trySubmit() {
                    attempt++;
                    var paramSet = SPN2_PARAM_SETS[Math.min(attempt - 1, SPN2_PARAM_SETS.length - 1)];
                    var fullParams = baseParams + (baseParams && paramSet ? '&' : '') + paramSet;
                    showBanner('IA API: submitting (' + authMode + (attempt > 1 ? ', attempt ' + attempt : '') + ')...', 'info', 30000);

                    submitSpn2(url, fullParams, headers).then(function (jobId) {
                        showBanner('IA API: job queued, waiting for Wayback...', 'info', 60000);
                        addPendingItem({ type: 'spn2', jobId: jobId, url: url, startedAt: Date.now() });
                        function spn2Done(r) { removePendingItem('spn2', jobId); resolve(r); }
                        function spn2Fail(e) {
                            removePendingItem('spn2', jobId);
                            if (e.is404 && attempt <= maxRetries()) {
                                showBanner('AO3 blocked Wayback (404). Retrying with simpler url...', 'info', retryDelayMs() + 5000);
                                setTimeout(trySubmit, retryDelayMs());
                            } else {
                                reject(e);
                            }
                        }
                        pollSpn2Job(jobId, url, spn2Done, spn2Fail);
                    }, function (err) {
                        if (err.status === 429 || err.transient) {
                            // transient server error (429 rate limit or 502/503 unavailable)
                            // -- back off and retry without counting against maxRetries
                            var wait = err.retryAfter || 60000;
                            var reason = err.status === 429 ? 'rate limiting' : 'service unavailable (' + err.status + ')';
                            showBanner('Wayback ' + reason + ' -- waiting ' + Math.round(wait / 1000) + 's before retry...', 'info', wait + 5000);
                            attempt--;
                            setTimeout(trySubmit, wait);
                        } else if (attempt <= maxRetries()) {
                            showBanner('IA API submit failed (attempt ' + attempt + ') -- retrying...', 'info', retryDelayMs() + 5000);
                            setTimeout(trySubmit, retryDelayMs());
                        } else {
                            var status = err.status || 0;
                            showBanner('IA API error (status ' + status + '). Open settings for error log.', 'error', 15000);
                            reject(new Error(err.msg || 'spn2 failed after ' + attempt + ' attempts'));
                        }
                    });
                }
                trySubmit();
            });
        });
    }


    // ================================================================
    // tab-based fallback
    // ================================================================

    var CDX_CHECK_DELAY_MS = 35000;
    var TAB_CLOSE_DELAY_MS = 30000;
    function maxRetries()   { return settings.maxRetries; }
    function retryDelayMs() { return settings.retryDelayMs; }
    var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    function openSaveTab(url) {
        var saveUrl = 'https://web.archive.org/save/' +
            url.replace('?', '%3F').replace(/&/g, '%26');
        var tab = GM_openInTab(saveUrl, { active: IS_TOUCH, insert: true });
        setTimeout(function () { try { tab.close(); } catch (_) {} },
            IS_TOUCH ? TAB_CLOSE_DELAY_MS * 2 : TAB_CLOSE_DELAY_MS);
        return tab;
    }

    function urlForAttempt(url, attempt) {
        if (attempt === 1) return url;
        if (attempt === 2) return url.split('?')[0] + '?view_adult=true';
        return url.split('?')[0];
    }

    function saveViaTab(url) {
        return new Promise(function (resolve, reject) {
            var attempt = 0;
            var cdxDelay = IS_TOUCH ? CDX_CHECK_DELAY_MS * 2 : CDX_CHECK_DELAY_MS;
            function tryOnce() {
                attempt++;
                var attemptUrl = urlForAttempt(url, attempt);
                try { openSaveTab(attemptUrl); } catch (e) {
                    logError('saveViaTab:open', String(e));
                    reject(new Error(String(e)));
                    return;
                }
                addPendingItem({ type: 'tab', url: url, attemptUrl: attemptUrl,
                    checkAfter: Date.now() + cdxDelay, startedAt: Date.now() });
                setTimeout(function () {
                    checkCdx(url).then(function (found) {
                        removePendingItem('tab', url);
                        if (found) {
                            resolve({ url: attemptUrl, method: 'tab' });
                        } else if (attempt <= maxRetries()) {
                            showBanner('Wayback did not save it (attempt ' + attempt + ') -- retrying...', 'info', retryDelayMs() + 5000);
                            setTimeout(tryOnce, retryDelayMs());
                        } else {
                            var msg = 'no cdx snapshot after ' + attempt + ' attempts for ' + url;
                            logError('saveViaTab:cdx-miss', msg);
                            reject(new Error(msg));
                        }
                    });
                }, cdxDelay);
            }
            tryOnce();
        });
    }

    function saveToWayback(url) {
        if (settings.iaAccessKey && settings.iaSecretKey) return saveViaSPN2(url);
        if (_iaStatusCache && _iaStatusCache.loggedIn) return saveViaSPN2(url);
        return saveViaTab(url);
    }

    var _hasRun = false;

    function archiveAll(urls) {
        if (_hasRun) return;
        _hasRun = true;
        setTimeout(function () { _hasRun = false; }, 5000);

        var urlArray = Array.from(urls);
        var count = urlArray.length;
        var noun = count === 1 ? 'fic' : 'fics';
        var usingSPN2 = !!(settings.iaAccessKey && settings.iaSecretKey) ||
            !!(_iaStatusCache && _iaStatusCache.loggedIn);

        showBanner(
            (usingSPN2 ? 'IA API: sending ' : 'Saving ') + count + ' ' + noun + ' to the Wayback Machine...' +
            (!usingSPN2 && IS_TOUCH ? ' (check the new tab)' : ''),
            'info', 300000
        );

        var savePromises;
        if (IS_TOUCH && !usingSPN2 && count > 1) {
            var TAB_QUEUE_DELAY_MS = TAB_CLOSE_DELAY_MS * 2 + 5000;
            savePromises = urlArray.map(function (url, i) {
                return new Promise(function (resolve, reject) {
                    setTimeout(function () { saveToWayback(url).then(resolve, reject); }, i * TAB_QUEUE_DELAY_MS);
                });
            });
        } else {
            savePromises = urlArray.map(saveToWayback);
        }

        Promise.allSettled(savePromises).then(function (results) {
            var ok = results.filter(function (r) { return r.status === 'fulfilled'; });
            var fail = results.filter(function (r) { return r.status === 'rejected'; });
            var msg, type;
            if (fail.length === 0) {
                msg = 'Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.';
                type = 'success';
            } else if (ok.length === 0) {
                msg = 'Could not archive ' + count + ' ' + noun + '. AO3 may be blocking Wayback. Open settings for error log.';
                type = 'error';
            } else {
                msg = 'Archived ' + ok.length + '/' + count + ' ' + noun + '. ' + fail.length + ' failed. Open settings for error log.';
                type = 'error';
            }
            showBanner(msg, type, type === 'success' ? 6000 : 12000);
            storeResult(type, msg);
        });
    }


    // ================================================================
    // resume pending archives
    // ================================================================

    function resumePendingArchives() {
        var items = loadPending();
        if (items.length === 0) return;
        showBanner('Resuming ' + items.length + ' pending archive(s) from last bookmark...', 'info', 15000);
        items.forEach(function (item) {
            if (item.type === 'spn2') {
                pollSpn2Job(item.jobId, item.url,
                    function () {
                        removePendingItem('spn2', item.jobId);
                        var m = 'Archived to the Wayback Machine.';
                        showBanner(m, 'success'); storeResult('success', m);
                    },
                    function (err) {
                        removePendingItem('spn2', item.jobId);
                        logError('resume:spn2', String(err));
                        var m = 'Archive failed. Open settings for error log.';
                        showBanner(m, 'error', 10000); storeResult('error', m);
                    }
                );
            } else if (item.type === 'tab') {
                setTimeout(function () {
                    checkCdx(item.url).then(function (found) {
                        removePendingItem('tab', item.url);
                        if (found) {
                            var m = 'Archived to the Wayback Machine.';
                            showBanner(m, 'success'); storeResult('success', m);
                        } else {
                            logError('resume:tab', 'no cdx snapshot for ' + item.url);
                            var m = 'No snapshot found. Open settings for error log.';
                            showBanner(m, 'error', 10000); storeResult('error', m);
                        }
                    });
                }, Math.max(0, item.checkAfter - Date.now()));
            }
        });
    }


    // ================================================================
    // settings ui
    // ================================================================

    function injectSettingsUI(pageData) {

        var gearBtn = document.createElement('button');
        gearBtn.id = 'ao3wayback-settings-btn';
        gearBtn.title = 'AO3 to Wayback Machine -- Settings';
        gearBtn.textContent = '\u2699';
        Object.assign(gearBtn.style, {
            position: 'fixed', bottom: '18px', right: '18px', zIndex: '100000',
            width: '40px', height: '40px', borderRadius: '50%',
            border: '1px solid #7a0000', background: '#900', color: '#fff',
            fontSize: '18px', lineHeight: '1', padding: '0', cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        });
        document.body.appendChild(gearBtn);

        var overlay = document.createElement('div');
        overlay.id = 'ao3wayback-modal';
        Object.assign(overlay.style, {
            display: 'none', position: 'fixed',
            top: '0', right: '0', bottom: '0', left: '0',
            zIndex: '100001', background: 'rgba(0,0,0,0.55)',
            alignItems: 'center', justifyContent: 'center',
        });
        document.body.appendChild(overlay);

        var box = document.createElement('div');
        Object.assign(box.style, {
            position: 'relative', background: '#fffbf0', color: '#2a2a2a',
            borderRadius: '8px', padding: '24px 28px 20px', width: '340px',
            maxWidth: '90vw', boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
            fontFamily: 'Georgia, "Times New Roman", serif', fontSize: '14px',
            overflowY: 'auto', maxHeight: '90vh',
        });
        overlay.appendChild(box);

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '\u2715';
        Object.assign(closeBtn.style, {
            position: 'absolute', top: '14px', right: '16px',
            background: 'none', border: 'none', fontSize: '16px',
            color: '#666', cursor: 'pointer', padding: '0', lineHeight: '1',
        });
        box.appendChild(closeBtn);

        var titleEl = document.createElement('h2');
        titleEl.textContent = 'AO3 to Wayback Machine';
        Object.assign(titleEl.style, {
            margin: '0 0 16px', paddingBottom: '10px',
            fontSize: '16px', color: '#900', borderBottom: '1px solid #ccc',
        });
        box.appendChild(titleEl);

        function sectionHead(text) {
            var el = document.createElement('div');
            el.textContent = text;
            Object.assign(el.style, { fontWeight: 'bold', marginBottom: '6px', marginTop: '14px' });
            return el;
        }

        // options
        box.appendChild(sectionHead('Options'));
        var plainUrlCheck = document.createElement('input');
        plainUrlCheck.type = 'checkbox';
        plainUrlCheck.id = 'ao3wayback-plain-url';
        plainUrlCheck.checked = settings.alsoArchivePlainUrl;
        var plainUrlLabel = document.createElement('label');
        plainUrlLabel.htmlFor = 'ao3wayback-plain-url';
        Object.assign(plainUrlLabel.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' });
        var plainUrlSpan = document.createElement('span');
        plainUrlSpan.textContent = 'Also archive URL without view params';
        plainUrlLabel.appendChild(plainUrlCheck);
        plainUrlLabel.appendChild(plainUrlSpan);
        box.appendChild(plainUrlLabel);

        // date format
        box.appendChild(sectionHead('Date format'));
        var DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
        var dateFormatRadios = {};
        var fmtGroup = document.createElement('div');
        fmtGroup.style.paddingLeft = '4px';
        DATE_FORMATS.forEach(function (fmt) {
            var radio = document.createElement('input');
            radio.type = 'radio'; radio.name = 'ao3wayback-datefmt';
            radio.value = fmt; radio.id = 'ao3wayback-fmt-' + fmt;
            radio.checked = settings.dateFormat === fmt;
            dateFormatRadios[fmt] = radio;
            var lbl = document.createElement('label');
            lbl.htmlFor = radio.id;
            Object.assign(lbl.style, { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', marginBottom: '4px' });
            var span = document.createElement('span');
            span.textContent = fmt;
            lbl.appendChild(radio);
            lbl.appendChild(span);
            fmtGroup.appendChild(lbl);
        });
        box.appendChild(fmtGroup);

        // note label
        box.appendChild(sectionHead('Note label'));
        var noteLabelInput = document.createElement('input');
        noteLabelInput.type = 'text';
        noteLabelInput.value = settings.noteDivider;
        Object.assign(noteLabelInput.style, {
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            border: '1px solid #ccc', borderRadius: '4px',
            fontSize: '13px', fontFamily: 'monospace',
            background: '#fff', color: '#2a2a2a', marginTop: '4px',
        });
        box.appendChild(noteLabelInput);

        // internet archive
        box.appendChild(sectionHead('Internet Archive'));
        var iaStatusBadge = document.createElement('div');
        Object.assign(iaStatusBadge.style, {
            fontSize: '12px', padding: '6px 10px', borderRadius: '4px',
            marginBottom: '10px', lineHeight: '1.4',
        });
        box.appendChild(iaStatusBadge);

        function setIaBadge(loggedIn, username) {
            if (loggedIn) {
                iaStatusBadge.textContent = 'Logged into archive.org' +
                    (username ? ' as ' + username : '') +
                    ' -- using browser session (like the WM extension).';
                Object.assign(iaStatusBadge.style, {
                    background: '#1e2e22', color: '#a6e3a1', border: '1px solid #40a04a',
                });
            } else {
                iaStatusBadge.textContent = 'Not logged into archive.org. ' +
                    'Log in at archive.org for best results, or enter S3 API keys below.';
                Object.assign(iaStatusBadge.style, {
                    background: '#2e2a1e', color: '#f5c97a', border: '1px solid #a07a30',
                });
            }
        }

        function checkIaStatus() {
            iaStatusBadge.textContent = 'Checking archive.org login...';
            Object.assign(iaStatusBadge.style, {
                background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a',
            });
            _iaStatusCache = null;
            getCachedIaStatus().then(function (s) { setIaBadge(s.loggedIn, s.username); });
        }
        checkIaStatus();

        var iaNote = document.createElement('p');
        iaNote.textContent = 'S3 API keys are optional -- only needed if not logged into archive.org. Get keys at archive.org/account/s3.php';
        Object.assign(iaNote.style, { margin: '4px 0 8px', fontSize: '12px', color: '#666', lineHeight: '1.4' });
        box.appendChild(iaNote);

        var accessKeyInput = document.createElement('input');
        accessKeyInput.type = 'text'; accessKeyInput.placeholder = 'Access key';
        accessKeyInput.value = settings.iaAccessKey || ''; accessKeyInput.autocomplete = 'off';
        Object.assign(accessKeyInput.style, {
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            border: '1px solid #ccc', borderRadius: '4px',
            fontSize: '13px', fontFamily: 'monospace',
            background: '#fff', color: '#2a2a2a', marginBottom: '6px',
        });
        box.appendChild(accessKeyInput);

        var secretKeyInput = document.createElement('input');
        secretKeyInput.type = 'password'; secretKeyInput.placeholder = 'Secret key';
        secretKeyInput.value = settings.iaSecretKey || ''; secretKeyInput.autocomplete = 'off';
        Object.assign(secretKeyInput.style, {
            width: '100%', boxSizing: 'border-box', padding: '6px 8px',
            border: '1px solid #ccc', borderRadius: '4px',
            fontSize: '13px', fontFamily: 'monospace',
            background: '#fff', color: '#2a2a2a', marginBottom: '4px',
        });
        box.appendChild(secretKeyInput);

        // retry settings
        box.appendChild(sectionHead('Retry settings'));
        var retryRow = document.createElement('div');
        Object.assign(retryRow.style, { display: 'flex', gap: '12px', alignItems: 'center', marginBottom: '10px' });

        function numInput(id, min, max, val) {
            var inp = document.createElement('input');
            inp.type = 'number'; inp.id = id;
            inp.min = String(min); inp.max = String(max); inp.value = String(val);
            Object.assign(inp.style, {
                width: '52px', padding: '4px 6px', border: '1px solid #ccc',
                borderRadius: '4px', fontSize: '13px', background: '#fff', color: '#2a2a2a',
            });
            return inp;
        }

        var retriesLabel = document.createElement('label');
        retriesLabel.textContent = 'Max retries';
        retriesLabel.style.whiteSpace = 'nowrap';
        var retriesInput = numInput('ao3wayback-retries', 0, 5, settings.maxRetries);
        retriesLabel.htmlFor = 'ao3wayback-retries';

        var delayLabel = document.createElement('label');
        delayLabel.textContent = 'Retry delay (s)';
        delayLabel.style.whiteSpace = 'nowrap';
        var delayInput = numInput('ao3wayback-retrydelay', 10, 120, settings.retryDelayMs / 1000);
        delayLabel.htmlFor = 'ao3wayback-retrydelay';

        retryRow.appendChild(retriesLabel); retryRow.appendChild(retriesInput);
        retryRow.appendChild(delayLabel);   retryRow.appendChild(delayInput);
        box.appendChild(retryRow);

        // diagnostics
        box.appendChild(sectionHead('Diagnostics'));
        var logBtn = document.createElement('button');
        Object.assign(logBtn.style, {
            padding: '6px 12px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
            border: '1px solid #aaa', background: '#f5f5f5', color: '#2a2a2a',
            marginTop: '4px', marginBottom: '18px', width: '100%',
        });
        logBtn.title = 'Copies a JSON error log to your clipboard. Paste into a GitHub issue.';
        logBtn.addEventListener('click', exportErrorLog);
        box.appendChild(logBtn);

        // save / cancel
        var btnRow = document.createElement('div');
        Object.assign(btnRow.style, { display: 'flex', gap: '10px', justifyContent: 'flex-end' });

        function makeActionBtn(text, primary) {
            var b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding: '6px 16px', borderRadius: '4px', fontSize: '13px', cursor: 'pointer',
                border: primary ? 'none' : '1px solid #aaa',
                background: primary ? '#900' : '#f5f5f5',
                color: primary ? '#fff' : '#2a2a2a',
                fontWeight: primary ? 'bold' : 'normal',
            });
            return b;
        }

        var cancelBtn = makeActionBtn('Cancel', false);
        var saveBtn   = makeActionBtn('Save', true);
        btnRow.appendChild(cancelBtn); btnRow.appendChild(saveBtn);
        box.appendChild(btnRow);

        function openModal() {
            plainUrlCheck.checked = settings.alsoArchivePlainUrl;
            DATE_FORMATS.forEach(function (fmt) { dateFormatRadios[fmt].checked = settings.dateFormat === fmt; });
            noteLabelInput.value = settings.noteDivider;
            retriesInput.value = String(settings.maxRetries);
            delayInput.value   = String(settings.retryDelayMs / 1000);
            accessKeyInput.value = settings.iaAccessKey || '';
            secretKeyInput.value = settings.iaSecretKey || '';
            logBtn.textContent = 'Copy error log (' + _errorLog.length + ' entr' +
                (_errorLog.length === 1 ? 'y' : 'ies') + ')';
            checkIaStatus();
            overlay.style.display = 'flex';
        }

        function closeModal() { overlay.style.display = 'none'; }

        gearBtn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        cancelBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

        saveBtn.addEventListener('click', function () {
            var selectedFmt = DATE_FORMATS.find(function (fmt) {
                return dateFormatRadios[fmt].checked;
            }) || DEFAULTS.dateFormat;

            var updated = {
                alsoArchivePlainUrl: plainUrlCheck.checked,
                dateFormat: selectedFmt,
                noteDivider: noteLabelInput.value.trim() || DEFAULTS.noteDivider,
                maxRetries: Math.min(5, Math.max(0, parseInt(retriesInput.value, 10) || 0)),
                retryDelayMs: Math.min(120000, Math.max(10000, (parseInt(delayInput.value, 10) || 20) * 1000)),
                iaAccessKey: accessKeyInput.value.trim(),
                iaSecretKey: secretKeyInput.value.trim(),
            };

            saveSettings(updated);
            settings = updated;
            closeModal();
            showBanner('Settings saved.', 'success');

            if (pageData && document.getElementById('bookmark_notes')) {
                injectBookmarkNote(pageData);
            }
        });
    }


    // ================================================================
    // init
    // ================================================================

    // the @match now covers all ao3 pages so banners appear anywhere the user
    // navigates after bookmarking. but the heavy logic -- page data collection,
    // bookmark form watcher, archiving -- only runs on work and series pages.
    var _path = window.location.pathname;
    var isArchivablePage = /\/(works|series)\/\d+/.test(_path) ||
        /\/collections\/[^/]+\/works\/\d+/.test(_path);

    var pageData = isArchivablePage ? collectPageData() : null;

    if (isArchivablePage && pageData) {
        function onNodeAdded(node) {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            var field = node.id === 'bookmark_notes'
                ? node
                : (node.querySelector ? node.querySelector('#bookmark_notes') : null);
            if (field) injectBookmarkNote(pageData);
        }

        var observer = new MutationObserver(function (mutations) {
            mutations.forEach(function (mut) { mut.addedNodes.forEach(onNodeAdded); });
        });
        observer.observe(document.body, { childList: true, subtree: true });

        if (document.getElementById('bookmark_notes')) {
            injectBookmarkNote(pageData);
        }

        window.addEventListener('submit', function (e) {
            var form = e.target;
            if (!form || !form.action) return;
            var isBookmarkForm =
                /\/bookmarks/.test(form.action) ||
                form.id === 'new_bookmark' ||
                form.classList.contains('bookmark-form');
            if (isBookmarkForm && pageData.urls.size > 0) {
                console.log('[AO3\u2192Wayback] bookmark form submitted, archiving', pageData.urls.size, 'url(s)');
                archiveAll(pageData.urls);
            }
        }, true);
    }

    injectSettingsUI(pageData);

    // pre-warm the ia login status cache in the background
    getCachedIaStatus().then(function (s) {
        console.log('[AO3\u2192Wayback] ia status: loggedIn=' + s.loggedIn + (s.username ? ' user=' + s.username : ''));
    });

    resumePendingArchives();

    // show any result banner from the previous page after 100ms
    setTimeout(checkAndShowStoredResult, 100);

})();
