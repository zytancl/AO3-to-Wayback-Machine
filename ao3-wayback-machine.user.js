// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them, and fills the bookmark notes field with archive links, author(s), and date. Settings are accessible via the ⚙ button at the bottom-right of any AO3 page.
// @version      1.3
// @author       zytancl
// @downloadURL  https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js
// @updateURL    https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js
// @match        https://archiveofourown.org/works/*
// @match        https://archiveofourown.org/series/*
// @match        https://archiveofourown.org/collections/*/works/*
// @match        https://archiveofourown.com/works/*
// @match        https://archiveofourown.com/series/*
// @match        https://archiveofourown.com/collections/*/works/*
// @match        https://archiveofourown.net/works/*
// @match        https://archiveofourown.net/series/*
// @match        https://archiveofourown.net/collections/*/works/*
// @match        https://archiveofourown.gay/works/*
// @match        https://archiveofourown.gay/series/*
// @match        https://archiveofourown.gay/collections/*/works/*
// @match        https://ao3.org/works/*
// @match        https://ao3.org/series/*
// @match        https://ao3.org/collections/*/works/*
// @match        https://archive.transformativeworks.org/works/*
// @match        https://archive.transformativeworks.org/series/*
// @match        https://archive.transformativeworks.org/collections/*/works/*
// @match        http://insecure.archiveofourown.org/works/*
// @match        http://insecure.archiveofourown.org/series/*
// @match        http://insecure.archiveofourown.org/collections/*/works/*
// @connect      web.archive.org
// @grant        GM_xmlhttpRequest
// @grant        GM_cookie
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      GPL-3.0
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // promise.allSettled polyfill
    // needed for older tampermonkey engines (safari, older chrome)
    // ================================================================
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


    // timestamp set as early as possible so we can tell later whether a stored
    // archive result was written on this page or a previous one
    var _scriptStartTime = Date.now();


    // ================================================================
    // settings — persisted with GM_getValue / GM_setValue.
    // edit via the ⚙ button at the bottom-right of any ao3 page
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
        var entry = {
            time: new Date().toISOString(),
            url: window.location.href,
            context: context,
            detail: String(detail),
        };
        _errorLog.push(entry);
        console.warn('[AO3→Wayback]', context, detail);
    }

    function exportErrorLog() {
        var text = JSON.stringify({
            script: 'AO3 to Wayback Machine',
            version: '3.0',
            userAgent: navigator.userAgent,
            exportedAt: new Date().toISOString(),
            errors: _errorLog,
        }, null, 2);

        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                showBanner('📋 Error log copied to clipboard.', 'info');
            }).catch(function () {
                fallbackCopyLog(text);
            });
        } else {
            fallbackCopyLog(text);
        }
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
            showBanner('📋 Error log copied to clipboard.', 'info');
        } catch (_) {
            showBanner('❌ Could not copy log — check the browser console.', 'error');
        }
        document.body.removeChild(ta);
    }


    // ================================================================
    // persistent archive status
    // ================================================================
    //
    // when a bookmark is submitted ao3 may navigate the page, killing any
    // in-flight timers (cdx checks, spn2 poll loops). i store each pending
    // archive job in GM_setValue so the next ao3 page can pick it up and
    // resume showing progress / the final result.

    var ARCHIVE_STATUS_KEY = 'ao3wayback_pending';

    function loadPending() {
        try {
            var raw = GM_getValue(ARCHIVE_STATUS_KEY, null);
            if (!raw) return [];
            var items = JSON.parse(raw);
            // drop items older than 15 minutes — they have definitely timed out
            var cutoff = Date.now() - 900000;
            return items.filter(function (i) { return i.startedAt > cutoff; });
        } catch (_) { return []; }
    }

    function savePending(items) {
        GM_setValue(ARCHIVE_STATUS_KEY, JSON.stringify(items));
    }

    function addPendingItem(item) {
        var items = loadPending();
        // avoid duplicates
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

    // stores the final archive result (success or error message) so the next
    // page the user navigates to can show it as a banner.
    var ARCHIVE_RESULT_KEY = 'ao3wayback_result';

    function storeResult(type, message) {
        GM_setValue(ARCHIVE_RESULT_KEY, JSON.stringify({
            type: type,
            message: message,
            timestamp: Date.now(),
        }));
    }

    // called at page load to show any result that was written on a previous page.
    // i compare result.timestamp to _scriptStartTime:
    //   - result older than this page starting → written on a previous page → show it
    //   - result newer than this page starting → written on THIS page → skip it
    //     (the live banner already showed it; no need to double-show)
    function checkAndShowStoredResult() {
        try {
            var raw = GM_getValue(ARCHIVE_RESULT_KEY, null);
            if (!raw) return;
            var result = JSON.parse(raw);
            // drop stale results (older than 5 minutes)
            if (Date.now() - result.timestamp > 300000) {
                GM_setValue(ARCHIVE_RESULT_KEY, null);
                return;
            }
            // only show if the result was written before this page loaded
            if (result.timestamp >= _scriptStartTime) return;
            GM_setValue(ARCHIVE_RESULT_KEY, null);
            showBanner(result.message, result.type);
        } catch (_) {}
    }


    // ================================================================
    // url utilities
    // ================================================================

    var MIRROR_DOMAINS = [
        'archiveofourown.com',
        'archiveofourown.net',
        'archiveofourown.gay',
        'ao3.org',
        'archive.transformativeworks.org',
        'insecure.archiveofourown.org',
    ];

    function canonicaliseHost(url) {
        try {
            var parsed = new URL(url);
            if (MIRROR_DOMAINS.indexOf(parsed.hostname) !== -1) {
                parsed.hostname = 'archiveofourown.org';
                parsed.protocol = 'https:';
            }
            return parsed.toString();
        } catch (e) {
            logError('canonicaliseHost', e);
            return url;
        }
    }

    // build a wayback wildcard href for an ao3 url.
    // wayback indexes urls with a literal ? in the path — encoding it as
    // %3F causes the calendar to return zero results, so i keep ? as-is.
    // & needs to be html-encoded as &amp; so the browser doesn't treat it
    // as a query param separator for web.archive.org — it decodes &amp;
    // back to & before actually following the link
    function waybackHref(url) {
        return 'https://web.archive.org/web/*/' + url.replace(/&/g, '&amp;');
    }

    function formatDate() {
        var d = new Date();
        var dd = String(d.getDate()).padStart(2, '0');
        var mm = String(d.getMonth() + 1).padStart(2, '0');
        var yyyy = String(d.getFullYear());
        return settings.dateFormat
            .replace('YYYY', yyyy)
            .replace('MM', mm)
            .replace('DD', dd);
    }


    // ================================================================
    // page data collection
    // returns { isSeries, series, works, urls }
    // series — { title, author, url } or null
    // works  — [{ title, author, url }]
    // urls   — set of canonical ao3 urls to archive
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
                var workUrl = canonicaliseHost(
                    new URL(rawPath, window.location.origin).toString()
                ) + '?view_adult=true&view_full_work=true';

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
            lines.push(
                '<a href="' + waybackHref(pageData.series.url) + '">' +
                pageData.series.title + '</a> by ' + pageData.series.author
            );
            pageData.works.forEach(function (w) {
                lines.push(
                    '<a href="' + waybackHref(w.url) + '">' +
                    w.title + '</a> by ' + w.author
                );
            });
        } else if (pageData.works.length > 0) {
            var w = pageData.works[0];
            lines.push(
                '<a href="' + waybackHref(w.url) + '">' +
                w.title + '</a> by ' + w.author
            );
        }

        lines.push(settings.noteDivider + date);

        var noteSnippet = lines.join('<br>');

        var existing = field.value || '';

        // find the start of the entire auto-generated block.
        // i check for both the wayback link and the date label and use
        // whichever comes first, so the whole block gets replaced on
        // re-edits rather than just the date line
        var waybackIdx = existing.indexOf('<a href="https://web.archive.org/web/*/');
        var divIdx = existing.indexOf(settings.noteDivider);
        var autoStart = -1;
        if (waybackIdx !== -1 && divIdx !== -1) {
            autoStart = Math.min(waybackIdx, divIdx);
        } else if (waybackIdx !== -1) {
            autoStart = waybackIdx;
        } else if (divIdx !== -1) {
            autoStart = divIdx;
        }

        var userNotes = autoStart !== -1
            ? existing.slice(0, autoStart).trimEnd()
            : existing.trimEnd();

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
                position: 'fixed',
                bottom: '18px',
                right: '70px',
                zIndex: '99999',
                maxWidth: '320px',
                padding: '10px 15px',
                borderRadius: '6px',
                fontFamily: 'sans-serif',
                fontSize: '13px',
                lineHeight: '1.5',
                boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
                cursor: 'default',
                transition: 'opacity 0.4s ease',
                opacity: '0',
                pointerEvents: 'none',
            });
            document.body.appendChild(el);
        }
        return el;
    }

    var BANNER_THEMES = {
        info: { background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a' },
        success: { background: '#1e2e22', color: '#a6e3a1', border: '1px solid #40a04a' },
        error: { background: '#2e1e1e', color: '#f38ba8', border: '1px solid #a03040' },
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
        _bannerTimer = setTimeout(function () {
            banner.style.opacity = '0';
        }, duration);
    }


    // ================================================================
    // archiving
    // ================================================================

    // check the wayback cdx api to see if a snapshot was created today.
    // i pass the target url as a query param value (encodeURIComponent)
    // so there's no url-in-path encoding problem here
    // ── cdx verification ────────────────────────────────────────────

    // checks wayback's cdx api to see if a snapshot of the base url
    // exists today. i use the base url (no query params) as the key
    // so it matches regardless of which param variant wayback stored.
    function checkCdx(url) {
        return new Promise(function (resolve) {
            var today = new Date();
            var yyyymmdd = String(today.getFullYear()) +
                String(today.getMonth() + 1).padStart(2, '0') +
                String(today.getDate()).padStart(2, '0');

            var cdxUrl = 'https://web.archive.org/cdx/search/cdx' +
                '?output=json&limit=1&fl=timestamp&matchType=prefix' +
                '&from=' + yyyymmdd +
                '&url=' + encodeURIComponent(url.split('?')[0]);

            console.log('[AO3→Wayback] cdx check:', cdxUrl);
            GM_xmlhttpRequest({
                method: 'GET',
                url: cdxUrl,
                timeout: 15000,
                onload: function (r) {
                    try {
                        var rows = JSON.parse(r.responseText || '[]');
                        // rows[0] is the header row; actual results start at rows[1]
                        var found = Array.isArray(rows) && rows.length > 1;
                        console.log('[AO3→Wayback] cdx found:', found, 'for', url);
                        resolve(found);
                    } catch (_) {
                        resolve(false);
                    }
                },
                onerror: function () { resolve(false); },
                ontimeout: function () { resolve(false); },
            });
        });
    }


    // ── timing constants ─────────────────────────────────────────────

    // how long to wait before checking cdx — wayback usually processes
    // saves within ~30s but i give it a bit extra
    var CDX_CHECK_DELAY_MS = 35000;
    // close the save tab after this long
    var TAB_CLOSE_DELAY_MS = 30000;
    // read retry settings from the live config each time
    function maxRetries()   { return settings.maxRetries; }
    function retryDelayMs() { return settings.retryDelayMs; }

    // touch = mobile or tablet. matters for tab behaviour (see openSaveTab)
    var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);


    // ── spn2 api (preferred when ia credentials are configured) ──────

    // collects all ao3 cookies for the current domain.
    // document.cookie only gives us non-httpOnly cookies, which misses
    // _otwarchive_session — the main session token ao3 uses to recognise
    // logged-in users. GM_cookie (tampermonkey extension API) can read
    // httpOnly cookies from inside the extension sandbox, so i try that
    // first and fall back to document.cookie for other managers.
    function getAo3Cookies() {
        return new Promise(function (resolve) {
            var fallback = document.cookie;

            try {
                if (typeof GM_cookie !== 'undefined' &&
                    typeof GM_cookie.list === 'function') {

                    GM_cookie.list({}, function (cookies, error) {
                        if (error || !Array.isArray(cookies) || cookies.length === 0) {
                            console.log('[AO3→Wayback] GM_cookie.list failed or empty, using document.cookie');
                            resolve(fallback);
                            return;
                        }
                        var cookieStr = cookies.map(function (c) {
                            return c.name + '=' + c.value;
                        }).join('; ');
                        console.log('[AO3→Wayback] collected', cookies.length, 'cookies via GM_cookie');
                        resolve(cookieStr || fallback);
                    });
                } else {
                    console.log('[AO3→Wayback] GM_cookie not available, using document.cookie');
                    resolve(fallback);
                }
            } catch (e) {
                console.warn('[AO3→Wayback] GM_cookie error:', e);
                resolve(fallback);
            }
        });
    }
    //
    // the save page now 2 api lets me POST the url + ao3 cookies directly
    // to wayback using my internet archive credentials. wayback's crawler
    // then fetches ao3 with those cookies attached, so it sees the page as
    // a logged-in user instead of an anonymous bot — which is why it was
    // getting 404s before.
    //
    // to use this: create a free internet archive account, get your s3-like
    // api keys from https://archive.org/account/s3.php, and enter them in
    // the ⚙ settings panel.
    //
    // if no ia credentials are set the script falls back to GM_openInTab.

    // polls the spn2 job status endpoint until the job succeeds, fails,
    // or we run out of attempts.
    function pollSpn2Job(jobId, url, resolve, reject) {
        var polls = 0;
        var maxPolls = 60; // poll for up to 5 minutes (every 5s)

        function poll() {
            polls++;
            var elapsed = Math.round(polls * 5);
            showBanner('⏳ IA API: archiving in progress... (' + elapsed + 's)', 'info', 8000);

            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://web.archive.org/save/status/' + jobId,
                headers: { 'Accept': 'application/json' },
                timeout: 10000,
                onload: function (r) {
                    var data;
                    try { data = JSON.parse(r.responseText); } catch (_) { data = {}; }
                    console.log('[AO3→Wayback] spn2 job', jobId, 'status:', data.status, data);

                    if (data.status === 'success') {
                        resolve({ url: url, method: 'spn2' });
                    } else if (data.status === 'error') {
                        // common cause: ao3 returns 404 to wayback's crawler.
                        // ao3 blocks internet archive ips at the network level,
                        // so this fails even with valid session cookies.
                        // capture_screenshot=on (headless chromium) may help
                        // since it uses a real browser ua, but an ip block
                        // will still reject it.
                        var reason = data.message || 'unknown';
                        var isBlocked = reason.indexOf('404') !== -1 ||
                            r.responseText.indexOf('404') !== -1 ||
                            r.responseText.indexOf('does not exist') !== -1;
                        var msg = 'spn2 job failed for ' + url + ': ' + reason +
                            (isBlocked ? ' -- ao3 appears to be blocking wayback (ip-level block, not fixable from userscript)' : '') +
                            ' | raw: ' + r.responseText.slice(0, 200);
                        logError('spn2:job-error', msg);
                        reject(new Error(msg));
                    } else if (polls < maxPolls) {
                        // still pending — keep polling
                        setTimeout(poll, 5000);
                    } else {
                        var timeoutMsg = 'spn2 job ' + jobId + ' timed out after ' + elapsed + 's for ' + url;
                        logError('spn2:timeout', timeoutMsg);
                        reject(new Error(timeoutMsg));
                    }
                },
                onerror: function () {
                    if (polls < maxPolls) setTimeout(poll, 5000);
                    else reject(new Error('spn2 status poll network error for ' + url));
                },
                ontimeout: function () {
                    if (polls < maxPolls) setTimeout(poll, 5000);
                    else reject(new Error('spn2 status poll timed out for ' + url));
                },
            });
        }

        setTimeout(poll, 5000);
    }

    // submits a url to the spn2 api and polls for the result.
    // passes the user's ao3 cookies so wayback crawls as a logged-in user,
    // bypassing ao3's anti-bot 404s.
    function saveViaSPN2(url) {
        return new Promise(function (resolve, reject) {
            // use getAo3Cookies() to collect ALL ao3 cookies including the
            // httpOnly _otwarchive_session token. without it wayback's crawler
            // looks anonymous to ao3 and gets a 404 even for public fics.
            getAo3Cookies().then(function (cookies) {
            var body = 'url=' + encodeURIComponent(url);
            if (cookies) {
                body += '&capture_cookie=' + encodeURIComponent(cookies);
            }
            // capture_all: save all page resources (css, images, etc.)
            // capture_screenshot: tells wayback to use a headless chromium
            //   browser instead of a plain http crawler. the headless browser
            //   has a realistic user agent and runs javascript, which gives it
            //   a better chance of getting past ao3's bot detection than a
            //   bare http request does.
            body += '&capture_all=on&capture_screenshot=on';

            console.log('[AO3→Wayback] spn2 POST for:', url,
                '| cookies length:', cookies ? cookies.length : 0);
            showBanner('📡 IA API: submitting save request...', 'info', 30000);
            GM_xmlhttpRequest({
                method: 'POST',
                url: 'https://web.archive.org/save',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    // ia s3-like auth — LOW {access}:{secret}
                    'Authorization': 'LOW ' + settings.iaAccessKey + ':' + settings.iaSecretKey,
                    'Accept': 'application/json',
                },
                data: body,
                timeout: 30000,
                onload: function (r) {
                    var data;
                    try { data = JSON.parse(r.responseText); } catch (_) { data = {}; }

                    if (data.job_id) {
                        console.log('[AO3→Wayback] spn2 job created:', data.job_id);
                        showBanner('📡 IA API: job queued, waiting for Wayback...', 'info', 60000);
                        // persist so the next page can resume if navigation happens now
                        addPendingItem({ type: 'spn2', jobId: data.job_id, url: url, startedAt: Date.now() });
                        // wrap resolve/reject to clear the stored item when done
                        function spn2Done(r) { removePendingItem('spn2', data.job_id); resolve(r); }
                        function spn2Fail(e) { removePendingItem('spn2', data.job_id); reject(e); }
                        pollSpn2Job(data.job_id, url, spn2Done, spn2Fail);
                    } else {
                        var msg = 'spn2 submit failed (status ' + r.status + '): ' +
                            r.responseText.slice(0, 300);
                        logError('spn2:submit', msg);
                        // show a banner so the user knows immediately
                        // common causes: wrong api keys, ia account not verified
                        showBanner(
                            '❌ IA API error (status ' + r.status + ').' +
                            (r.status === 401 ? ' Check your access/secret keys in ⚙.' : ' Open ⚙ → Copy error log.'),
                            'error', 15000
                        );
                        reject(new Error(msg));
                    }
                },
                onerror: function (e) {
                    var msg = 'spn2 network error for ' + url + ': ' + (e.statusText || 'unknown');
                    logError('spn2:network', msg);
                    reject(new Error(msg));
                },
                ontimeout: function () {
                    var msg = 'spn2 submit timed out for ' + url;
                    logError('spn2:timeout', msg);
                    reject(new Error(msg));
                },
            });
            }); // end getAo3Cookies().then
        });
    }


    // ── tab-based fallback (no ia credentials needed) ────────────────
    //
    // opens a save tab for a url. i use GM_openInTab instead of xhr/fetch
    // because those kept failing — either dropped silently or the ? in the
    // url got split off by the extension's http layer. real browser navigation
    // preserves %3F in the path so the full ao3 url reaches wayback correctly.
    //
    // on mobile, background tabs get suspended before wayback can load them
    // (confirmed on firefox android), so i open them in the foreground instead.
    function openSaveTab(url) {
        var saveUrl = 'https://web.archive.org/save/' +
            url.replace('?', '%3F').replace(/&/g, '%26');

        console.log('[AO3→Wayback] opening save tab (touch=' + IS_TOUCH + '):', saveUrl);

        var tab = GM_openInTab(saveUrl, { active: IS_TOUCH, insert: true });

        // close the tab after it has had enough time for wayback to crawl.
        // mobile gets double the time since it needs to fully load in the foreground.
        setTimeout(function () {
            try { tab.close(); } catch (_) {}
        }, IS_TOUCH ? TAB_CLOSE_DELAY_MS * 2 : TAB_CLOSE_DELAY_MS);

        return tab;
    }

    // builds the url to try for a given attempt number.
    // each retry strips one layer of params to try to get past ao3 blocking:
    //   attempt 1 — ?view_adult=true&view_full_work=true
    //   attempt 2 — ?view_adult=true only
    //   attempt 3+ — bare base url
    function urlForAttempt(url, attempt) {
        if (attempt === 1) return url;
        if (attempt === 2) return url.split('?')[0] + '?view_adult=true';
        return url.split('?')[0];
    }

    // sends a url via the tab method and verifies with cdx.
    // each retry uses a simpler url in case ao3 is blocking the parameterised form.
    function saveViaTab(url) {
        return new Promise(function (resolve, reject) {
            var attempt = 0;
            // touch devices need a longer cdx wait to match the extended tab lifetime
            var cdxDelay = IS_TOUCH ? CDX_CHECK_DELAY_MS * 2 : CDX_CHECK_DELAY_MS;

            function tryOnce() {
                attempt++;
                var attemptUrl = urlForAttempt(url, attempt);
                console.log('[AO3→Wayback] tab attempt', attempt, 'of', maxRetries() + 1, ':', attemptUrl);

                try {
                    openSaveTab(attemptUrl);
                } catch (e) {
                    var openErr = 'GM_openInTab failed for ' + attemptUrl + ': ' + String(e);
                    logError('saveViaTab:open', openErr);
                    reject(new Error(openErr));
                    return;
                }

                // persist so the next page can resume the cdx check if
                // ao3 navigates away before the timeout fires
                var checkAfter = Date.now() + cdxDelay;
                addPendingItem({ type: 'tab', url: url, attemptUrl: attemptUrl, checkAfter: checkAfter, startedAt: Date.now() });

                setTimeout(function () {
                    checkCdx(url).then(function (found) {
                        removePendingItem('tab', url);
                        if (found) {
                            resolve({ url: attemptUrl, method: 'tab' });
                        } else if (attempt <= maxRetries()) {
                            var nextUrl = urlForAttempt(url, attempt + 1);
                            console.log('[AO3→Wayback] cdx miss, next attempt will try:', nextUrl);
                            showBanner(
                                '🔁 Wayback did not save it (attempt ' + attempt + '/' +
                                (maxRetries() + 1) + ') -- retrying...',
                                'info',
                                retryDelayMs() + 5000
                            );
                            setTimeout(tryOnce, retryDelayMs());
                        } else {
                            var missMsg = 'no cdx snapshot found for ' + url +
                                ' after ' + attempt + ' attempt(s)' +
                                ' -- ao3 is likely blocking wayback at the ip level.' +
                                ' adding ia api keys (see settings) enables headless-browser capture' +
                                ' which may help, but an ip block cannot be bypassed from a userscript.';
                            logError('saveViaTab:cdx-miss', missMsg);
                            reject(new Error(missMsg));
                        }
                    });
                }, cdxDelay);
            }

            tryOnce();
        });
    }

    // main entry point — uses spn2 if ia credentials are set, tab method otherwise
    function saveToWayback(url) {
        if (settings.iaAccessKey && settings.iaSecretKey) {
            console.log('[AO3→Wayback] using spn2 api for:', url);
            return saveViaSPN2(url);
        }
        console.log('[AO3→Wayback] using tab method for:', url);
        return saveViaTab(url);
    }

    var _hasRun = false;

    // on touch devices we archive urls one at a time — opening multiple
    // foreground tabs at once is disorienting and the browser may suspend
    // earlier ones. on desktop we run them all in parallel.
    function archiveAll(urls) {
        if (_hasRun) return;
        _hasRun = true;
        setTimeout(function () { _hasRun = false; }, 5000);

        var urlArray = Array.from(urls);
        var count = urlArray.length;
        var noun = count === 1 ? 'fic' : 'fics';
        var usingSPN2 = !!(settings.iaAccessKey && settings.iaSecretKey);

        if (usingSPN2) {
            showBanner('📡 Sending ' + count + ' ' + noun + ' to IA API... (no tab will open)', 'info', 30000);
        } else {
            showBanner(
                '⏳ Saving ' + count + ' ' + noun + ' to the Wayback Machine...' +
                (IS_TOUCH ? ' (check the new tab)' : ''),
                'info',
                300000
            );
        }

        var savePromises;
        if (IS_TOUCH && !usingSPN2 && count > 1) {
            // queue tab saves one at a time on touch devices
            var TAB_QUEUE_DELAY_MS = TAB_CLOSE_DELAY_MS * 2 + 5000;
            savePromises = urlArray.map(function (url, i) {
                return new Promise(function (resolve, reject) {
                    setTimeout(function () {
                        saveToWayback(url).then(resolve, reject);
                    }, i * TAB_QUEUE_DELAY_MS);
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
                msg = '✅ Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.';
                type = 'success';
            } else if (ok.length === 0) {
                msg = '❌ Could not archive ' + count + ' ' + noun +
                    '. AO3 may be blocking Wayback crawler. Open settings gear for error log.';
                type = 'error';
            } else {
                msg = '⚠️ Archived ' + ok.length + '/' + count + ' ' + noun + '. ' +
                    fail.length + ' failed. Open ⚙ → Copy error log.';
                type = 'error';
            }

            showBanner(msg, type, type === 'success' ? 6000 : 12000);
            // persist so the next page the user navigates to also shows the result
            storeResult(type, msg);
        });
    }


    // ================================================================
    // resume pending archives
    // ================================================================
    //
    // called at page load to pick up any jobs that were still running
    // when ao3 navigated away after the bookmark was submitted.

    function resumePendingArchives() {
        var items = loadPending();
        if (items.length === 0) return;

        console.log('[AO3→Wayback] resuming', items.length, 'pending archive(s)');
        showBanner('⏳ Resuming ' + items.length + ' pending archive(s) from last bookmark...', 'info', 15000);

        items.forEach(function (item) {
            if (item.type === 'spn2') {
                pollSpn2Job(
                    item.jobId,
                    item.url,
                    function (result) {
                        removePendingItem('spn2', item.jobId);
                        var m = '✅ Archived to the Wayback Machine.';
                        showBanner(m, 'success');
                        storeResult('success', m);
                    },
                    function (err) {
                        removePendingItem('spn2', item.jobId);
                        logError('resume:spn2', String(err));
                        var m = '❌ Archive failed. Open ⚙ → Copy error log.';
                        showBanner(m, 'error', 10000);
                        storeResult('error', m);
                    }
                );
            } else if (item.type === 'tab') {
                // wait out whatever cdx delay remains, then check
                var delay = Math.max(0, item.checkAfter - Date.now());
                setTimeout(function () {
                    checkCdx(item.url).then(function (found) {
                        removePendingItem('tab', item.url);
                        if (found) {
                            var mOk = '✅ Archived to the Wayback Machine.';
                            showBanner(mOk, 'success');
                            storeResult('success', mOk);
                        } else {
                            logError('resume:tab', 'no cdx snapshot for ' + item.url);
                            var mFail = '❌ No snapshot found. Open ⚙ → Copy error log.';
                            showBanner(mFail, 'error', 10000);
                            storeResult('error', mFail);
                        }
                    });
                }, delay);
            }
        });
    }


    // ================================================================
    // settings ui
    // a ⚙ button at the bottom-right opens a modal panel styled
    // to match ao3's default cream/red colour scheme
    // ================================================================

    function injectSettingsUI(pageData) {

        // ── floating gear button

        var gearBtn = document.createElement('button');
        gearBtn.id = 'ao3wayback-settings-btn';
        gearBtn.title = 'AO3 to Wayback Machine — Settings';
        gearBtn.textContent = '⚙';
        Object.assign(gearBtn.style, {
            position: 'fixed',
            bottom: '18px',
            right: '18px',
            zIndex: '100000',
            width: '40px',
            height: '40px',
            borderRadius: '50%',
            border: '1px solid #7a0000',
            background: '#900',
            color: '#fff',
            fontSize: '18px',
            lineHeight: '1',
            padding: '0',
            cursor: 'pointer',
            boxShadow: '0 2px 6px rgba(0,0,0,0.4)',
        });
        document.body.appendChild(gearBtn);


        // ── modal overlay

        var overlay = document.createElement('div');
        overlay.id = 'ao3wayback-modal';
        Object.assign(overlay.style, {
            display: 'none',
            position: 'fixed',
            top: '0',
            right: '0',
            bottom: '0',
            left: '0',
            zIndex: '100001',
            background: 'rgba(0,0,0,0.55)',
            alignItems: 'center',
            justifyContent: 'center',
        });
        document.body.appendChild(overlay);


        // ── modal box

        var box = document.createElement('div');
        Object.assign(box.style, {
            position: 'relative',
            background: '#fffbf0',
            color: '#2a2a2a',
            borderRadius: '8px',
            padding: '24px 28px 20px',
            width: '340px',
            maxWidth: '90vw',
            boxShadow: '0 4px 24px rgba(0,0,0,0.35)',
            fontFamily: 'Georgia, "Times New Roman", serif',
            fontSize: '14px',
        });
        overlay.appendChild(box);


        // ── close button

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        Object.assign(closeBtn.style, {
            position: 'absolute',
            top: '14px',
            right: '16px',
            background: 'none',
            border: 'none',
            fontSize: '16px',
            color: '#666',
            cursor: 'pointer',
            padding: '0',
            lineHeight: '1',
        });
        box.appendChild(closeBtn);


        // ── title

        var titleEl = document.createElement('h2');
        titleEl.textContent = 'AO3 to Wayback Machine';
        Object.assign(titleEl.style, {
            margin: '0 0 16px',
            paddingBottom: '10px',
            fontSize: '16px',
            color: '#900',
            borderBottom: '1px solid #ccc',
        });
        box.appendChild(titleEl);


        // ── helper: section heading

        function sectionHead(text) {
            var el = document.createElement('div');
            el.textContent = text;
            Object.assign(el.style, {
                fontWeight: 'bold',
                marginBottom: '6px',
                marginTop: '14px',
            });
            return el;
        }


        // ── checkbox: archive plain url

        box.appendChild(sectionHead('Options'));

        var plainUrlCheck = document.createElement('input');
        plainUrlCheck.type = 'checkbox';
        plainUrlCheck.id = 'ao3wayback-plain-url';
        plainUrlCheck.checked = settings.alsoArchivePlainUrl;

        var plainUrlLabel = document.createElement('label');
        plainUrlLabel.htmlFor = 'ao3wayback-plain-url';
        Object.assign(plainUrlLabel.style, {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            cursor: 'pointer',
        });
        plainUrlLabel.appendChild(plainUrlCheck);
        var plainUrlSpan = document.createElement('span');
        plainUrlSpan.textContent = 'Also archive URL without view params';
        plainUrlLabel.appendChild(plainUrlSpan);
        box.appendChild(plainUrlLabel);


        // ── radio: date format

        box.appendChild(sectionHead('Date format'));

        var DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
        var dateFormatRadios = {};
        var fmtGroup = document.createElement('div');
        fmtGroup.style.paddingLeft = '4px';

        DATE_FORMATS.forEach(function (fmt) {
            var radio = document.createElement('input');
            radio.type = 'radio';
            radio.name = 'ao3wayback-datefmt';
            radio.value = fmt;
            radio.id = 'ao3wayback-fmt-' + fmt;
            radio.checked = settings.dateFormat === fmt;
            dateFormatRadios[fmt] = radio;

            var lbl = document.createElement('label');
            lbl.htmlFor = radio.id;
            Object.assign(lbl.style, {
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                cursor: 'pointer',
                marginBottom: '4px',
            });
            lbl.appendChild(radio);
            var span = document.createElement('span');
            span.textContent = fmt;
            lbl.appendChild(span);
            fmtGroup.appendChild(lbl);
        });
        box.appendChild(fmtGroup);


        // ── text: note label

        box.appendChild(sectionHead('Note label'));

        var noteLabelInput = document.createElement('input');
        noteLabelInput.type = 'text';
        noteLabelInput.value = settings.noteDivider;
        Object.assign(noteLabelInput.style, {
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            fontFamily: 'monospace',
            background: '#fff',
            color: '#2a2a2a',
            marginTop: '4px',
        });
        box.appendChild(noteLabelInput);


        // ── internet archive api keys (optional but recommended)
        box.appendChild(sectionHead('Internet Archive API (optional)'));

        var iaNote = document.createElement('p');
        iaNote.textContent = 'Add your free IA S3 keys to use the SPN2 API. ' +
            'This fixes the "job failed" / 404 errors from AO3 blocking ' +
            "Wayback's crawler. Get keys at archive.org/account/s3.php";
        Object.assign(iaNote.style, {
            margin: '4px 0 8px',
            fontSize: '12px',
            color: '#666',
            lineHeight: '1.4',
        });
        box.appendChild(iaNote);

        var accessKeyInput = document.createElement('input');
        accessKeyInput.type = 'text';
        accessKeyInput.id = 'ao3wayback-ia-access';
        accessKeyInput.placeholder = 'Access key';
        accessKeyInput.value = settings.iaAccessKey || '';
        accessKeyInput.autocomplete = 'off';
        Object.assign(accessKeyInput.style, {
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            fontFamily: 'monospace',
            background: '#fff',
            color: '#2a2a2a',
            marginBottom: '6px',
        });
        box.appendChild(accessKeyInput);

        var secretKeyInput = document.createElement('input');
        secretKeyInput.type = 'password';
        secretKeyInput.id = 'ao3wayback-ia-secret';
        secretKeyInput.placeholder = 'Secret key';
        secretKeyInput.value = settings.iaSecretKey || '';
        secretKeyInput.autocomplete = 'off';
        Object.assign(secretKeyInput.style, {
            width: '100%',
            boxSizing: 'border-box',
            padding: '6px 8px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            fontFamily: 'monospace',
            background: '#fff',
            color: '#2a2a2a',
            marginBottom: '4px',
        });
        box.appendChild(secretKeyInput);

        // ── retry settings
        box.appendChild(sectionHead('Retry settings'));

        var retryRow = document.createElement('div');
        Object.assign(retryRow.style, {
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
            marginBottom: '10px',
        });

        var retriesLabel = document.createElement('label');
        retriesLabel.textContent = 'Max retries';
        retriesLabel.htmlFor = 'ao3wayback-retries';
        retriesLabel.style.whiteSpace = 'nowrap';

        var retriesInput = document.createElement('input');
        retriesInput.type = 'number';
        retriesInput.id = 'ao3wayback-retries';
        retriesInput.min = '0';
        retriesInput.max = '5';
        retriesInput.value = String(settings.maxRetries);
        Object.assign(retriesInput.style, {
            width: '52px',
            padding: '4px 6px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            background: '#fff',
            color: '#2a2a2a',
        });

        var delayLabel = document.createElement('label');
        delayLabel.textContent = 'Retry delay (s)';
        delayLabel.htmlFor = 'ao3wayback-retrydelay';
        delayLabel.style.whiteSpace = 'nowrap';

        var delayInput = document.createElement('input');
        delayInput.type = 'number';
        delayInput.id = 'ao3wayback-retrydelay';
        delayInput.min = '10';
        delayInput.max = '120';
        delayInput.value = String(settings.retryDelayMs / 1000);
        Object.assign(delayInput.style, {
            width: '52px',
            padding: '4px 6px',
            border: '1px solid #ccc',
            borderRadius: '4px',
            fontSize: '13px',
            background: '#fff',
            color: '#2a2a2a',
        });

        retryRow.appendChild(retriesLabel);
        retryRow.appendChild(retriesInput);
        retryRow.appendChild(delayLabel);
        retryRow.appendChild(delayInput);
        box.appendChild(retryRow);

        // ── error log button

        box.appendChild(sectionHead('Diagnostics'));

        var logBtn = document.createElement('button');
        Object.assign(logBtn.style, {
            padding: '6px 12px',
            borderRadius: '4px',
            fontSize: '13px',
            cursor: 'pointer',
            border: '1px solid #aaa',
            background: '#f5f5f5',
            color: '#2a2a2a',
            marginTop: '4px',
            marginBottom: '18px',
            width: '100%',
        });
        logBtn.title = 'Copies a JSON error log to your clipboard. Paste it into a GitHub issue.';
        logBtn.addEventListener('click', function () {
            exportErrorLog();
        });
        box.appendChild(logBtn);


        // ── save / cancel row

        var btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display: 'flex',
            gap: '10px',
            justifyContent: 'flex-end',
        });

        function makeActionBtn(text, primary) {
            var b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding: '6px 16px',
                borderRadius: '4px',
                fontSize: '13px',
                cursor: 'pointer',
                border: primary ? 'none' : '1px solid #aaa',
                background: primary ? '#900' : '#f5f5f5',
                color: primary ? '#fff' : '#2a2a2a',
                fontWeight: primary ? 'bold' : 'normal',
            });
            return b;
        }

        var cancelActionBtn = makeActionBtn('Cancel', false);
        var saveActionBtn = makeActionBtn('Save', true);
        btnRow.appendChild(cancelActionBtn);
        btnRow.appendChild(saveActionBtn);
        box.appendChild(btnRow);


        // ── open / close logic

        function openModal() {
            plainUrlCheck.checked = settings.alsoArchivePlainUrl;
            DATE_FORMATS.forEach(function (fmt) {
                dateFormatRadios[fmt].checked = settings.dateFormat === fmt;
            });
            noteLabelInput.value = settings.noteDivider;
            retriesInput.value = String(settings.maxRetries);
            delayInput.value = String(settings.retryDelayMs / 1000);
            accessKeyInput.value = settings.iaAccessKey || '';
            secretKeyInput.value = settings.iaSecretKey || '';
            logBtn.textContent = '📋 Copy error log (' + _errorLog.length + ' entr' +
                (_errorLog.length === 1 ? 'y' : 'ies') + ')';
            overlay.style.display = 'flex';
        }

        function closeModal() {
            overlay.style.display = 'none';
        }

        gearBtn.addEventListener('click', openModal);
        closeBtn.addEventListener('click', closeModal);
        cancelActionBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        saveActionBtn.addEventListener('click', function () {
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
            showBanner('✅ Settings saved.', 'success');

            if (document.getElementById('bookmark_notes')) {
                injectBookmarkNote(pageData);
            }
        });
    }


    // ================================================================
    // init
    // ================================================================

    var pageData = collectPageData();

    // inject the note whenever the textarea appears — ao3 loads the
    // bookmark form via ajax so i need a mutationobserver
    function onNodeAdded(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        var field = node.id === 'bookmark_notes'
            ? node
            : (node.querySelector ? node.querySelector('#bookmark_notes') : null);
        if (field) injectBookmarkNote(pageData);
    }

    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(onNodeAdded);
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    if (document.getElementById('bookmark_notes')) {
        injectBookmarkNote(pageData);
    }

    // trigger archiving when the bookmark form is submitted
    window.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.action) return;
        var isBookmarkForm =
            /\/bookmarks/.test(form.action) ||
            form.id === 'new_bookmark' ||
            form.classList.contains('bookmark-form');
        if (isBookmarkForm && pageData.urls.size > 0) {
            console.log('[AO3→Wayback] bookmark form submitted, archiving', pageData.urls.size, 'url(s)');
            archiveAll(pageData.urls);
        } else {
            console.log('[AO3→Wayback] form submitted but not a bookmark form or no urls:', form.action);
        }
    }, true);

    injectSettingsUI(pageData);

    // check for any pending archives left over from previous page
    resumePendingArchives();

    // show the final result from the previous page (if any).
    // i delay 100ms so the DOM is fully settled before the banner appears,
    // and to avoid a race condition where a result written milliseconds ago
    // on this same page-load might slip through the timestamp guard.
    setTimeout(checkAndShowStoredResult, 100);

})();
