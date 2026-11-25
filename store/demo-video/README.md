# Sharepane demo video

A 43-second walkthrough (1920×1080, 30fps) made with [Remotion](https://www.remotion.dev):
install, `npx sharepane setup`, restart Claude, share a tab, ask Claude,
and the capture settings. The extension UI in it is the real popup, setup
guide and settings page, rendered with the store harness's sample data.

```bash
npm install
node capture/capture.mjs   # re-capture the extension UI into public/ui/ after a UI change
npx remotion studio        # preview and tweak
npx remotion render SharepaneDemo ../demo.mp4
```

The rendered video is checked in as [`store/demo.mp4`](../demo.mp4).

Scenes live in `src/scenes/`, and their lengths are set in `src/SharepaneDemo.tsx`.
`capture.mjs` needs a Chromium; set `CHROME` if it isn't at `/usr/bin/chromium`.
