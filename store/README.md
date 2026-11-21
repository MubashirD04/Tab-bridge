# Store assets

Images for the addons.mozilla.org listing.

- `icon-128.png` (plus 64 and 32): the listing icon, exported from
  [`extension/icons/icon.svg`](../extension/icons/icon.svg) so the listing and
  the toolbar match.
- `screenshots/`: 1280×800 listing screenshots, in the order they should
  appear. They show the real popup, setup guide and settings pages with
  made-up sample data (the Acme Outfitters shop and its tabs don't exist).

## Regenerating the screenshots

After a UI change:

```bash
node store/harness/serve.mjs          # serves the repo on 127.0.0.1:4173
store/harness/capture.sh              # in another terminal; needs Firefox
```

`serve.mjs` injects [`harness/mock-browser.js`](harness/mock-browser.js), a
stand-in for the extension API with sample tabs and settings, into the
extension pages. [`harness/shot.html`](harness/shot.html) frames each page
with its headline. Open `http://127.0.0.1:4173/store/harness/shot.html?shot=popup`
(or `onboarding-start`, `onboarding`, `settings`) to preview one in a browser.

To re-export the icon PNGs after changing the SVG, draw it onto a canvas at
each size, or use any SVG-to-PNG tool.
