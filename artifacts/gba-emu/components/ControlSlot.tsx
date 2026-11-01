import React, { type ReactNode } from 'react';
import { View } from 'react-native';
import type { ControlLayout } from '@/library/gameplayPreferences';

/**
 * Applies a saved touch-control offset and opacity without changing the
 * surrounding deck layout. Uses relative left/top (not a transform) so the
 * native measure() used for Android multi-touch routing reports the moved
 * bounds exactly. Size is applied by each control at its real dimensions.
 */
export function ControlSlot({ layout, children }: { layout?: ControlLayout; children: ReactNode }) {
  if (!layout) return <>{children}</>;
  return (
    <View
      collapsable={false}
      style={{ position: 'relative', left: layout.x, top: layout.y, opacity: layout.opacity }}
    >
      {children}
    </View>
  );
}
