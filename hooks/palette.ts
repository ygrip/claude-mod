// pi-jar's amber theme (themes/pi-jar-dark-amber.json): the one place colors live.

export const AMBER = {
  accent: '#F7B955',
  selected: '#3A2B0F',
  text: '#F7FAFF',
  muted: '#ADBCCD',
  dim: '#899AAD',
  border: '#405269',
  green: '#48DDAE',
  red: '#FF8A70',
  amber: '#FFC060',
  blue: '#8DB9FF',
  violet: '#A28BB8',
} as const

export type Rgb = readonly [number, number, number]

export const AMBER_RGB: Rgb = [247, 185, 85]

/** Dark surfaces from pi-jar's export block and vars. */
export const DARK_SURFACES = {
  page: '#0B1018',
  card: '#111927',
  user: '#16202E',
  custom: '#172233',
} as const

/** A lamp-lit parchment counterpart for light mode. */
export const LIGHT_SURFACES = {
  page: '#EFE4CF',
  card: '#F5ECDB',
  panel: '#FBF6EA',
  text: '#2B2114',
  secondary: '#5A4A33',
  muted: '#6E5D45',
} as const

export function rgbToInt(color: Rgb): number {
  const [red, green, blue] = color

  return (red << 16) | (green << 8) | blue
}
