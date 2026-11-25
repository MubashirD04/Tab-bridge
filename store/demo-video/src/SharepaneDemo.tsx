import React from "react";
import { linearTiming, TransitionSeries } from "@remotion/transitions";
import { fade } from "@remotion/transitions/fade";
import { Intro } from "./scenes/Intro";
import { Install } from "./scenes/Install";
import { Setup } from "./scenes/Setup";
import { Connected } from "./scenes/Connected";
import { Share } from "./scenes/Share";
import { Ask } from "./scenes/Ask";
import { Control } from "./scenes/Control";
import { Outro } from "./scenes/Outro";

export const FPS = 30;
export const TRANSITION = 15;

export const SCENES = [
  { id: "Intro", component: Intro, durationInFrames: 105 },
  { id: "Install", component: Install, durationInFrames: 150 },
  { id: "Setup", component: Setup, durationInFrames: 210 },
  { id: "Connected", component: Connected, durationInFrames: 120 },
  { id: "Share", component: Share, durationInFrames: 180 },
  { id: "Ask", component: Ask, durationInFrames: 330 },
  { id: "Control", component: Control, durationInFrames: 165 },
  { id: "Outro", component: Outro, durationInFrames: 150 },
] as const;

export const TOTAL_FRAMES =
  SCENES.reduce((sum, s) => sum + s.durationInFrames, 0) - TRANSITION * (SCENES.length - 1);

export const SharepaneDemo: React.FC = () => (
  <TransitionSeries>
    {SCENES.flatMap(({ id, component: Scene, durationInFrames }, i) => [
      ...(i > 0
        ? [<TransitionSeries.Transition key={`${id}-in`} presentation={fade()} timing={linearTiming({ durationInFrames: TRANSITION })} />]
        : []),
      <TransitionSeries.Sequence key={id} name={id} durationInFrames={durationInFrames}>
        <Scene />
      </TransitionSeries.Sequence>,
    ])}
  </TransitionSeries>
);
