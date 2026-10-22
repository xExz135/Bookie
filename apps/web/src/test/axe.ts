import axe from 'axe-core';

/**
 * Accessibility violations axe-core finds in the rendered page (FE-11), as
 * readable lines. Colour contrast is left out: jsdom computes no styles, so
 * src/app/contrast.test.ts checks the design tokens in use instead.
 */
export async function axeViolations(root: Element = document.body): Promise<string[]> {
  const result = await axe.run(root, {
    resultTypes: ['violations'],
    rules: { 'color-contrast': { enabled: false } },
  });
  return result.violations.map(
    (v) =>
      `${v.id} (${v.impact}): ${v.help}. ${v.nodes
        .slice(0, 3)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
}
