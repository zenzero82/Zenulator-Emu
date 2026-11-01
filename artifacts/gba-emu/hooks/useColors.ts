import { useColorScheme } from 'react-native';
import colors from '@/constants/colors';

/**
 * Returns the design tokens for the current color scheme.
 *
 * The returned object contains all color tokens for the active palette
 * plus scheme-independent values like `radius`.
 *
 * Falls back to the light palette when no dark key is defined in
 * constants/colors.ts (the scaffold ships light-only by default).
 * When a sibling web artifact's dark tokens are synced into a `dark`
 * key, this hook will automatically switch palettes based on the
 * device's appearance setting.
 */
export function useColors() {
  const scheme = useColorScheme();
  // Keep the runtime fallback for light-only palettes without making the
  // scheme-independent `radius` token part of the palette index signature.
  const palettes = colors as typeof colors & {
    dark?: typeof colors.light;
  };
  const palette =
    scheme === 'dark' && palettes.dark
      ? palettes.dark
      : colors.light;
  return { ...palette, radius: colors.radius };
}
