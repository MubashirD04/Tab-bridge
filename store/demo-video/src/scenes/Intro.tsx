import React from "react";
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Background, colors, useIn } from "../components";

export const Intro: React.FC = () => {
  const frame = useCurrentFrame();
  const name = useIn(14);
  const tag = useIn(30);
  return (
    <Background>
      <AbsoluteFill style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 36 }}>
          <Img
            src={staticFile("icon.svg")}
            style={{
              width: 150,
              height: 150,
              scale: interpolate(frame, [0, 22], [0.4, 1], {
                extrapolateLeft: "clamp",
                extrapolateRight: "clamp",
                easing: Easing.spring({ damping: 12 }),
              }),
              opacity: interpolate(frame, [0, 8], [0, 1], { extrapolateRight: "clamp" }),
            }}
          />
          <div style={{ fontSize: 150, fontWeight: 800, letterSpacing: "-0.035em", opacity: name, translate: `${(1 - name) * -30}px 0` }}>
            Sharepane
          </div>
        </div>
        <div style={{ marginTop: 40, fontSize: 52, color: colors.muted, opacity: tag, translate: `0 ${(1 - tag) * 20}px` }}>
          Let Claude see the Firefox tab you're debugging.
        </div>
      </AbsoluteFill>
    </Background>
  );
};
