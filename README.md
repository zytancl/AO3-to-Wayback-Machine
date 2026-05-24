# AO3 to Wayback Machine

A userscript that automatically saves AO3 fics to the [Internet Archive Wayback Machine](https://web.archive.org/) when you bookmark them, and fills your bookmark notes with a Wayback link, the fic's author, and the date you bookmarked it.

Expect constant updates because the auto-archive function may randomly stop working.

## Features

- **Auto-archives when bookmarking** - automatically sends the fic to the Wayback Machine everytime you submit a bookmark, no extra clicks needed
- **Archives the full work including rated mature and explicit** - always saves the `?view_adult=true&view_full_work=true` version so the entire fic is captured in one go
- **Auto-fills bookmark notes with info** - fills bookmark note with a Wayback Machine hyperlink to the archived fic, the author's name, and the date bookmarked + when re-bookmarking, the entire auto-generated block is entirely updated and overwritten rather than duplicated
- **Series support** - when bookmarking a series, archives every individual work listed on the series page and adds a line per work to your bookmark notes too
- **Works on all official AO3 domains** - supports mirror sites like `archiveofourown.org`, `.com`, `.net`, `.gay`, `ao3.org`, `archive.transformativeworks.org`, and `insecure.archiveofourown.org` + always archives the official URL regardless of which mirror you're using
- **Status notification** - a small banner appears at the bottom right corner confirming whether archiving succeeded or failed (note: may not be accurate tho)
- **In-page settings panel** - click the ⚙ floating button at the bottom-right of any AO3 works to configure the script without editing any code
- **Error logging** - if something fails, open ⚙ and click "Copy error log" to copy a JSON diagnostic report to your clipboard for filing a bug report (note: ngl I'm not sure if this works cause I don't know how to trigger it, I added it for convenience, if it doesn't work then just manually explain your issue)

## What gets added to your bookmark notes

When you bookmark a fic, the following is automatically inserted into the notes field:

Single work:

```
[Title](https://web.archive.org/web/*/https://archiveofourown.org/works/...) by [Author]
Last Bookmarked: [DD/MM/YYYY]
```

Series:

```
[Series Title](https://web.archive.org/web/*/https://archiveofourown.org/series/...) by [Author]
[Work Title 1](https://web.archive.org/web/*/https://archiveofourown.org/works/...) by [Author]
[Work Title2 ](https://web.archive.org/web/*/https://archiveofourown.org/works/...) by [Author]
Last Bookmarked: [DD/MM/YYYY]
```

Any notes you've written above this line are preserved. On subsequent bookmark edits, only the `Last Bookmarked` date is updated, which also updates to the Wayback Machine everytime you re-bookmark the fic.

The Wayback links use `web/*/` wildcards so they always resolve to the most recent available snapshot.

## Installation

You're required to use a userscript manager in your browser in order for this to work.

**Recommended extensions:**
- Firefox: [Tampermonkey](https://www.tampermonkey.net/index.php?browser=firefox&locale=en), [Violentmonkey](https://addons.mozilla.org/en-US/firefox/addon/violentmonkey/)
- Chrome: [Tampermonkey](https://www.tampermonkey.net/index.php?browser=chrome&locale=en), [Violentmonkey](https://chromewebstore.google.com/detail/violentmonkey/jinjaccalgkegednnccohejagnlnfdag)
- Safari: [Tampermonkey](https://www.tampermonkey.net/index.php?browser=safari&locale=en), [userscripts](https://github.com/quoid/userscripts)

Once you have a userscript manager installed:
**[Install the userscript!](https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js)**

Your userscript manager will open an install prompt so just click **Install** to confirm!

## Settings

Click the ⚙ floating button at the bottom-right corner of any AO3 work, series, or collection page to open the settings panel:

| Option | Default | Description |
|---|---|---|
| Also archive URL without view params | `Off` | Also archives the base work URL in addition to the `?view_adult=true&view_full_work=true` version |
| Date Format | `DD/MM/YYYY` | Format for the bookmark date. Options: `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD` |
| Note label | `Last Bookmarked:` | The label used to identify and update the date line in your bookmark notes |

Settings are saved persistently and apply immediately.

## Reporting issues

If archiving fails, the status banner will say so. To get a diagnostic report:

- Click the ⚙ floating button at the bottom-right of the page
- Click "📋 Copy error log"
- Paste the copied JSON into a new GitHub issue

**Note: The above function may not work, so if there's no logs for you, just manually explain what happened.**

When writing the issue, please read the template and its instructions properly.

## Notes

- Archiving is done via the [Wayback Machine's Save Page Now](https://web.archive.org/save/) endpoint. If the Archive is under heavy load or unavailable, the banner will report the failure but your bookmark will still be saved normally.
- The userscript does not modify your bookmarks in any way beyond filling the notes field, all other bookmark settings (public/private, tags, other userscripts that also fills your note, etc.) remain under your control.
- Proxy and unofficial mirror sites are not supported, only [AO3's official URLs](https://archiveofourown.org/faq/accessing-fanworks?language_id=en#archiveurl) are covered!
- This userscript does not work for restricted works because, well, it's *restricted for users only*.
- If the userscript does not work even after multiple attempts, do not hesitate to **create a new issue**!
- This userscript is inspired by **bairdel's [AO3 Bookmarking Records](https://greasyfork.org/en/scripts/438892-ao3-bookmarking-records)**, I used to use it prior purely for the Wayback Machine function! It is now outdated and doesn't work anymore (for me, I think there were some changes made from Tampermonkey since) so I took some of the code from there, modified, updated, and added my own functions for a new separate userscript whose main function is to auto-archive fics to the Wayback Machine!
