---
name: setup
description: Set up or repair Sharepane — connects the Firefox extension to Claude. Use when the user runs /sharepane:setup, asks to set up or fix Sharepane, or Sharepane tools report EXTENSION_DISCONNECTED.
---

# Set up Sharepane

This plugin ships the Sharepane command-line tool at `bin/sharepane.mjs`,
two levels up from this skill's base directory (`<base>/../../bin/sharepane.mjs`).
Use that absolute path below. It needs Node.js 18 or later.

1. **Run setup in plugin mode.** It registers the Firefox native host, installs
   a stable copy of the tool to `~/.sharepane/bin/`, registers Claude Desktop
   if it's installed, and removes any separate user-wide `sharepane` MCP
   entry (this plugin already provides the tools; a second copy would make
   every tool appear twice).

   ```bash
   node "<plugin>/bin/sharepane.mjs" setup --plugin
   ```

   Show the user its output. It changes files in their home directory and
   Claude/Firefox configuration, so if they haven't asked for setup in so many
   words, run it with `--dry-run` first and confirm.

2. **Check everything.**

   ```bash
   node "<plugin>/bin/sharepane.mjs" doctor
   ```

   Each line is ✓ (fine), ! (works, but worth fixing), ✗ (broken) or – (not
   applicable). Relay each ✗ with its suggested fix.

3. **The Firefox extension.** If doctor says Firefox isn't connected, the user
   needs the Sharepane extension installed and Firefox open. Once it's
   connected, its toolbar popup has a **Setup guide** link with a live
   checklist.

4. **Finish.** If setup removed a user-wide entry or this is a fresh install,
   the user may need to restart Claude Code for the tools to appear. Then they
   share a tab (toolbar icon → **Share with Claude**) and can ask about it.
