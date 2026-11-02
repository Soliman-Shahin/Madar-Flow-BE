import { hasStoredAvatar, resolveGoogleAvatar } from '../utils/avatar.util';

describe('avatar util', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('treats the legacy placeholder and empty values as "no picture"', () => {
    expect(hasStoredAvatar(undefined)).toBe(false);
    expect(hasStoredAvatar('')).toBe(false);
    expect(hasStoredAvatar('profile.png')).toBe(false);
    expect(hasStoredAvatar('data:image/png;base64,AAAA')).toBe(true);
    expect(hasStoredAvatar('https://lh3.googleusercontent.com/a/x')).toBe(true);
  });

  it('stores a Google picture as a data URL', async () => {
    const png = Buffer.from([1, 2, 3, 4]);
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    }) as any;
    const out = await resolveGoogleAvatar(
      'https://lh3.googleusercontent.com/a/abc=s96-c'
    );
    expect(out).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect((global.fetch as jest.Mock).mock.calls[0][0]).toContain('=s256-c');
  });

  it('keeps the plain URL when the download fails', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network')) as any;
    const url = 'https://lh3.googleusercontent.com/a/abc';
    expect(await resolveGoogleAvatar(url)).toBe(url);
  });

  it('never fetches hosts other than Google user content', async () => {
    global.fetch = jest.fn() as any;
    const url = 'https://evil.example.com/a.png';
    expect(await resolveGoogleAvatar(url)).toBe(url);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
