import React from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { library } from '@/constants/libraryTheme';

/** Decorative scenery only; never intercepts library gestures. */
export default function LibraryScenery() {
  return (
    <View pointerEvents="none" style={styles.scenery}>
      <Svg width="100%" height="100%" viewBox="0 0 600 360" preserveAspectRatio="none">
        <Path
          d="M0 95 L45 120 88 84 117 110 155 66 205 112 244 93 290 139 330 110 372 130 418 85 463 121 515 57 550 95 600 72 V360 H0Z"
          fill={library.mountainFar}
        />
        <Path
          d="M0 146 L47 125 85 161 132 112 185 157 237 133 295 188 354 142 402 169 455 127 514 177 563 131 600 156 V360 H0Z"
          fill={library.mountainNear}
        />
      </Svg>
    </View>
  );
}

const styles = StyleSheet.create({
  scenery: { position: 'absolute', top: 92, left: 0, right: 0, height: 340 },
});