import React from 'react';
import { Tabs } from 'expo-router';
import PillTabBar, { type BarProps } from '@/components/PillTabBar';

export default function TabLayout() {
  return (
    <Tabs
      screenOptions={{ headerShown: false }}
      tabBar={(props) => <PillTabBar {...(props as unknown as BarProps)} />}
    >
      <Tabs.Screen name="index" options={{ title: 'Library' }} />
      <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
    </Tabs>
  );
}
