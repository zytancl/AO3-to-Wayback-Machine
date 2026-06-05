// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them, and fills the bookmark notes field with archive links, author(s), and date. Settings are accessible via the ⚙ button at the bottom-right of any AO3 page.
// @version      1.2
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
            version: '2.4',
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
    function checkCdx(url) {
        return new Promise(function (resolve) {
            var today = new Date();
            var yyyymmdd = String(today.getFullYear()) +
                String(today.getMonth() + 1).padStart(2, '0') +
                String(today.getDate()).padStart(2, '0');

            // matchType=prefix catches any query-param variant wayback stored
            var cdxUrl = 'https://web.archive.org/cdx/search/cdx' +
                '?output=json&limit=1&fl=timestamp&matchType=prefix' +
                '&from=' + yyyymmdd +
                '&url=' + encodeURIComponent(url.split('?')[0]);

            console.log('[AO3→Wayback] CDX check:', cdxUrl);
            GM_xmlhttpRequest({
                method: 'GET',
                url: cdxUrl,
                timeout: 15000,
                onload: function (r) {
                    try {
                        var rows = JSON.parse(r.responseText || '[]');
                        var found = Array.isArray(rows) && rows.length > 1;
                        console.log('[AO3→Wayback] CDX found:', found, 'for', url);
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

    // how long to wait before checking cdx — wayback usually processes
    // saves within ~30s but i give it a bit extra to be safe
    var CDX_CHECK_DELAY_MS = 35000;
    // close the save tab after this long — enough time for wayback to crawl
    var TAB_CLOSE_DELAY_MS = 30000;
    // these read from settings at call time so changes apply without reload
    function maxRetries()   { return settings.maxRetries; }
    function retryDelayMs() { return settings.retryDelayMs; }

    // true when running on a touch device (mobile/tablet).
    // on desktop we open save tabs in the background so they don't interrupt
    // the user. on mobile, background tabs get suspended by the browser before
    // wayback can load them (confirmed on firefox android), so we open them
    // in the foreground instead and let the user navigate back manually.
    var IS_TOUCH = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);

    // opens a save tab for a url and schedules it to close after TAB_CLOSE_DELAY_MS.
    // i use GM_openInTab instead of xhr/fetch because those kept failing —
    // either dropped silently or the ? in the url got split off by the
    // extension's http layer. real browser navigation preserves %3F in the
    // path so the full ao3 url (view params and all) reaches wayback correctly.
    // returns the tab handle so callers can track it if needed.
    function openSaveTab(url) {
        var saveUrl = 'https://web.archive.org/save/' +
            url.replace('?', '%3F').replace(/&/g, '%26');

        console.log('[AO3→Wayback] opening save tab (touch=' + IS_TOUCH + '):', saveUrl);

        // on mobile/tablet open in foreground — background tabs get suspended
        // by the browser before wayback finishes loading, so the save never
        // actually happens. the user will need to navigate back after.
        var tab = GM_openInTab(saveUrl, {
            active: IS_TOUCH,
            insert: true,
        });

        if (IS_TOUCH) {
            // on touch devices we close the tab after a longer delay to give
            // wayback time to fully load before we yank it away
            setTimeout(function () {
                try { tab.close(); } catch (_) {}
            }, TAB_CLOSE_DELAY_MS * 2);
        } else {
            setTimeout(function () {
                try { tab.close(); } catch (_) {}
            }, TAB_CLOSE_DELAY_MS);
        }

        return tab;
    }

    // build the url to try for a given attempt number.
    // each retry strips params to try to get past ao3 blocking wayback:
    //   attempt 1 — full url with both view params
    //   attempt 2 — view_adult only (drop view_full_work)
    //   attempt 3+ — bare base url, no params at all
    // the note already uses a web/*/ wildcard so any of these landing in
    // cdx will make the link work regardless of which variant got saved.
    function urlForAttempt(url, attempt) {
        if (attempt === 1) return url;
        if (attempt === 2) {
            // keep only ?view_adult=true
            var base = url.split('?')[0];
            return base + '?view_adult=true';
        }
        return url.split('?')[0];
    }

    // sends a url to wayback and verifies via cdx. each retry uses a
    // progressively simpler url variant in case ao3 is blocking the
    // parameterised form. resolves with { url } on success, rejects
    // after all attempts are exhausted.
    function saveToWayback(url) {
        return new Promise(function (resolve, reject) {
            var attempt = 0;

            // touch devices need a longer cdx wait to match the extended tab lifetime
            var cdxDelay = IS_TOUCH ? CDX_CHECK_DELAY_MS * 2 : CDX_CHECK_DELAY_MS;

            function tryOnce() {
                attempt++;
                var attemptUrl = urlForAttempt(url, attempt);
                console.log('[AO3→Wayback] attempt', attempt, 'of', maxRetries() + 1,
                    'url:', attemptUrl);

                try {
                    openSaveTab(attemptUrl);
                } catch (e) {
                    var openErr = 'GM_openInTab failed for ' + attemptUrl + ': ' + String(e);
                    logError('saveToWayback:open', openErr);
                    reject(new Error(openErr));
                    return;
                }

                setTimeout(function () {
                    // check cdx for the base url — matches any variant wayback stored
                    checkCdx(url).then(function (found) {
                        if (found) {
                            console.log('[AO3→Wayback] verified after attempt', attempt, ':', attemptUrl);
                            resolve({ url: attemptUrl });
                        } else if (attempt <= maxRetries()) {
                            // still nothing — wayback is probably getting blocked.
                            // next attempt will try a simpler url variant.
                            var nextUrl = urlForAttempt(url, attempt + 1);
                            console.log('[AO3→Wayback] cdx miss, next attempt will try:', nextUrl);
                            showBanner(
                                '🔁 Wayback did not save it (attempt ' + attempt + '/' +
                                (maxRetries() + 1) + ') -- retrying with simpler url...',
                                'info',
                                retryDelayMs() + 5000
                            );
                            setTimeout(tryOnce, retryDelayMs());
                        } else {
                            var missMsg = 'no cdx snapshot found for ' + url +
                                ' after ' + attempt + ' attempt(s)' +
                                ' -- wayback is likely being blocked by ao3';
                            logError('saveToWayback:cdx-miss', missMsg);
                            reject(new Error(missMsg));
                        }
                    });
                }, cdxDelay);
            }

            tryOnce();
        });
    }

    var _hasRun = false;

    // on touch devices we archive urls one at a time with a gap between them.
    // opening multiple foreground tabs at once on mobile is disorienting and
    // the browser may suspend the earlier ones before they finish loading.
    // on desktop we run them all in parallel since they are background tabs.
    function archiveAll(urls) {
        if (_hasRun) return;
        _hasRun = true;
        setTimeout(function () { _hasRun = false; }, 5000);

        var urlArray = Array.from(urls);
        var count = urlArray.length;
        var noun = count === 1 ? 'fic' : 'fics';

        // worst case time: (cdxDelay + retryDelay) * retries * urls
        var perAttempt = (IS_TOUCH ? CDX_CHECK_DELAY_MS * 2 : CDX_CHECK_DELAY_MS) + retryDelayMs();
        var worstCaseSec = Math.ceil((perAttempt * (maxRetries() + 1) * count) / 1000);
        showBanner(
            '⏳ Saving ' + count + ' ' + noun + ' to the Wayback Machine...' +
            (IS_TOUCH ? ' (check the new tab)' : ''),
            'info',
            worstCaseSec * 1000
        );

        if (IS_TOUCH && count > 1) {
            // queue saves one at a time on touch devices — give each tab time
            // to start loading before opening the next one
            var TAB_QUEUE_DELAY_MS = TAB_CLOSE_DELAY_MS * 2 + 5000;
            var promises = urlArray.map(function (url, i) {
                return new Promise(function (resolve, reject) {
                    setTimeout(function () {
                        saveToWayback(url).then(resolve, reject);
                    }, i * TAB_QUEUE_DELAY_MS);
                });
            });

            Promise.allSettled(promises).then(handleResults);
        } else {
            Promise.allSettled(urlArray.map(saveToWayback)).then(handleResults);
        }

        function handleResults(results) {
            var ok = results.filter(function (r) { return r.status === 'fulfilled'; });
            var fail = results.filter(function (r) { return r.status === 'rejected'; });

            if (fail.length === 0) {
                showBanner('✅ Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.', 'success');
            } else if (ok.length === 0) {
                showBanner(
                    '❌ Could not verify archive for ' + count + ' ' + noun +
                    '. Open ⚙ → Copy error log.',
                    'error', 12000
                );
            } else {
                showBanner(
                    '⚠️ Archived ' + ok.length + '/' + count + ' ' + noun + '. ' +
                    fail.length + ' unverified. Open ⚙ → Copy error log.',
                    'error', 10000
                );
            }
        }
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
            archiveAll(pageData.urls);
        }
    }, true);

    injectSettingsUI(pageData);

})();
