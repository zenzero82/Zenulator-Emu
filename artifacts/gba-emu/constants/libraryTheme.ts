/** Visual tokens for the cinematic Library screen and its floating tab pill. */
export const library = {
  bg: '#0d0a18',
  mountainFar: '#141025',
  mountainNear: '#0d0a18',
  gradient: ['#1c1236', '#120d22', '#0d0a18'] as const,
  text: '#f4f1ff',
  textSoft: '#a39cc0',
  textDim: '#8f88ad',
  accent: '#8b5cf6',
  accentBright: '#a37bff',
  accentSoft: 'rgba(139,92,246,0.16)',
  onAccent: '#ffffff',
  danger: '#ff7a8a',
  sheetAction: '#cdbfff',
  surface: '#1a1530',
  frame: '#1b1530',
  frameBorder: 'rgba(160,120,255,0.35)',
  glass: 'rgba(255,255,255,0.1)',
  glassBorder: 'rgba(255,255,255,0.14)',
  hairline: 'rgba(255,255,255,0.1)',
  dot: 'rgba(255,255,255,0.22)',
  scrim: 'rgba(0,0,0,0.55)',
  pill: 'rgba(28,24,44,0.96)',
  pillBorder: 'rgba(255,255,255,0.12)',
  pillActive: 'rgba(255,255,255,0.09)',
  tabOn: '#8fb4ff',
  tabOff: '#a7a3b8',
  shadow: '#000000',
  halo: ['rgba(139,92,246,0.10)', 'rgba(139,92,246,0.16)', 'rgba(163,123,255,0.26)'] as const,
};

export const PILL_HEIGHT = 70;
/** Total vertical space the floating pill occupies above the screen bottom. */
export function pillReserve(bottomInset: number): number {
  return Math.max(bottomInset, 12) + 6 + PILL_HEIGHT;
}
