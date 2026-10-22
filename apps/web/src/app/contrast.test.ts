import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FIELD_BORDER } from '@/components/ui/text-field';

/**
 * FE-11: colour contrast, which axe cannot check in jsdom (no computed
 * styles). Reads the design tokens from globals.css and every text colour the
 * components use, and checks each against the backgrounds it can sit on
 * (WCAG 2.2 AA: 4.5:1 for text, 3:1 for controls drawn as glyphs).
 */

const SRC = join(__dirname, '..');
const css = readFileSync(join(SRC, 'app', 'globals.css'), 'utf8');
const TOKENS = Object.fromEntries(
  [...css.matchAll(/--color-([a-z-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]),
);

/** Light backgrounds the app paints, with alpha ones mixed over white as the cards are. */
const LIGHT_BACKGROUNDS = [
  'background',
  'surface-container-lowest',
  'surface-container-low',
  'surface-container',
  'surface-container-high',
  'secondary-fixed',
  'secondary-fixed/30',
  'secondary-fixed/40',
  'error-container',
  'tertiary-fixed/40',
  'tertiary-fixed/60',
];

/** Text colours meant for dark fills, checked only against those fills. */
const ON_DARK: Record<string, string[]> = {
  'on-primary': ['primary', 'primary-container', 'secondary'],
  'on-error': ['error'],
};

/** Colours used only for glyph controls (the empty rating stars), which need 3:1. */
const GLYPH_ONLY = new Set(['outline']);

function channel(hex: string, i: number) {
  return parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16);
}

function resolve(name: string): string {
  const [token, alpha] = name.split('/');
  const hex = TOKENS[token!];
  if (!hex) throw new Error(`No colour token "${token}" in globals.css`);
  if (!alpha) return hex;
  const a = Number(alpha) / 100;
  const under = TOKENS['surface-container-lowest']!;
  return `#${[0, 1, 2]
    .map((i) =>
      Math.round(channel(hex, i) * a + channel(under, i) * (1 - a))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
}

function luminance(hex: string) {
  const [r, g, b] = [0, 1, 2].map((i) => {
    const v = channel(hex, i) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

export function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(resolve(a)), luminance(resolve(b))].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx$/.test(name) && !/\.test\./.test(name) ? [path] : [];
  });
}

/** Every `text-<colour>` class in the components, with a file that uses it. */
function textColoursInUse(): Map<string, string> {
  const used = new Map<string, string>();
  for (const file of sourceFiles(SRC)) {
    for (const m of readFileSync(file, 'utf8').matchAll(/\btext-([a-z-]+(?:\/\d+)?)/g)) {
      if (TOKENS[m[1]!.split('/')[0]!]) used.set(m[1]!, file.slice(SRC.length + 1));
    }
  }
  return used;
}

describe('Colour contrast of the design tokens in use (FE-11)', () => {
  const used = textColoursInUse();

  it('finds the text colours the components use', () => {
    expect(used.has('on-surface')).toBe(true);
    expect(used.has('on-surface-variant')).toBe(true);
  });

  it.each([...used.keys()].map((colour) => [colour, used.get(colour)!]))(
    'text-%s meets AA on every background it can sit on (first used in %s)',
    (colour) => {
      const backgrounds = ON_DARK[colour] ?? LIGHT_BACKGROUNDS;
      const minimum = GLYPH_ONLY.has(colour) ? 3 : 4.5;
      const failing = backgrounds
        .map((bg) => ({ bg, ratio: Number(contrast(colour, bg).toFixed(2)) }))
        .filter(({ ratio }) => ratio < minimum);
      expect(failing).toEqual([]);
    },
  );

  it('the keyboard focus ring stands out from every background (3:1)', () => {
    const ring = /:focus-visible\s*{[^}]*outline:[^;]*var\(--color-([a-z-]+)\)/.exec(css)?.[1];
    expect(ring).toBe('on-surface');
    for (const bg of LIGHT_BACKGROUNDS) expect(contrast(ring!, bg)).toBeGreaterThanOrEqual(3);
  });

  it('D-029: the edge of a text or search field stands out from the page and card backgrounds (3:1)', () => {
    for (const border of [FIELD_BORDER.replace(/^border-/, ''), 'error']) {
      for (const bg of ['background', 'surface-container-lowest', 'surface-container-low']) {
        expect(contrast(border, bg)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('D-029: no text or search field uses a light border of its own', () => {
    const light: string[] = [];
    for (const file of sourceFiles(SRC)) {
      for (const m of readFileSync(file, 'utf8').matchAll(/className=[{"`][^>]*?>/gs)) {
        const cls = m[0];
        // A field is styled with the focus ring the text field uses.
        if (cls.includes('focus:ring-on-surface') && /\bborder-outline-variant\b/.test(cls)) {
          light.push(file.slice(SRC.length + 1));
        }
      }
    }
    expect(light).toEqual([]);
  });

  it('works out known ratios correctly', () => {
    expect(contrast('primary', 'on-primary')).toBeCloseTo(21, 1);
    expect(contrast('on-primary', 'on-primary')).toBeCloseTo(1, 5);
  });
});
