import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import viteConfig from '../vite.config.js';

describe('static deployment configuration', () => {
  it('uses relative assets so a GitHub project page can host the build', () => {
    expect(viteConfig).toMatchObject({ base: './' });
  });

  it('keeps LAN development on one explicit port', () => {
    expect(viteConfig).toMatchObject({
      server: { host: '0.0.0.0', port: 5173, strictPort: true },
    });
  });

  it('keeps the compiler workbench focused on emitted JavaScript', () => {
    const page = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    expect(page).toContain('Generated JavaScript');
    expect(page).toContain('id="simulation-reset"');
    expect(page).toContain('id="state-signal-quality"');
    expect(page).not.toContain('Parse + semantic result');
    expect(page).not.toContain('class="hero"');
    expect(page).not.toContain('Project milestones');
  });

  it('precaches the production shell and bundled compiler worker', () => {
    const worker = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
    expect(worker).toContain('precacheApplication()');
    expect(worker).toContain('(?:parser|test)\\.worker-');
    expect(worker).toContain("request.mode === 'navigate'");
    expect(worker).toContain('CACHE_NAMESPACE');
    expect(worker).toContain('isWithinAppScope');
  });
});
