import React from "react";
import { Img, staticFile } from "remotion";
import { Background, BrowserWindow, Headline, Highlight, useIn } from "../components";

// The setup guide screenshot is 1200 CSS px wide; shown 1680 px wide (x1.4).
export const SETUP_GUIDE_WIDTH = 1680;

export const SetupGuideWindow: React.FC<{ children: React.ReactNode; badge?: boolean }> = ({ children, badge }) => {
  const p = useIn(0, 20);
  return (
    <BrowserWindow
      style={{ left: 120, top: 290, width: 1680, height: 830, opacity: p, translate: `0 ${(1 - p) * 60}px` }}
      tab="Set up Sharepane"
      tabIcon={staticFile("icon.svg")}
      host="moz-extension://"
      path="…/onboarding/onboarding.html"
      badge={badge}
    >
      {children}
    </BrowserWindow>
  );
};

export const Install: React.FC = () => (
  <Background>
    <Headline step="1" title="Install the extension" subtitle="Get it from addons.mozilla.org. Its setup guide opens by itself." />
    <SetupGuideWindow>
      <Img src={staticFile("ui/onboarding-start.png")} style={{ width: SETUP_GUIDE_WIDTH }} />
      {/* "Connect the helper" card: 306–894 x 281–449 CSS px in the screenshot. */}
      <Highlight at={70} style={{ left: 306 * 1.4 - 10, top: 281 * 1.4 - 10, width: 588 * 1.4 + 20, height: 168 * 1.4 + 20 }} />
    </SetupGuideWindow>
  </Background>
);
