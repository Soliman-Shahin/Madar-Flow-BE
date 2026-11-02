import { clientPlatform, describeDevice } from '../utils/device.util';

const req = (headers: Record<string, string>) => ({
  get: (name: string) => headers[name.toLowerCase()],
});

describe('device util', () => {
  it('labels desktop browsers', () => {
    expect(
      describeDevice(
        req({
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
        })
      )
    ).toBe('Chrome on Windows');
    expect(
      describeDevice(
        req({
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0',
        })
      )
    ).toBe('Edge on Windows');
    expect(
      describeDevice(
        req({
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
        })
      )
    ).toBe('Safari on macOS');
  });

  it('uses the phone model on Android', () => {
    expect(
      describeDevice(
        req({
          'user-agent':
            'Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UP1A.231005.007) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
        })
      )
    ).toBe('Pixel 7 · Chrome');
  });

  it('labels iPhones and returns nothing without a user agent', () => {
    expect(
      describeDevice(
        req({
          'user-agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        })
      )
    ).toBe('Safari on iOS');
    expect(describeDevice(req({}))).toBeUndefined();
  });

  it('reads the platform header and defaults to web', () => {
    expect(clientPlatform(req({ 'x-client-platform': 'ios' }))).toBe('ios');
    expect(clientPlatform(req({ 'x-client-platform': 'android' }))).toBe('android');
    expect(clientPlatform(req({ 'x-client-platform': 'plan9' }))).toBe('web');
    expect(clientPlatform(req({}))).toBe('web');
  });
});
