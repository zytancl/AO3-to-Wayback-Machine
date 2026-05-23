// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them, and fills the bookmark notes field with an archive link, author, and date.
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
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// @license      GNU GPL-3
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // SETTINGS
    // Stored persistently with GM_getValue / GM_setValue.
    // Edit via the ⚙ button injected at the bottom-right of the page.
    // ================================================================

    var SETTINGS_KEY = 'ao3wayback_settings';

    var DEFAULTS = {
        alsoArchivePlainUrl: false,
        dateFormat:          'DD/MM/YYYY',
        noteDivider:         'Last Bookmarked: ',
    };

    function loadSettings() {
        try {
            var raw = GM_getValue(SETTINGS_KEY, null);
            if (raw) {
                return Object.assign({}, DEFAULTS, JSON.parse(raw));
            }
        } catch (_) {}
        return Object.assign({}, DEFAULTS);
    }

    function saveSettings(s) {
        GM_setValue(SETTINGS_KEY, JSON.stringify(s));
    }

    // Live config object used throughout the script.
    var settings = loadSettings();


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
        } catch (_) {
            return url;
        }
    }

    function formatDate() {
        var d    = new Date();
        var dd   = String(d.getDate()).padStart(2, '0');
        var mm   = String(d.getMonth() + 1).padStart(2, '0');
        var yyyy = String(d.getFullYear());
        return settings.dateFormat
            .replace('YYYY', yyyy)
            .replace('MM', mm)
            .replace('DD', dd);
    }

    // Collect the AO3 URLs to archive from the current page.
    function collectUrls() {
        var urls   = new Set();
        var href   = window.location.href;
        var isSeries = /\/series\/\d+/.test(href);

        if (isSeries) {
            document.querySelectorAll('.work.blurb.group').forEach(function (blurb) {
                var link = blurb.querySelector('a[href*="/works/"]');
                if (link) {
                    var raw = new URL(
                        link.getAttribute('href').split('?')[0].replace(/\/chapters\/\d+/, ''),
                        window.location.origin
                    ).toString();
                    urls.add(canonicaliseHost(raw) + '?view_adult=true&view_full_work=true');
                }
            });
        } else {
            var raw  = href.split('?')[0].replace(/\/chapters\/\d+/, '');
            var base = canonicaliseHost(raw);
            urls.add(base + '?view_adult=true&view_full_work=true');
            if (settings.alsoArchivePlainUrl) {
                urls.add(base);
            }
        }

        return urls;
    }

    // Extract page title and author(s).
    function getPageMeta() {
        var isSeries = /\/series\/\d+/.test(window.location.href);
        var title    = '';
        var author   = '';

        if (isSeries) {
            var h2 = document.querySelector('h2.heading');
            title  = h2 ? h2.textContent.trim() : document.title;

            var authorDd = document.querySelector('.series.meta.group dd');
            author = authorDd ? authorDd.textContent.trim() : '';
        } else {
            var titleEl = document.querySelector('h2.title.heading');
            title = titleEl ? titleEl.textContent.trim() : document.title;

            var authorLinks = document.querySelectorAll('.byline.heading [rel="author"]');
            if (authorLinks.length > 0) {
                author = Array.from(authorLinks)
                    .map(function (a) { return a.textContent.trim(); })
                    .join(', ');
            } else {
                var byline = document.querySelector('.byline.heading');
                author = byline ? byline.textContent.trim() : '';
            }
        }

        return { title: title, author: author };
    }


    // ================================================================
    // BOOKMARK NOTE INJECTION
    // ================================================================

    function injectBookmarkNote(urls) {
        var field = document.getElementById('bookmark_notes');
        if (!field) return;

        var meta   = getPageMeta();
        var date   = formatDate();

        // Build a Wayback wildcard URL (web/*/...) so the link always
        // resolves to the most recent snapshot. The ? and & in the AO3
        // query string must be percent-encoded so the browser doesn't
        // treat them as query params belonging to web.archive.org itself.
        var targetUrl  = Array.from(urls)[0];
        var parts      = targetUrl.split('?');
        var encoded    = parts[0] + (parts[1] ? '%3F' + parts[1].replace(/&/g, '%26') : '');
        var waybackUrl = 'https://web.archive.org/web/*/' + encoded;

        var noteSnippet =
            '<a href="' + waybackUrl + '">' + meta.title + '</a> by ' + meta.author +
            '<br>' + settings.noteDivider + date;

        // Preserve any personal notes the user wrote above the auto-generated
        // section, and update only the "Last Bookmarked" line on re-edits.
        var existing     = field.value || '';
        var divIdx       = existing.indexOf(settings.noteDivider);
        var userNotes    = divIdx !== -1
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
            // Offset from the settings button (which sits at right: 18px).
            Object.assign(el.style, {
                position:      'fixed',
                bottom:        '18px',
                right:         '70px',
                zIndex:        '99999',
                maxWidth:      '320px',
                padding:       '10px 15px',
                borderRadius:  '6px',
                fontFamily:    'sans-serif',
                fontSize:      '13px',
                lineHeight:    '1.5',
                boxShadow:     '0 2px 10px rgba(0,0,0,0.3)',
                cursor:        'default',
                transition:    'opacity 0.4s ease',
                opacity:       '0',
                pointerEvents: 'none',
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
        type     = type     || 'info';
        duration = duration || 6000;

        var banner = getOrCreateBanner();
        var theme  = BANNER_THEMES[type] || BANNER_THEMES.info;

        Object.assign(banner.style, theme);
        banner.textContent  = message;
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
                url:    'https://web.archive.org/save/' + url,
                onload: function (response) {
                    if (response.status < 400) {
                        resolve(url);
                    } else {
                        reject(new Error('HTTP ' + response.status));
                    }
                },
                onerror: function (err) {
                    reject(new Error('Network error: ' + (err.statusText || 'unknown')));
                },
                ontimeout: function () {
                    reject(new Error('Timed out'));
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
        var noun  = count === 1 ? 'fic' : 'fics';

        showBanner('⏳ Sending ' + count + ' ' + noun + ' to the Wayback Machine…', 'info', 30000);
        console.log('[AO3→Wayback] Archiving:', Array.from(urls));

        Promise.allSettled(Array.from(urls).map(saveToWayback))
            .then(function (results) {
                var ok   = results.filter(function (r) { return r.status === 'fulfilled'; });
                var fail = results.filter(function (r) { return r.status === 'rejected';  });

                if (fail.length === 0) {
                    showBanner('✅ Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.', 'success');
                    console.log('[AO3→Wayback] Done:', Array.from(urls));
                } else if (ok.length === 0) {
                    showBanner('❌ Failed to archive ' + fail.length + ' ' + noun + '. Is the Archive reachable?', 'error');
                    fail.forEach(function (r) { console.warn('[AO3→Wayback] Error:', r.reason); });
                } else {
                    showBanner('⚠️ Archived ' + ok.length + '/' + count + ' ' + noun + '. ' + fail.length + ' failed — see console.', 'error');
                    fail.forEach(function (r) { console.warn('[AO3→Wayback] Error:', r.reason); });
                }
            });
    }


    // ================================================================
    // SETTINGS UI
    // A ⚙ button injected at the bottom-right opens a modal panel
    // styled to match AO3's default cream/red colour scheme.
    // ================================================================

    function injectSettingsUI() {

        // ---- Floating gear button ----------------------------------------

        var gearBtn = document.createElement('button');
        gearBtn.id    = 'ao3wayback-settings-btn';
        gearBtn.title = 'AO3 to Wayback Machine — Settings';
        gearBtn.textContent = '⚙';
        Object.assign(gearBtn.style, {
            position:     'fixed',
            bottom:       '18px',
            right:        '18px',
            zIndex:       '100000',
            width:        '40px',
            height:       '40px',
            borderRadius: '50%',
            border:       '1px solid #7a0000',
            background:   '#900',
            color:        '#fff',
            fontSize:     '18px',
            lineHeight:   '1',
            padding:      '0',
            cursor:       'pointer',
            boxShadow:    '0 2px 6px rgba(0,0,0,0.4)',
        });
        document.body.appendChild(gearBtn);


        // ---- Modal overlay -----------------------------------------------

        var overlay = document.createElement('div');
        overlay.id  = 'ao3wayback-modal';
        Object.assign(overlay.style, {
            display:        'none',
            position:       'fixed',
            top:            '0',
            right:          '0',
            bottom:         '0',
            left:           '0',
            zIndex:         '100001',
            background:     'rgba(0,0,0,0.55)',
            alignItems:     'center',
            justifyContent: 'center',
        });
        document.body.appendChild(overlay);


        // ---- Modal box ---------------------------------------------------

        var box = document.createElement('div');
        Object.assign(box.style, {
            position:     'relative',
            background:   '#fffbf0',
            color:        '#2a2a2a',
            borderRadius: '8px',
            padding:      '24px 28px 20px',
            width:        '340px',
            maxWidth:     '90vw',
            boxShadow:    '0 4px 24px rgba(0,0,0,0.35)',
            fontFamily:   'Georgia, "Times New Roman", serif',
            fontSize:     '14px',
        });
        overlay.appendChild(box);


        // ---- Title -------------------------------------------------------

        var titleEl = document.createElement('h2');
        titleEl.textContent = 'AO3 to Wayback Machine';
        Object.assign(titleEl.style, {
            margin:        '0 0 16px',
            paddingBottom: '10px',
            fontSize:      '16px',
            color:         '#900',
            borderBottom:  '1px solid #ccc',
        });
        box.appendChild(titleEl);


        // ---- Close button ------------------------------------------------

        var closeBtn = document.createElement('button');
        closeBtn.textContent = '✕';
        Object.assign(closeBtn.style, {
            position:   'absolute',
            top:        '14px',
            right:      '16px',
            background: 'none',
            border:     'none',
            fontSize:   '16px',
            color:      '#666',
            cursor:     'pointer',
            padding:    '0',
            lineHeight: '1',
        });
        box.appendChild(closeBtn);


        // ---- Helper: section heading ------------------------------------

        function sectionHead(text) {
            var el = document.createElement('div');
            el.textContent = text;
            Object.assign(el.style, {
                fontWeight:   'bold',
                marginBottom: '6px',
                marginTop:    '14px',
            });
            return el;
        }


        // ---- Checkbox: archive plain URL --------------------------------

        var plainUrlCheck    = document.createElement('input');
        plainUrlCheck.type    = 'checkbox';
        plainUrlCheck.id      = 'ao3wayback-plain-url';
        plainUrlCheck.checked = settings.alsoArchivePlainUrl;

        var plainUrlLabel = document.createElement('label');
        plainUrlLabel.htmlFor = 'ao3wayback-plain-url';
        Object.assign(plainUrlLabel.style, {
            display:    'flex',
            alignItems: 'center',
            gap:        '8px',
            cursor:     'pointer',
        });
        plainUrlLabel.appendChild(plainUrlCheck);
        var plainUrlText = document.createElement('span');
        plainUrlText.textContent = 'Also archive URL without view params';
        plainUrlLabel.appendChild(plainUrlText);
        box.appendChild(plainUrlLabel);


        // ---- Radio: date format -----------------------------------------

        box.appendChild(sectionHead('Date format'));

        var DATE_FORMATS   = ['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD'];
        var dateFormatRadios = {};
        var fmtGroup = document.createElement('div');
        Object.assign(fmtGroup.style, { paddingLeft: '4px' });

        DATE_FORMATS.forEach(function (fmt) {
            var radio    = document.createElement('input');
            radio.type   = 'radio';
            radio.name   = 'ao3wayback-datefmt';
            radio.value  = fmt;
            radio.id     = 'ao3wayback-fmt-' + fmt;
            radio.checked = settings.dateFormat === fmt;
            dateFormatRadios[fmt] = radio;

            var lbl = document.createElement('label');
            lbl.htmlFor = radio.id;
            Object.assign(lbl.style, {
                display:       'flex',
                alignItems:    'center',
                gap:           '8px',
                cursor:        'pointer',
                marginBottom:  '4px',
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
        noteLabelInput.type  = 'text';
        noteLabelInput.value = settings.noteDivider;
        Object.assign(noteLabelInput.style, {
            width:       '100%',
            boxSizing:   'border-box',
            padding:     '6px 8px',
            border:      '1px solid #ccc',
            borderRadius:'4px',
            fontSize:    '13px',
            fontFamily:  'monospace',
            marginBottom:'18px',
            background:  '#fff',
            color:       '#2a2a2a',
        });
        box.appendChild(noteLabelInput);


        // ---- Save / Cancel row ------------------------------------------

        var btnRow = document.createElement('div');
        Object.assign(btnRow.style, {
            display:        'flex',
            gap:            '10px',
            justifyContent: 'flex-end',
        });

        function makeActionBtn(text, primary) {
            var b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, {
                padding:      '6px 16px',
                borderRadius: '4px',
                fontSize:     '13px',
                cursor:       'pointer',
                border:       primary ? 'none' : '1px solid #aaa',
                background:   primary ? '#900' : '#f5f5f5',
                color:        primary ? '#fff' : '#2a2a2a',
                fontWeight:   primary ? 'bold' : 'normal',
            });
            return b;
        }

        var cancelActionBtn = makeActionBtn('Cancel', false);
        var saveActionBtn   = makeActionBtn('Save',   true);
        btnRow.appendChild(cancelActionBtn);
        btnRow.appendChild(saveActionBtn);
        box.appendChild(btnRow);


        // ---- Open / close logic -----------------------------------------

        function openModal() {
            // Re-sync UI to current settings each time it's opened.
            plainUrlCheck.checked = settings.alsoArchivePlainUrl;
            DATE_FORMATS.forEach(function (fmt) {
                dateFormatRadios[fmt].checked = settings.dateFormat === fmt;
            });
            noteLabelInput.value = settings.noteDivider;
            overlay.style.display = 'flex';
        }

        function closeModal() {
            overlay.style.display = 'none';
        }

        gearBtn.addEventListener('click',  openModal);
        closeBtn.addEventListener('click', closeModal);
        cancelActionBtn.addEventListener('click', closeModal);

        // Close when clicking outside the box.
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        saveActionBtn.addEventListener('click', function () {
            var selectedFmt = DATE_FORMATS.find(function (fmt) {
                return dateFormatRadios[fmt].checked;
            }) || DEFAULTS.dateFormat;

            var updated = {
                alsoArchivePlainUrl: plainUrlCheck.checked,
                dateFormat:          selectedFmt,
                noteDivider:         noteLabelInput.value.trim() || DEFAULTS.noteDivider,
            };

            saveSettings(updated);
            settings = updated;   // update the live config
            closeModal();
            showBanner('✅ Settings saved.', 'success');
        });
    }


    // ================================================================
    // INIT
    // ================================================================

    var urls = collectUrls();

    // Inject the bookmark note whenever the notes field appears in the DOM.
    // AO3 loads the bookmark form via AJAX so a MutationObserver is needed.
    function onNodeAdded(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        var field = node.id === 'bookmark_notes'
            ? node
            : node.querySelector && node.querySelector('#bookmark_notes');
        if (field) injectBookmarkNote(urls);
    }

    var observer = new MutationObserver(function (mutations) {
        mutations.forEach(function (mutation) {
            mutation.addedNodes.forEach(onNodeAdded);
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also run immediately in case the form is already present at load time.
    if (document.getElementById('bookmark_notes')) {
        injectBookmarkNote(urls);
    }

    // Trigger archiving when the bookmark form is submitted.
    window.addEventListener('submit', function (e) {
        var form = e.target;
        if (!form || !form.action) return;
        var isBookmarkForm =
            /\/bookmarks/.test(form.action) ||
            form.id === 'new_bookmark' ||
            form.classList.contains('bookmark-form');
        if (isBookmarkForm && urls.size > 0) {
            archiveAll(urls);
        }
    }, true);

    injectSettingsUI();

})();
