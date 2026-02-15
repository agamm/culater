import React from 'react';
import {Composition} from 'remotion';
import {CulaterReadmeDemo, videoConfig} from './Video';

export const RemotionRoot = () => {
  return (
    <Composition
      id="CulaterReadmeDemo"
      component={CulaterReadmeDemo}
      durationInFrames={videoConfig.durationInFrames}
      fps={videoConfig.fps}
      width={videoConfig.width}
      height={videoConfig.height}
    />
  );
};
