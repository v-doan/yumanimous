import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const web = path.resolve(import.meta.dirname, '../..');
const read = (file: string) => readFileSync(path.join(web, file), 'utf8');

describe('installable web app', () => {
  const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
    start_url: string;
    display: string;
    icons: { src: string; sizes: string; purpose: string }[];
  };

  it('index.html links the manifest and the iOS home-screen icon', () => {
    const html = read('index.html');
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(existsSync(path.join(web, 'public/apple-touch-icon.png'))).toBe(true);
  });

  it('opens standalone at the home screen, with the icon sizes installs need', () => {
    expect(manifest).toMatchObject({ start_url: '/', display: 'standalone' });
    const sizes = manifest.icons.map((i) => `${i.sizes}:${i.purpose}`);
    expect(sizes).toEqual(
      expect.arrayContaining(['192x192:any', '512x512:any', '512x512:maskable']),
    );
  });

  it('every icon the manifest names exists', () => {
    for (const icon of manifest.icons) {
      expect(existsSync(path.join(web, 'public', icon.src)), icon.src).toBe(true);
    }
  });
});
