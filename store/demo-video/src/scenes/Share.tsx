import React from "react";
import { Easing, Img, interpolate, staticFile, useCurrentFrame } from "remotion";
import { acmeIcon, Background, BrowserWindow, CheckoutApp, Cursor, Headline } from "../components";

// Window geometry, in video px.
const WIN = { left: 120, top: 290, width: 1680 };
// Popup screenshot is 340×352 CSS px; shown at 1.7x under the toolbar icon.
const POP = { scale: 1.7, top: 122, right: 12 };
const popW = 340 * POP.scale;
const popLeft = WIN.width - POP.right - popW;
// Toggle centre in the screenshot: (298, 115.5) CSS px.
const toggle = { x: WIN.left + popLeft + 298 * POP.scale, y: WIN.top + POP.top + 115.5 * POP.scale };
const icon = { x: WIN.left + WIN.width - 42, y: WIN.top + 86 };

const OPEN = 46;
const FLIP = 104;

export const Share: React.FC = () => {
  const frame = useCurrentFrame();
  const open = interpolate(frame, [OPEN, OPEN + 10], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(0.16, 1, 0.3, 1),
  });
  const on = frame >= FLIP + 2;
  return (
    <Background>
      <Headline step="4" title="Share your tab" subtitle="Click the Sharepane icon and turn on Share with Claude." />
      <BrowserWindow
        style={{ ...WIN, height: 830 }}
        tab="Checkout · Acme Outfitters"
        tabIcon={acmeIcon}
        otherTab="Payments API reference"
        host="localhost:5173"
        path="/checkout"
        extOpen={frame >= OPEN}
        badge={on}
        overlay={
          frame >= OPEN ? (
            <Img
              src={staticFile(on ? "ui/popup-on.png" : "ui/popup-off.png")}
              style={{
                position: "absolute",
                left: popLeft,
                top: POP.top,
                width: popW,
                borderRadius: 14,
                boxShadow: "0 18px 50px rgba(15,33,70,0.25), 0 0 0 1px rgba(15,33,70,0.1)",
                opacity: open,
                translate: `0 ${(1 - open) * -12}px`,
              }}
            />
          ) : null
        }
      >
        <CheckoutApp scale={1.5} />
      </BrowserWindow>
      <Cursor
        path={[
          { at: 0, x: 1100, y: 800 },
          { at: 38, x: icon.x - 4, y: icon.y - 4 },
          { at: OPEN, x: icon.x - 4, y: icon.y - 4, click: true },
          { at: 90, x: toggle.x, y: toggle.y },
          { at: FLIP, x: toggle.x, y: toggle.y, click: true },
          { at: 150, x: toggle.x - 220, y: toggle.y + 330 },
        ]}
      />
    </Background>
  );
};
