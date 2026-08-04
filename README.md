# AO3 to Wayback Machine

A userscript that automatically saves AO3 fics to the [Internet Archive Wayback Machine](https://web.archive.org/) when you bookmark them, and fills your bookmark notes with a Wayback link, the fic's author, and the date you bookmarked it.

Expect random updates because the auto-archive function may randomly stop working.

## Features

- **Auto-archives when bookmarking** - automatically sends the fic to the Wayback Machine everytime you submit a bookmark, no extra clicks needed
- **Archives the full work including rated mature and explicit** - always saves the `?view_adult=true&view_full_work=true` version so the entire fic is captured in one go
- **Auto-fills bookmark notes with info** - fills bookmark note with a Wayback Machine hyperlink to the archived fic, the author's name, and the date bookmarked + when re-bookmarking, the entire auto-generated block is entirely updated and overwritten rather than duplicated
- **Series support** - when bookmarking a series, archives every individual work listed on the series page and adds a line per work to your bookmark notes too
- **Works on all official AO3 domains** - supports mirror sites like `archiveofourown.org`, `.com`, `.net`, `.gay`, `ao3.org`, `archive.transformativeworks.org`, and `insecure.archiveofourown.org` + always archives the official URL regardless of which mirror you're using
- **IA API mode** - when you add your internet archive api keys, the script uses the `save page now 2 (SPN2) api` instead of opening a tab. this bypasses your ao3 cookies to wayback's crawler, bypassing the errors ao3 gives anonymous bots
- **Status notification** - a small banner in the corner tracks progress, retries, and the final result (note: may not be accurate tho)
- **In-page settings panel** - click the ⚙ floating button at the bottom-right of any AO3 works to configure the script without editing any code
- **Error logging** - if something fails, open ⚙ and click "Copy error log" to copy a JSON diagnostic report to your clipboard for filing a bug report (note: ngl I'm not sure if this works cause I don't know how to trigger it, I added it for convenience, if it doesn't work then just manually explain your issue)
- **Automatic retries** - if Wayback doesn't save the fic on the first attempt, the script automatically tries again (configurable, default: 2 retries)
- **CDX verification** - after each save attempt, the script checks the Wayback CDX API to confirm a snapshot actually got created, rather than assuming success

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

Once you have a userscript manager installed, **[install the userscript!](https://raw.githubusercontent.com/zytancl/AO3-to-Wayback-Machine/main/ao3-wayback-machine.user.js)**

Your userscript manager will open an install prompt so just click **Install** to confirm!

## Internet Archive API setup (recommended)
 
AO3 returns 404 to anonymous crawlers, including Wayback's bot, even for fully public fics. This causes the "job failed" error in Wayback. Adding your Internet Archive API keys fixes this by letting Wayback crawl AO3 using your login cookies, so it sees the page as a real user.
 
The Internet Archive account and API keys are **free**.
 
### Step 1 - Create an Internet Archive account
 
Go to [archive.org/account/signup](https://archive.org/account/signup) and create a free account. Verify your email before continuing.
 
### Step 2 - Get your S3 API keys
 
1. Go to your [Internet Archive](https://archive.org/) account
2. Go to [archive.org/account/s3.php](https://archive.org/account/s3.php)
3. Click **Generate new keys** if no keys are shown
4. Copy your **Access Key** and **Secret Key** (keep these private and should not be shared to anyone)

### Step 3 - Enter your keys in the script settings
 
1. Go to any AO3 work, series, or collection page
2. Click the **⚙ button** at the bottom-right corner of the page
3. Scroll to the **Internet Archive API** section
4. Paste your Access Key and Secret Key into the two fields
5. Click **Save**

### What changes when IA API is enabled
 
- **No tab opens** when you bookmark; the save request goes directly via the API in the background
- A banner saying **"📡 Sending to IA API... (no tab will open)"** appears instead
- As the save progresses you will see banners like **"📡 IA API: archiving in progress... (10s)"**
- When done, a **"✅ Archived"** banner confirms success
- If something goes wrong (wrong keys, network issue, etc.) a **"❌ IA API error"** banner appears with a hint

> Note: The banners may not appear when you load to the next page, but sometimes you may see the **"✅ Archived"** banner after a while. Most of the time, it will archived successfully regardless, but it's better to check whether it's truly archived yourself for now. I will find a way to make the banners persistent.
 
## How archiving works (without IA API keys)
 
1. When you submit a bookmark, the script opens a tab to `https://web.archive.org/save/[url]`
   - On **desktop** the tab opens in the background
   - On **mobile / tablet** the tab opens in the foreground since background tabs are suspended before Wayback can load, you will need to navigate back to AO3 manually
2. The tab closes automatically after 30 seconds (60 seconds on mobile)
3. After 35 seconds (70 on mobile), the script checks the [Wayback CDX API](https://github.com/internetarchive/wayback/tree/master/wayback-cdx-server) to confirm a snapshot was created today
4. If no snapshot is found, the script retries with a progressively simpler URL:
   - Attempt 1 — `?view_adult=true&view_full_work=true`
   - Attempt 2 — `?view_adult=true` only
   - Attempt 3 — base URL, no parameters
5. The status banner updates at each step

> Note: AO3 blocks some unauthenticated crawlers at the server level, which can cause Wayback to receive a "job failed" or 404 even for fully public fics. **This is an AO3-side restriction the script cannot work around.** Retries help in cases where AO3 is temporarily rate-limiting, but persistent 404s from Wayback mean the save did not go through. This is something I can't do anything about it, that's why I kept changing the code in the beginning cause I was desperately trying to bypass it. Adding your IA API keys (above) is the reliable fix.

## Settings

Click the ⚙ floating button at the bottom-right corner of any AO3 work, series, or collection page to open the settings panel:

| Options | Default | Description |
|---|---|---|
| Also archive URL without view params | Off | Also archives the base work URL in addition to the full-work version |
| Date format | `DD/MM/YYYY` | Format for the bookmark date. Options: `DD/MM/YYYY`, `MM/DD/YYYY`, `YYYY-MM-DD` |
| Note label | `Last Bookmarked: ` | The label used to identify and update the date line in your bookmark notes |
| Max retries | `2` | How many times to retry if Wayback does not save the fic. Each retry uses a simpler URL variant. Only applies to the tab method — with IA API the job is retried server-side |
| Retry delay | `20s` | How long to wait between retry attempts (tab method only, 10–120 seconds) |
| Internet Archive Access Key | — | Your IA S3 access key. See setup instructions above |
| Internet Archive Secret Key | — | Your IA S3 secret key. See setup instructions above |

Settings are saved persistently and apply immediately.

## Reporting issues

If archiving fails, the status banner will say so. To get a diagnostic report:

- Click the ⚙ floating button at the bottom-right of the page
- Click "📋 Copy error log"
- Paste the copied JSON into a new GitHub issue

> Note: The above function may not work, so if there's no logs for you, just manually explain what happened.

When writing the issue, please read the template and its instructions properly.

## Notes

- Archiving is done via the [Wayback Machine's Save Page Now](https://web.archive.org/save/) endpoint. If the Archive is under heavy load or unavailable, the banner will report the failure but your bookmark will still be saved normally.
- The userscript does not modify your bookmarks in any way beyond filling the notes field, all other bookmark settings (public/private, tags, other userscripts that also fills your note, etc.) remain under your control.
- Proxy and unofficial mirror sites are not supported, only [AO3's official URLs](https://archiveofourown.org/faq/accessing-fanworks?language_id=en#archiveurl) are covered!
- This userscript does not work for restricted works because, well, it's *restricted for users only*.
- The script requires the `GM_openInTab` permission to open save tabs, your userscript manager will list this under the script's permissions when you install it.
- I highly recommend checking if your bookmark gets archived properly in the background tab just to ensure that it works properly every single time.
- Your IA API keys are stored locally by your userscript manager and are never sent anywhere except to `web.archive.org`.
- There is a chance that you may get rate-limited by Wayback Machine if you have been bookmarking constantly in a short while or you're bookmarking a series that contains many works, you can either try again later or use your IA API keys, but the worse case scenario is that the only solution is for you to archive them yourself.
- If the userscript does not work even after multiple attempts, do not hesitate to **create a new issue**!
- This userscript is inspired by **bairdel's [AO3 Bookmarking Records](https://greasyfork.org/en/scripts/438892-ao3-bookmarking-records)**, I used to use it prior purely for the Wayback Machine function! It is now outdated and doesn't work anymore (for me, I think there were some changes made from Tampermonkey since) so I took some of the code from there, modified, updated, and added my own functions for a new separate userscript whose main function is to auto-archive fics to the Wayback Machine!
