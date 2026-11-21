# Releasing Sharepane

A release ships three things at one version: the Firefox extension (on
addons.mozilla.org), the `sharepane` npm package, and the Claude Code plugin
(which users get straight from this repo). Pushing a `v*` tag runs
[`.github/workflows/release.yml`](.github/workflows/release.yml), which does
all of it.

## Every release

```bash
node scripts/version.mjs set 0.3.0   # extension, npm package and plugin
npm install                          # updates package-lock.json
npm run build                        # rebuilds the plugin's bundled CLI
git commit -am "Release 0.3.0"
git tag -a v0.3.0 -m "What changed, in a sentence or two."
git push origin main v0.3.0
```

The tag message becomes the release notes on addons.mozilla.org. The
workflow refuses to release if the tag and the files disagree, if a check
fails, or if the committed plugin bundle doesn't match the source.

Mozilla reviews each version before it goes live, which can take from minutes
to a few days; you get an email either way. Firefox updates installed copies
by itself once it's approved. npm and the plugin are live as soon as the
workflow finishes.

## One-time setup

1. **GitHub environment.** In the repo's Settings → Environments, create one
   called `release`. Adding yourself as a required reviewer means every
   release waits for your click before anything is published.

2. **addons.mozilla.org.** Sign in at <https://addons.mozilla.org/developers/>,
   accept the Firefox Add-on Distribution Agreement, then generate API
   credentials at <https://addons.mozilla.org/developers/addon/api/key/>.
   Add them to the `release` environment as secrets:
   - `AMO_JWT_ISSUER`: the JWT issuer (looks like `user:12345:67`)
   - `AMO_JWT_SECRET`: the JWT secret

   The first release creates the listing from
   [`.github/amo-metadata.json`](.github/amo-metadata.json). `web-ext sign`
   doesn't upload images, so afterwards add them on the listing's Edit page
   (Images): the icon is [`store/icon-128.png`](store/icon-128.png) and the
   screenshots are in [`store/screenshots/`](store/screenshots/).

3. **npm.** Trusted publishing (no long-lived token) can only be set up for a
   package that already exists, so the first version goes out one of two ways:
   - Publish it yourself: `npm login`, then
     `npm publish --workspace packages/daemon --access public`. The tag's
     workflow then sees that version is already on npm and skips it.
   - Or add an npm granular access token with publish rights as the
     `NPM_TOKEN` secret in the `release` environment.

   Then, on npmjs.com, open the package's Settings → Trusted publishing and add
   GitHub Actions with repository `MubashirD04/sharepane`, workflow
   `release.yml` and environment `release`. Delete `NPM_TOKEN` once that works.
   Packages published this way carry a provenance statement linking them to
   the exact workflow run.

## If a release fails partway

Re-run the failed jobs from the Actions tab. The npm job skips a version
that's already published, and the GitHub release job skips an existing
release. addons.mozilla.org rejects a version number it has already accepted,
so if the extension went through but something after it failed, re-run only
the jobs that failed.
