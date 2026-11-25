import React from "react";
import { acmeIcon, Background, BrowserWindow, CheckoutApp, colors, Headline, Reveal, Terminal, Typed } from "../components";

const tool = (name: string, args: string) => (
  <div>
    <span style={{ color: "#3fb950" }}>● </span>
    <b>sharepane · {name}</b>
    <span style={{ color: "#9aa4b2" }}>{args}</span>
  </div>
);

const result = (text: React.ReactNode) => (
  <div style={{ color: "#9aa4b2", paddingLeft: 30 }}>
    ⎿ <span>{text}</span>
  </div>
);

export const Ask: React.FC = () => (
  <Background>
    <Headline step="5" title="Ask Claude" subtitle="It reads the page, its console and its network requests. Read-only." />
    <BrowserWindow
      style={{ left: 80, top: 290, width: 820, height: 830 }}
      tab="Checkout · Acme Outfitters"
      tabIcon={acmeIcon}
      host="localhost:5173"
      path="/checkout"
      badge
    >
      <CheckoutApp scale={1.08} />
    </BrowserWindow>
    <Terminal title="Claude Code" style={{ left: 940, top: 290, width: 900, height: 830 }}>
      <div style={{ fontSize: 23, lineHeight: 1.55 }}>
        <div style={{ background: "#23262d", borderRadius: 10, padding: "12px 16px" }}>
          <span style={{ color: "#9aa4b2" }}>&gt; </span>
          <Typed text="Why does the Pay button fail on my checkout page?" start={10} cps={26} />
        </div>
        <Reveal at={80} style={{ marginTop: 26 }}>
          {tool("get_console_logs", ' (levels: ["error"])')}
        </Reveal>
        <Reveal at={94}>
          {result(
            <span style={{ color: "#ff7b72" }}>
              Uncaught (in promise) PaymentError: 422 from /api/payments
            </span>,
          )}
        </Reveal>
        <Reveal at={124} style={{ marginTop: 18 }}>
          {tool("get_network_requests", ' (urlFilter: "/api/payments")')}
        </Reveal>
        <Reveal at={138}>
          {result(
            <>
              POST /api/payments → <span style={{ color: "#ff7b72" }}>422</span> · body:{" "}
              {'{"expiry": "12 / 27"}'}
            </>,
          )}
        </Reveal>
        <Reveal at={172} style={{ marginTop: 26, display: "flex", gap: 14 }}>
          <span style={{ color: colors.orange }}>●</span>
          <span>
            <Typed
              caret={false}
              start={172}
              cps={75}
              text={
                'The payment API rejects the request (422): the form sends the expiry as one "MM / YY" string, but the API expects separate exp_month and exp_year numbers. Split the field before posting in checkout.js.'
              }
            />
          </span>
        </Reveal>
      </div>
    </Terminal>
  </Background>
);
