// ==UserScript==
// @name         AO3 to Wayback Machine
// @namespace    ao3-wayback-machine
// @description  Automatically saves AO3 fics to the Internet Archive Wayback Machine when you bookmark them, and inserts a note with a Wayback link, author, and bookmark date into the bookmark notes field.
// @version      1.1
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
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    // ================================================================
    // CONFIGURATION
    // ================================================================

    // If true, also archives the plain work URL (without the view params)
    // in addition to the full-work version.
    const ALSO_ARCHIVE_PLAIN_URL = false;

    // Date format for the "Last Bookmarked" note line.
    // Tokens: YYYY = full year, MM = month, DD = day.
    const DATE_FORMAT = 'DD/MM/YYYY';

    // The divider string used to find and update the "Last Bookmarked" line
    // on subsequent bookmark edits. Change only if you need a different label.
    const NOTE_DIVIDER = 'Last Bookmarked: ';

    // Official AO3 mirror hostnames. URLs from any of these are normalised
    // to archiveofourown.org before being sent to the Wayback Machine so
    // the canonical URL is always what gets archived.
    // Source: https://archiveofourown.org/faq/accessing-fanworks#archiveurl
    const MIRROR_DOMAINS = [
        'archiveofourown.com',
        'archiveofourown.net',
        'archiveofourown.gay',
        'ao3.org',
        'archive.transformativeworks.org',
        'insecure.archiveofourown.org',
    ];

    // ================================================================


    // Replaces any mirror hostname with the canonical AO3 hostname so the
    // Wayback Machine always archives the definitive URL.
    function canonicaliseHost(url) {
        try {
            const parsed = new URL(url);
            if (MIRROR_DOMAINS.includes(parsed.hostname)) {
                parsed.hostname = 'archiveofourown.org';
                parsed.protocol = 'https:';
            }
            return parsed.toString();
        } catch (_) {
            return url;
        }
    }


    // Returns today's date formatted according to DATE_FORMAT.
    function formatDate() {
        const d = new Date();
        const dd = String(d.getDate()).padStart(2, '0');
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const yyyy = String(d.getFullYear());
        return DATE_FORMAT
            .replace('YYYY', yyyy)
            .replace('MM', mm)
            .replace('DD', dd);
    }


    // Collects the AO3 URLs to send to the Wayback Machine from the current page.
    // Returns a Set of canonicalised, fully-qualified URLs.
    function collectUrls() {
        const urls = new Set();
        const href = window.location.href;
        const isSeries = /\/series\/\d+/.test(href);

        if (isSeries) {
            // Archive every individual work listed on the series page.
            document.querySelectorAll('.work.blurb.group').forEach(blurb => {
                const link = blurb.querySelector('a[href*="/works/"]');
                if (link) {
                    const raw = new URL(
                        link.getAttribute('href').split('?')[0].replace(/\/chapters\/\d+/, ''),
                        window.location.origin
                    ).toString();
                    urls.add(canonicaliseHost(raw) + '?view_adult=true&view_full_work=true');
                }
            });
        } else {
            // Single work — strip to the root work URL, canonicalise, add params.
            const raw = href
                .split('?')[0]
                .replace(/\/chapters\/\d+/, '');
            const base = canonicaliseHost(raw);
            urls.add(base + '?view_adult=true&view_full_work=true');
            if (ALSO_ARCHIVE_PLAIN_URL) {
                urls.add(base);
            }
        }

        return urls;
    }


    // Extracts the fic title and author name(s) from the current page.
    function getPageMeta() {
        const isSeries = /\/series\/\d+/.test(window.location.href);
        let title = '';
        let author = '';

        if (isSeries) {
            const h2 = document.querySelector('h2.heading');
            title = h2 ? h2.textContent.trim() : document.title;

            // Series author is in the first <dd> of the series meta group.
            const authorDd = document.querySelector('.series.meta.group dd');
            author = authorDd ? authorDd.textContent.trim() : '';
        } else {
            const titleEl = document.querySelector('h2.title.heading');
            title = titleEl ? titleEl.textContent.trim() : document.title;

            // Works may have multiple authors; collect all byline links.
            const authorLinks = document.querySelectorAll('.byline.heading [rel="author"]');
            if (authorLinks.length > 0) {
                author = [...authorLinks].map(a => a.textContent.trim()).join(', ');
            } else {
                const byline = document.querySelector('.byline.heading');
                author = byline ? byline.textContent.trim() : '';
            }
        }

        return { title, author };
    }


    // Builds and injects the auto-generated note into the bookmark notes textarea.
    // Uses the Wayback Machine wildcard URL (web/*/...) so it always points to
    // the most recent snapshot regardless of when it was actually archived.
    function injectBookmarkNote(urls) {
        const field = document.getElementById('bookmark_notes');
        if (!field) return;

        const { title, author } = getPageMeta();
        const date = formatDate();

        // Use the first (or only) canonical work URL for the Wayback link.
        const targetUrl = [...urls][0];
        const waybackUrl = 'https://web.archive.org/web/*/' + targetUrl;

        // The new note snippet to insert/update.
        const noteSnippet =
            '<a href="' + waybackUrl + '">' + title + '</a> by ' + author +
            '<br>' + NOTE_DIVIDER + date;

        // Preserve any text the user wrote above a previous auto-note.
        const existing = field.value || '';
        const dividerIndex = existing.indexOf(NOTE_DIVIDER);
        const userNotes = dividerIndex !== -1
            ? existing.slice(0, dividerIndex).trimEnd()
            : existing.trimEnd();

        field.value = userNotes
            ? userNotes + '\n\n' + noteSnippet
            : noteSnippet;
    }


    // ----------------------------------------------------------------
    // Status banner — small fixed notification in the bottom-right corner.
    // ----------------------------------------------------------------

    function getOrCreateBanner() {
        let el = document.getElementById('ao3-wayback-banner');
        if (!el) {
            el = document.createElement('div');
            el.id = 'ao3-wayback-banner';
            Object.assign(el.style, {
                position: 'fixed',
                bottom: '18px',
                right: '18px',
                zIndex: '99999',
                maxWidth: '340px',
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

    const BANNER_THEMES = {
        info:    { background: '#1e1e2e', color: '#cdd6f4', border: '1px solid #45475a' },
        success: { background: '#1e2e22', color: '#a6e3a1', border: '1px solid #40a04a' },
        error:   { background: '#2e1e1e', color: '#f38ba8', border: '1px solid #a03040' },
    };

    let _bannerTimer = null;

    function showBanner(message, type = 'info', duration = 6000) {
        const banner = getOrCreateBanner();
        const theme = BANNER_THEMES[type] || BANNER_THEMES.info;

        Object.assign(banner.style, theme);
        banner.textContent = message;
        banner.style.opacity = '1';

        clearTimeout(_bannerTimer);
        _bannerTimer = setTimeout(() => {
            banner.style.opacity = '0';
        }, duration);
    }


    // ----------------------------------------------------------------
    // Core: archive everything collected from the page.
    // ----------------------------------------------------------------

    function saveToWayback(url) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url: 'https://web.archive.org/save/' + encodeURIComponent(url),
                onload(response) {
                    if (response.status < 400) {
                        resolve(url);
                    } else {
                        reject(new Error('HTTP ' + response.status));
                    }
                },
                onerror(err) {
                    reject(new Error('Network error: ' + (err.statusText || 'unknown')));
                },
                ontimeout() {
                    reject(new Error('Timed out'));
                },
            });
        });
    }

    let _hasRun = false;

    async function archiveAll(urls) {
        if (_hasRun) return;
        _hasRun = true;

        // Reset the guard after a delay to allow a second save on the same page
        // (e.g. if the user edits and re-submits their bookmark).
        setTimeout(() => { _hasRun = false; }, 5000);

        const count = urls.size;
        const noun = count === 1 ? 'fic' : 'fics';

        showBanner('⏳ Sending ' + count + ' ' + noun + ' to the Wayback Machine…', 'info', 30000);
        console.log('[AO3→Wayback] Archiving:', [...urls]);

        const results = await Promise.allSettled([...urls].map(saveToWayback));

        const ok = results.filter(r => r.status === 'fulfilled');
        const fail = results.filter(r => r.status === 'rejected');

        if (fail.length === 0) {
            showBanner('✅ Archived ' + ok.length + ' ' + noun + ' to the Wayback Machine.', 'success');
            console.log('[AO3→Wayback] Done:', [...urls]);
        } else if (ok.length === 0) {
            showBanner('❌ Failed to archive ' + fail.length + ' ' + noun + '. Is the Archive reachable?', 'error');
            fail.forEach(r => console.warn('[AO3→Wayback] Error:', r.reason));
        } else {
            showBanner('⚠️ Archived ' + ok.length + '/' + count + ' ' + noun + '. ' + fail.length + ' failed — see console.', 'error');
            fail.forEach(r => console.warn('[AO3→Wayback] Error:', r.reason));
        }
    }


    // ----------------------------------------------------------------
    // Bookmark form detection.
    //
    // AO3 loads the bookmark form via AJAX, so we use a MutationObserver
    // to inject the note as soon as the form appears, and a capturing
    // submit listener on window to trigger archiving on submission.
    // ----------------------------------------------------------------

    const urls = collectUrls();

    // Inject the note whenever the bookmark notes field appears in the DOM.
    // This covers both the initial page load (if the form is already present)
    // and AJAX-loaded forms.
    function onNodeAdded(node) {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        // The notes field itself might be the added node, or inside it.
        const field = node.id === 'bookmark_notes'
            ? node
            : node.querySelector('#bookmark_notes');
        if (field) {
            injectBookmarkNote(urls);
        }
    }

    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            mutation.addedNodes.forEach(onNodeAdded);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // Also run immediately in case the form is already in the DOM at load time.
    if (document.getElementById('bookmark_notes')) {
        injectBookmarkNote(urls);
    }

    // Trigger archiving on bookmark form submission.
    window.addEventListener('submit', function (e) {
        const form = e.target;
        if (!form || !form.action) return;

        // AO3 bookmark form actions contain /bookmarks (create, edit, or
        // collection-scoped). The check uses a regex so it works on all
        // mirror domains without needing to enumerate them.
        const isBookmarkForm =
            /\/bookmarks/.test(form.action) ||
            form.id === 'new_bookmark' ||
            form.classList.contains('bookmark-form');

        if (isBookmarkForm && urls.size > 0) {
            archiveAll(urls);
        }
    }, /* useCapture */ true);

})();
