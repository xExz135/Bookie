import { ConfigError, loadConfig } from './app-config';
import { renderEnvExample } from './env-example';
import { PARAMS } from './params';

describe('loadConfig', () => {
  it('uses the spec defaults when nothing is set (D-008)', () => {
    const config = loadConfig({});
    expect(config.TASTE_MIN_RATED_FOR_CONFIDENCE).toBe(10);
    expect(config.TASTE_HARD_FLOOR).toBe(3);
    expect(config.EVIDENCE_MAX_REVIEWS).toBe(75);
    expect(config.SCAN_RESIZE_MAX_PX).toBe(1024);
    expect(config.SEARCH_MAX_CANDIDATES).toBe(3);
    expect(config.ONBOARDING_ALLOW_SKIP).toBe(true);
    expect(config.NODE_ENV).toBe('development');
  });

  it('reads numbers and booleans from strings', () => {
    const config = loadConfig({ TASTE_HARD_FLOOR: '4', ONBOARDING_ALLOW_SKIP: 'false' });
    expect(config.TASTE_HARD_FLOOR).toBe(4);
    expect(config.ONBOARDING_ALLOW_SKIP).toBe(false);
  });

  it('treats empty values as not set', () => {
    expect(loadConfig({ TASTE_HARD_FLOOR: '', GEMINI_API_KEY: '  ' }).TASTE_HARD_FLOOR).toBe(3);
  });

  it('rejects a value that is not a number and names the setting', () => {
    expect(() => loadConfig({ EVIDENCE_MAX_REVIEWS: 'many' })).toThrow(/EVIDENCE_MAX_REVIEWS/);
  });

  it('rejects a hard floor above the confidence minimum', () => {
    expect(() =>
      loadConfig({ TASTE_HARD_FLOOR: '12', TASTE_MIN_RATED_FOR_CONFIDENCE: '10' }),
    ).toThrow(/TASTE_HARD_FLOOR/);
  });

  it('rejects a scan confidence outside 0 to 1', () => {
    expect(() => loadConfig({ SCAN_MIN_CONFIDENCE: '1.5' })).toThrow(/SCAN_MIN_CONFIDENCE/);
  });

  it('requires AUTH_TOKEN_SECRET in production', () => {
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_TOKEN_SECRET/);
  });

  it('generates a random secret outside production', () => {
    const a = loadConfig({}).AUTH_TOKEN_SECRET;
    const b = loadConfig({}).AUTH_TOKEN_SECRET;
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });

  it('never echoes a secret value in its error message', () => {
    const secret = 'too-short-secret-value';
    try {
      loadConfig({ AUTH_TOKEN_SECRET: secret });
      throw new Error('expected loadConfig to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toContain('AUTH_TOKEN_SECRET');
      expect((error as Error).message).not.toContain(secret);
    }
  });
});

describe('.env.example', () => {
  const text = renderEnvExample();

  it('lists every setting with its source', () => {
    for (const [key, def] of Object.entries(PARAMS)) {
      expect(text).toMatch(new RegExp(`^${key}=`, 'm'));
      expect(text).toContain(`[${def.source}]`);
    }
  });

  it('never contains a value for a secret', () => {
    for (const [key, def] of Object.entries(PARAMS)) {
      if ('secret' in def && def.secret) expect(text).toMatch(new RegExp(`^${key}=$`, 'm'));
    }
  });
});
