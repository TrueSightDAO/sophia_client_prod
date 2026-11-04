import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function loadScript(name: string) {
  const src = readFileSync(join(ROOT, 'js', name), 'utf8');
  const fn = new Function('window', src);
  fn(window);
}

loadScript('crypto.js');
loadScript('chat.js');
loadScript('auth.js');

const Chat = (window as any).SophiaChat;
const Auth = (window as any).SophiaAuth;

describe('detectAttachments', () => {
  const base = 'https://sophia.truesight.me';

  it('detects /uploads/ paths as images resolved against the base', () => {
    const found = Chat.detectAttachments('see /uploads/abc123.png here', base);
    expect(found).toHaveLength(1);
    expect(found[0].type).toBe('image');
    expect(found[0].url).toBe(base + '/uploads/abc123.png');
  });

  it('detects markdown image syntax', () => {
    const found = Chat.detectAttachments('![x](https://cdn.example.com/a.jpg)', base);
    expect(found).toHaveLength(1);
    expect(found[0].url).toBe('https://cdn.example.com/a.jpg');
  });

  it('dedupes the same URL', () => {
    const found = Chat.detectAttachments('/uploads/a.png and /uploads/a.png', base);
    expect(found).toHaveLength(1);
  });

  it('returns [] for plain text', () => {
    expect(Chat.detectAttachments('nothing to see', base)).toHaveLength(0);
  });
});

describe('imageFilesFromClipboardItems', () => {
  const mkItem = (kind: string, type: string, file: File | null) => ({
    kind,
    type,
    getAsFile: () => file,
  });

  it('extracts image items and gives them timestamped names', () => {
    const png = new File(['x'], 'image.png', { type: 'image/png' });
    const items = [
      mkItem('string', 'text/plain', null),
      mkItem('file', 'image/png', png),
      mkItem('file', 'application/pdf', new File(['p'], 'a.pdf', { type: 'application/pdf' })),
    ];
    const files = Chat.imageFilesFromClipboardItems(items);
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe('image/png');
    expect(files[0].name).toMatch(/^pasted-\d+-\d+\.png$/);
  });

  it('normalizes jpeg to .jpg', () => {
    const jpg = new File(['y'], 'image.jpeg', { type: 'image/jpeg' });
    const files = Chat.imageFilesFromClipboardItems([mkItem('file', 'image/jpeg', jpg)]);
    expect(files).toHaveLength(1);
    expect(files[0].name).toMatch(/\.jpg$/);
  });

  it('returns [] when no image items are present', () => {
    expect(Chat.imageFilesFromClipboardItems([])).toEqual([]);
    expect(Chat.imageFilesFromClipboardItems([mkItem('string', 'text/plain', null)])).toEqual([]);
  });
});

describe('signMessage payload shape', () => {
  it('builds {message,timestamp,nonce,do_not_publish} and a base64 signature', async () => {
    const { body, publicKey } = await Auth.signMessage('hello', false);
    expect(body.payload.message).toBe('hello');
    expect(body.payload.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(body.payload.nonce).toBeTruthy();
    expect(body.payload.do_not_publish).toBe(false);
    expect(typeof body.signature).toBe('string');
    expect(body.signature.length).toBeGreaterThan(20);
    expect(publicKey).toBeTruthy();

    // The signature must verify against the canonical JSON (round-trip).
    const ok = await (window as any).SophiaCrypto.verifySignature(
      publicKey, body.payload, body.signature
    );
    expect(ok).toBe(true);
  });
});
