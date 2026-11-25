import React from "react";
import { loadFont } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";

export const { fontFamily: sans } = loadFont("normal", {
  weights: ["400", "500", "600", "700", "800"],
  subsets: ["latin"],
});
export const { fontFamily: mono } = loadMono("normal", {
  weights: ["400", "500", "700"],
  subsets: ["latin"],
});

export const colors = {
  ink: "#1f2328",
  muted: "#57606a",
  blue: "#1f6feb",
  green: "#2ea043",
  orange: "#e8590c",
};

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** 0→1 over [start, start+length] frames, eased. */
export const useIn = (start: number, length = 18) => {
  const frame = useCurrentFrame();
  return interpolate(frame, [start, start + length], [0, 1], { ...clamp, easing: ease });
};

export const Background: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <AbsoluteFill
    style={{
      background: "linear-gradient(160deg, #e9f1ff 0%, #f6f8fb 55%, #eef2f7 100%)",
      fontFamily: sans,
      color: colors.ink,
    }}
  >
    {children}
  </AbsoluteFill>
);

/** Step number, headline and one supporting line, top-left. */
export const Headline: React.FC<{ step?: string; title: string; subtitle: string }> = ({
  step,
  title,
  subtitle,
}) => {
  const a = useIn(4);
  const b = useIn(12);
  return (
    <div style={{ position: "absolute", left: 120, top: 84, right: 120 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 24,
          opacity: a,
          translate: `0 ${(1 - a) * 24}px`,
        }}
      >
        {step ? (
          <div
            style={{
              width: 72,
              height: 72,
              borderRadius: 20,
              background: colors.blue,
              color: "#fff",
              fontSize: 40,
              fontWeight: 800,
              display: "grid",
              placeItems: "center",
            }}
          >
            {step}
          </div>
        ) : null}
        <div style={{ fontSize: 72, fontWeight: 800, letterSpacing: "-0.025em" }}>{title}</div>
      </div>
      <div
        style={{
          marginTop: 18,
          fontSize: 36,
          color: colors.muted,
          opacity: b,
          translate: `0 ${(1 - b) * 16}px`,
        }}
      >
        {subtitle}
      </div>
    </div>
  );
};

