import React from "react";
import { Composition, Folder } from "remotion";
import { FPS, SCENES, SharepaneDemo, TOTAL_FRAMES } from "./SharepaneDemo";

export const RemotionRoot: React.FC = () => (
  <>
    <Composition id="SharepaneDemo" component={SharepaneDemo} width={1920} height={1080} fps={FPS} durationInFrames={TOTAL_FRAMES} />
    <Folder name="Scenes">
      {SCENES.map((s) => (
        <Composition key={s.id} id={s.id} component={s.component} width={1920} height={1080} fps={FPS} durationInFrames={s.durationInFrames} />
      ))}
    </Folder>
  </>
);
