import React from "react";
import { Img, staticFile } from "remotion";
import { Background, BrowserWindow, Headline, Highlight, useIn } from "../components";

export const Control: React.FC = () => {
  const p = useIn(0, 20);
  return (
    <Background>
      <Headline title="You stay in control" subtitle="Logs, requests and screenshots are off until you turn them on. Claude can't click or type." />
      <BrowserWindow
        style={{ left: 120, top: 290, width: 1680, height: 830, opacity: p, translate: `0 ${(1 - p) * 60}px` }}
        tab="Sharepane — Settings"
        tabIcon={staticFile("icon.svg")}
        host="moz-extension://"
        path="…/options/options.html"
      >
        <Img src={staticFile("ui/settings.png")} style={{ width: 1680 }} />
        {/* The three capture checkboxes: roughly 316–776 x 276–382 CSS px. */}
        <Highlight at={40} style={{ left: 316 * 1.4 - 14, top: 276 * 1.4, width: 460 * 1.4, height: 106 * 1.4 }} />
      </BrowserWindow>
    </Background>
  );
};
