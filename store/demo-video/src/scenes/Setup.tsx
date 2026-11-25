import React from "react";
import { Background, colors, Headline, Reveal, Terminal, Typed } from "../components";

// The real output of `npx sharepane setup` on Linux with Claude Code installed.
const steps = [
  "Install sharepane 0.2.0 to ~/.sharepane/bin/sharepane.mjs",
  "Register the native host with Firefox (~/.mozilla/native-messaging-hosts/sharepane.json), using /usr/bin/node",
  'Register "sharepane" with Claude Code for all projects (claude mcp add-json -s user)',
];

export const Setup: React.FC = () => (
  <Background>
    <Headline step="2" title="Run one command" subtitle="It connects Firefox to Claude Code and Claude Desktop." />
    <Terminal title="Terminal" style={{ left: 220, top: 300, width: 1480, height: 700 }}>
      <div style={{ fontSize: 28, lineHeight: 1.6 }}>
        <div>
          <span style={{ color: colors.green }}>$ </span>
          <Typed text="npx sharepane setup" start={12} cps={18} caret />
        </div>
        {steps.map((s, i) => (
          <Reveal key={s} at={60 + i * 18} style={{ display: "flex", gap: 16, marginTop: 10 }}>
            <span style={{ color: "#3fb950" }}>✓</span>
            <span>{s}</span>
          </Reveal>
        ))}
        <Reveal at={124} style={{ marginTop: 28, color: "#9aa4b2" }}>
          Done. Next: load the extension in Firefox (or reload it if it's already loaded),
          <br />
          then restart Claude Code / Claude Desktop. `sharepane doctor` checks everything.
        </Reveal>
      </div>
    </Terminal>
  </Background>
);
