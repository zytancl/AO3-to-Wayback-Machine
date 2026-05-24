// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them, and fills the bookmark notes field with archive links, author(s), and date.
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
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      GPL-3.0
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // SETTINGS — stored with GM_getValue/GM_setValue.
    // Edit via the ⚙ button at the bottom-right of any AO3 page.
    // ================================================================

    var SETTINGS_KEY = 'ao3wayback_settings';

    var DEFAULTS = {
        alsoArchivePlainUrl: false,
        dateFormat: 'DD/MM/YYYY',
        noteDivider: 'Last Bookmarked: ',
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
    // ERROR LOG
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
            version: '1.3',
            userAgent: navigator.userAgent,
            exportedAt: new Date().toISOString(),
            errors: _errorLog,
        }, null, 2);

        // Copy to clipboard (works in all modern browsers including Safari).
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

    // Textarea-based clipboard fallback for older browsers or restricted contexts.
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
            showBanner('❌ Could not copy log. Check the browser console.', 'error');
        }
        document.body.removeChild(ta);
    }


    // ================================================================
    // URL UTILITIES
    // ================================================================

    var MIRROR_DOMAINS = [
        'archiveofourown.com',
        'archiveofourown.net',
        'archiveofourown.gay',
        'ao3.org',
        'archive.transformativeworks.org',
        'insecure.archiveofourown.org',
    ];

    // Normalise any official mirror domain to archiveofourown.org so the
    // canonical URL is always what gets sent to the Wayback Machine.
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

    // Build a Wayback wildcard link href for an AO3 URL.
    //
    // The Wayback Machine stores URLs with literal ? and & in the path, so
    // using %3F/%26 causes the calendar to return zero results. Instead:
    //   - keep ? as-is (safe in an href path)
    //   - encode & as &amp; (correct HTML attribute escaping — the browser
    //     decodes &amp; to & before following the link, so Wayback receives
    //     the canonical URL it has on record)
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
    // PAGE DATA COLLECTION
    // Returns { isSeries, series, works, urls }
    //   series — { title, author, url } | null
    //   works  — [{ title, author, url }]
    //   urls   — Set of canonical URLs to archive
    // ================================================================

    function collectPageData() {
        var href = window.location.href;
        var isSeries = /\/series\/\d+/.test(href);
        var series = null;
        var works = [];
        var urls = new Set();

        if (isSeries) {
            // --- Series page ---

            // Series title and author.
            var h2 = document.querySelector('h2.heading');
            var seriesTitle = h2 ? h2.textContent.trim() : document.title;
            var seriesAuthorEl = document.querySelector('.series.meta.group dd');
            var seriesAuthor = seriesAuthorEl ? seriesAuthorEl.textContent.trim() : '';
            var seriesUrl = canonicaliseHost(href.split('?')[0]);

            series = { title: seriesTitle, author: seriesAuthor, url: seriesUrl };
            urls.add(seriesUrl);

            // Individual works listed in the series blurbs.
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
            // --- Single work page ---

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
    // BOOKMARK NOTE INJECTION
    // ================================================================

    function injectBookmarkNote(pageData) {
        var field = document.getElementById('bookmark_notes');
        if (!field) return;

        var date = formatDate();
        var lines = [];

        if (pageData.isSeries && pageData.series) {
            // Series line.
            lines.push(
                '<a href="' + waybackHref(pageData.series.url) + '">' +
                pageData.series.title + '</a> by ' + pageData.series.author
            );
            // One line per work in the series.
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

        // Preserve any personal notes above the auto-generated section.
        // On re-edits, only the last line (the date) is refreshed.
        var existing = field.value || '';
        var divIdx = existing.indexOf(settings.noteDivider);
        var userNotes = divIdx !== -1
            ? existing.slice(0, divIdx).trimEnd()
            : existing.trimEnd();

        field.value = userNotes ? userNotes + '\n\n' + noteSnippet : noteSnippet;
    }


    // ================================================================
    // STATUS BANNER
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
    // ARCHIVING
    // ================================================================

    function saveToWayback(url) {
        return new Promise(function (resolve, reject) {
            GM_xmlhttpRequest({
                method: 'GET',
                // Pass the URL as-is — GM_xmlhttpRequest sends it verbatim and
                // the Wayback Machine /save/ endpoint expects a plain URL, not
                // a percent-encoded one.
                url: 'https://web.archive.org/save/' + url,
                onload: function (response) {
                    if (response.status < 400) {
                        resolve(url);
                    } else {
                        var msg = 'HTTP ' + response.status + ' for ' + url;
                        logError('saveToWayback', msg);
                        reject(new Error(msg));
                    }
                },
                onerror: function (err) {
                    var msg = 'Network error for ' + url + ': ' + (err.statusText || 'unknown');
                    logError('saveToWayback', msg);
                    reject(new Error(msg));
                },
                ontimeout: function () {
                    var msg = 'Timed out for ' + url;
                    logError('saveToWayback', msg);
                    reject(new Error(msg));
                },
            });
        });
    }

    var _hasRun = false;

    function archiveAll(urls) {
        if (_hasRun) return;
        _hasRun = true;
        setTimeout(function () { _hasRun = false; }, 5000);

        var count = urls.size;
        var noun = count === 1 ? 'fic' : 'fics';

        showBanner('⏳ Sending ' + count + ' ' + noun + ' to the Wayback Machine…', 'info', 30000);

        Promise.allSettled(Array.from(urls).map(saveToWayback))
            .then(function (results) {
                var ok = results.filter(function (r) { return r.status === 'fulfilled'; });
                var fail = results.filter(function (r) { return r.status === 'rejected'; });

                if (fail.length === 0) {
                    showBanner('✅ Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.', 'success');
                } else if (ok.length === 0) {
                    showBanner('❌ Failed to archive ' + fail.length + ' ' + noun + '. Open ⚙ for the error log.', 'error', 10000);
                } else {
                    showBanner('⚠️ Archived ' + ok.length + '/' + count + ' ' + noun + '. ' + fail.length + ' failed. Open ⚙ for the error log.', 'error', 10000);
                }
            });
    }


    // ================================================================
    // SETTINGS UI
    // ================================================================

    function injectSettingsUI(pageData) {

        // ---- Floating gear button ----------------------------------------

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


        // ---- Modal overlay -----------------------------------------------

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


        // ---- Modal box ---------------------------------------------------

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


        // ---- Close button ------------------------------------------------

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


        // ---- Title -------------------------------------------------------

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


        // ---- Helper: section heading ------------------------------------

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


        // ---- Checkbox: archive plain URL --------------------------------

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
        var plainUrlText = document.createElement('span');
        plainUrlText.textContent = 'Also archive URL without view params';
        plainUrlLabel.appendChild(plainUrlText);
        box.appendChild(plainUrlLabel);


        // ---- Radio: date format -----------------------------------------

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


        // ---- Text: note label -------------------------------------------

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
        });
        box.appendChild(noteLabelInput);


        // ---- Error log button -------------------------------------------

        box.appendChild(sectionHead('Diagnostics'));

        var logBtn = document.createElement('button');
        logBtn.textContent = '📋 Copy error log';
        Object.assign(logBtn.style, {
            padding: '6px 12px',
            borderRadius: '4px',
            fontSize: '13px',
            cursor: 'pointer',
            border: '1px solid #aaa',
            background: '#f5f5f5',
            color: '#2a2a2a',
            marginBottom: '18px',
            width: '100%',
        });
        logBtn.title = 'Copies a JSON error log to your clipboard. Paste it into a GitHub issue.';
        logBtn.addEventListener('click', function () {
            exportErrorLog();
        });
        box.appendChild(logBtn);


        // ---- Save / Cancel row ------------------------------------------

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


        // ---- Open / close logic -----------------------------------------

        function openModal() {
            plainUrlCheck.checked = settings.alsoArchivePlainUrl;
            DATE_FORMATS.forEach(function (fmt) {
                dateFormatRadios[fmt].checked = settings.dateFormat === fmt;
            });
            noteLabelInput.value = settings.noteDivider;
            // Update the log button label with current count.
            logBtn.textContent = '📋 Copy error log (' + _errorLog.length + ' entr' + (_errorLog.length === 1 ? 'y' : 'ies') + ')';
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
            };

            saveSettings(updated);
            settings = updated;
            closeModal();
            showBanner('✅ Settings saved.', 'success');

            // Re-inject the note immediately with updated settings.
            if (document.getElementById('bookmark_notes')) {
                injectBookmarkNote(pageData);
            }
        });
    }


    // ================================================================
    // INIT
    // ================================================================

    var pageData = collectPageData();

    // Inject the bookmark note whenever the notes textarea appears.
    // AO3 loads the bookmark form via AJAX, so a MutationObserver is needed.
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

    // Trigger archiving on bookmark form submission.
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