const favicon = (color: string, letter: string) =>
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="4" fill="${color}"/>` +
      `<text x="8" y="12" font-family="sans-serif" font-size="10" font-weight="700" fill="#fff" text-anchor="middle">${letter}</text></svg>`,
  );

export const acmeIcon = favicon(colors.orange, "A");

/** A plain browser window. Coordinates inside `children` start below the toolbar. */
export const BrowserWindow: React.FC<{
  style?: React.CSSProperties;
  tab: string;
  tabIcon: string;
  otherTab?: string;
  host: string;
  path: string;
  extOpen?: boolean;
  badge?: boolean;
  overlay?: React.ReactNode;
  children: React.ReactNode;
}> = ({ style, tab, tabIcon, otherTab, host, path, extOpen, badge, overlay, children }) => (
  <div
    style={{
      position: "absolute",
      background: "#fff",
      borderRadius: 18,
      overflow: "hidden",
      boxShadow: "0 36px 90px rgba(15,33,70,0.18), 0 0 0 1px rgba(15,33,70,0.08)",
      ...style,
    }}
  >
    <div style={{ height: 54, background: "#eef0f3", display: "flex", alignItems: "flex-end", padding: "0 18px", gap: 8 }}>
      <div style={{ display: "flex", gap: 10, alignSelf: "center", marginRight: 16 }}>
        {[0, 1, 2].map((i) => (
          <i key={i} style={{ width: 15, height: 15, borderRadius: "50%", background: "#d0d4da", display: "block" }} />
        ))}
      </div>
      <div
        style={{
          height: 44,
          padding: "0 20px",
          display: "flex",
          alignItems: "center",
          gap: 10,
          fontSize: 18,
          background: "#fff",
          borderRadius: "12px 12px 0 0",
          whiteSpace: "nowrap",
        }}
      >
        <Img src={tabIcon} style={{ width: 20, height: 20 }} />
        {tab}
      </div>
      {otherTab ? (
        <div style={{ height: 44, padding: "0 20px", display: "flex", alignItems: "center", fontSize: 18, color: colors.muted }}>
          {otherTab}
        </div>
      ) : null}
    </div>
    <div style={{ height: 64, display: "flex", alignItems: "center", gap: 14, padding: "0 20px", borderBottom: "1px solid #e6e8eb" }}>
      <div
        style={{
          flex: 1,
          height: 44,
          borderRadius: 12,
          background: "#f1f3f5",
          display: "flex",
          alignItems: "center",
          padding: "0 18px",
          fontSize: 19,
          color: "#3d444d",
        }}
      >
        <b style={{ color: colors.ink, fontWeight: 600 }}>{host}</b>
        {path}
      </div>
      <div
        style={{
          position: "relative",
          width: 44,
          height: 44,
          borderRadius: 10,
          display: "grid",
          placeItems: "center",
          background: extOpen ? "#e2e6eb" : "transparent",
        }}
      >
        <Img src={staticFile("icon.svg")} style={{ width: 26, height: 26 }} />
        {badge ? (
          <span
            style={{
              position: "absolute",
              right: -4,
              bottom: 0,
              background: colors.green,
              color: "#fff",
              font: "800 11px/1 sans-serif",
              padding: "3px 4px",
              borderRadius: 4,
            }}
          >
            ON
          </span>
        ) : null}
      </div>
    </div>
    <div style={{ position: "absolute", top: 118, left: 0, right: 0, bottom: 0, overflow: "hidden" }}>{children}</div>
    {overlay}
  </div>
);

/** The made-up checkout page used throughout (same as the store screenshots). */
export const CheckoutApp: React.FC<{ scale?: number }> = ({ scale = 1.5 }) => {
  const field: React.CSSProperties = {
    height: 38,
    border: "1px solid #dcd8d2",
    borderRadius: 7,
    marginBottom: 12,
    padding: "9px 12px",
    color: "#9a948d",
  };
  const row: React.CSSProperties = { display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 13.5 };
  const card: React.CSSProperties = { background: "#fff", border: "1px solid #ece9e4", borderRadius: 10, padding: 18 };
  return (
    <div style={{ width: `${100 / scale}%`, height: `${100 / scale}%`, scale: String(scale), transformOrigin: "0 0" }}>
      <div style={{ font: `14px/1.5 ${sans}`, color: "#212529", height: "100%", background: "#fafaf9" }}>
        <header
          style={{
            height: 56,
            display: "flex",
            alignItems: "center",
            padding: "0 32px",
            gap: 28,
            background: "#fff",
            borderBottom: "1px solid #ece9e4",
          }}
        >
          <span style={{ fontWeight: 800, color: colors.orange, fontSize: 18 }}>Acme Outfitters</span>
          <nav style={{ color: "#6b6560", display: "flex", gap: 22 }}>
            <span>Shop</span>
            <span>Orders</span>
            <span>Account</span>
          </nav>
        </header>
        <main style={{ padding: "28px 32px", display: "grid", gridTemplateColumns: "1fr 300px", gap: 28, width: 720 }}>
          <section>
            <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Checkout</h2>
            <div
              style={{
                background: "#fff1f0",
                border: "1px solid #ffc9c4",
                color: "#b42318",
                borderRadius: 8,
                padding: "10px 12px",
                marginBottom: 16,
                fontSize: 13.5,
              }}
            >
              Payment failed: something went wrong. Please try again.
            </div>
            <div style={card}>
              <div style={field}>Card number</div>
              <div style={field}>MM / YY</div>
              <div style={field}>Name on card</div>
              <div
                style={{
                  height: 42,
                  borderRadius: 8,
                  background: colors.orange,
                  color: "#fff",
                  fontWeight: 600,
                  fontSize: 15,
                  opacity: 0.55,
                  display: "grid",
                  placeItems: "center",
                }}
              >
                Pay $84.00
              </div>
            </div>
          </section>
          <aside style={{ ...card, alignSelf: "start" }}>
            <h2 style={{ margin: "0 0 16px", fontSize: 17 }}>Order summary</h2>
            <div style={row}>
              <span>Trail jacket</span>
              <span>$72.00</span>
            </div>
            <div style={row}>
              <span>Shipping</span>
              <span>$12.00</span>
            </div>
            <div style={{ ...row, fontWeight: 700 }}>
              <span>Total</span>
              <span>$84.00</span>
            </div>
          </aside>
        </main>
      </div>
    </div>
  );
};

/** Dark terminal window with a title. */
export const Terminal: React.FC<{ style?: React.CSSProperties; title: string; children: React.ReactNode }> = ({
  style,
  title,
  children,
}) => (
  <div
    style={{
      position: "absolute",
      background: "#16181d",
      borderRadius: 18,
      overflow: "hidden",
      boxShadow: "0 36px 90px rgba(15,33,70,0.28), 0 0 0 1px rgba(15,33,70,0.2)",
      color: "#e6edf3",
      fontFamily: mono,
      ...style,
    }}
  >
    <div
      style={{
        height: 54,
        background: "#23262d",
        display: "flex",
        alignItems: "center",
        padding: "0 20px",
        gap: 10,
        fontFamily: sans,
        fontSize: 18,
        color: "#9aa4b2",
      }}
    >
      {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
        <i key={c} style={{ width: 15, height: 15, borderRadius: "50%", background: c, display: "block" }} />
      ))}
      <span style={{ flex: 1, textAlign: "center", marginRight: 75 }}>{title}</span>
    </div>
    <div style={{ padding: "28px 34px" }}>{children}</div>
  </div>
);

/** Text typed out from `start`, `cps` characters per second at 30fps. */
export const Typed: React.FC<{ text: string; start: number; cps?: number; caret?: boolean }> = ({
  text,
  start,
  cps = 22,
  caret = true,
}) => {
  const frame = useCurrentFrame();
  const n = Math.max(0, Math.min(text.length, Math.floor(((frame - start) * cps) / 30)));
  const typing = frame >= start && n < text.length;
  const blink = Math.floor(frame / 15) % 2 === 0;
  return (
    <span>
      {text.slice(0, n)}
      {caret && (typing || (n === text.length && blink) || (frame < start && blink)) ? (
        <span style={{ background: "currentColor", display: "inline-block", width: "0.55em", height: "1.1em", verticalAlign: "-0.2em", marginLeft: 2 }} />
      ) : null}
    </span>
  );
};

/** Fades and lifts in at `at`. */
export const Reveal: React.FC<{ at: number; children: React.ReactNode; style?: React.CSSProperties }> = ({
  at,
  children,
  style,
}) => {
  const p = useIn(at, 12);
  return <div style={{ opacity: p, translate: `0 ${(1 - p) * 10}px`, ...style }}>{children}</div>;
};

type Point = { at: number; x: number; y: number; click?: boolean };

/** Mouse pointer that glides between points and pulses on clicks. */
export const Cursor: React.FC<{ path: Point[] }> = ({ path }) => {
  const frame = useCurrentFrame();
  let x = path[0].x;
  let y = path[0].y;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const p = interpolate(frame, [a.at, b.at], [0, 1], { ...clamp, easing: Easing.bezier(0.45, 0, 0.2, 1) });
    if (frame >= a.at) {
      x = a.x + (b.x - a.x) * p;
      y = a.y + (b.y - a.y) * p;
    }
  }
  const click = path.find((p) => p.click && frame >= p.at && frame < p.at + 14);
  const ring = click ? (frame - click.at) / 14 : 0;
  const press = click && frame - click.at < 5 ? 0.85 : 1;
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none" }}>
      {click ? (
        <div
          style={{
            position: "absolute",
            left: -28,
            top: -28,
            width: 56,
            height: 56,
            borderRadius: "50%",
            border: `4px solid ${colors.blue}`,
            opacity: 1 - ring,
            scale: String(0.4 + ring),
          }}
        />
      ) : null}
      <svg width="40" height="40" viewBox="0 0 24 24" style={{ scale: String(press), transformOrigin: "0 0", filter: "drop-shadow(0 3px 6px rgba(0,0,0,0.3))" }}>
        <path d="M3 2l7.5 19 2.6-7.9L21 10.5z" fill="#111" stroke="#fff" strokeWidth="1.5" strokeLinejoin="round" />
      </svg>
    </div>
  );
};

/** Rounded highlight box that draws attention to an area. */
export const Highlight: React.FC<{ at: number; style: React.CSSProperties }> = ({ at, style }) => {
  const p = useIn(at, 14);
  return (
    <div
      style={{
        position: "absolute",
        border: `5px solid ${colors.blue}`,
        borderRadius: 16,
        boxShadow: "0 0 0 8px rgba(31,111,235,0.15)",
        opacity: p,
        scale: String(1.04 - 0.04 * p),
        ...style,
      }}
    />
  );
};
