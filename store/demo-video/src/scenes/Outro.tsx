import React from "react";
import { AbsoluteFill, Img, staticFile } from "remotion";
import { Background, colors, mono, useIn } from "../components";

export const Outro: React.FC = () => {
  const a = useIn(0, 20);
  const b = useIn(14);
  const c = useIn(28);
  return (
    <Background>
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 28, opacity: a, scale: String(0.94 + 0.06 * a) }}>
          <Img src={staticFile("icon.svg")} style={{ width: 110, height: 110 }} />
          <div style={{ fontSize: 110, fontWeight: 800, letterSpacing: "-0.035em" }}>Sharepane</div>
        </div>
        <div
          style={{
            marginTop: 56,
            fontFamily: mono,
            fontSize: 50,
            background: "#16181d",
            color: "#e6edf3",
            padding: "26px 48px",
            borderRadius: 20,
            opacity: b,
            translate: `0 ${(1 - b) * 20}px`,
          }}
        >
          <span style={{ color: "#3fb950" }}>$ </span>npx sharepane setup
        </div>
        <div style={{ marginTop: 48, fontSize: 36, color: colors.muted, opacity: c, textAlign: "center", lineHeight: 1.5 }}>
          Firefox 140+ · Node.js 18+ · macOS and Linux
          <br />
          <span style={{ color: colors.blue, fontWeight: 600 }}>github.com/MubashirD04/sharepane</span>
        </div>
      </AbsoluteFill>
    </Background>
  );
};
