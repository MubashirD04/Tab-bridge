import React from "react";
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Background, Headline } from "../components";
import { SETUP_GUIDE_WIDTH, SetupGuideWindow } from "./Install";

export const Connected: React.FC = () => {
  const frame = useCurrentFrame();
  const done = interpolate(frame, [30, 45], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  return (
    <Background>
      <Headline step="3" title="Restart Claude" subtitle="Restart Claude Code or Claude Desktop. The setup guide turns green by itself." />
      <SetupGuideWindow badge={done > 0.5}>
        <Img src={staticFile("ui/onboarding-start.png")} style={{ position: "absolute", width: SETUP_GUIDE_WIDTH }} />
        <Img src={staticFile("ui/onboarding-done.png")} style={{ position: "absolute", width: SETUP_GUIDE_WIDTH, opacity: done }} />
      </SetupGuideWindow>
    </Background>
  );
};
