import request from 'supertest';
import { configureExpressApp } from '../app';
import { Category, User } from '../models';
import { CONSENT_VERSIONS } from '../config/consent.config';
import { encryptCryptoJS } from '../shared/encryption-cryptojs-compat';
import { planService } from '../services/plan.service';

/**
 * Native Google sign-in: Google may FILL a missing name or picture, but a
 * later sign-in must never overwrite what the user changed in the app.
 */
const app = configureExpressApp();
const AUD = 'test-web-client-id.apps.googleusercontent.com';
const consent = {
  termsAccepted: true,
  privacyAccepted: true,
  termsVersion: CONSENT_VERSIONS.terms,
  privacyVersion: CONSENT_VERSIONS.privacy,
};

let ip = 0;
const freshIp = () => `10.77.0.${++ip}`;
const realFetch = global.fetch;

function mockGoogle(info: Record<string, unknown>) {
  const png = Buffer.from([137, 80, 78, 71]);
  global.fetch = jest.fn(async (url: any) => {
    if (String(url).includes('oauth2.googleapis.com/tokeninfo')) {
      return { ok: true, status: 200, json: async () => info } as any;
    }
    return {
      ok: true,
      headers: { get: () => 'image/png' },
      arrayBuffer: async () =>
        png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
    } as any;
  }) as any;
}

async function nativeLogin() {
  const res = await request(app)
    .post('/v1/user/auth/google/native')
    .set('X-Forwarded-For', freshIp())
    .send({ data: encryptCryptoJS({ idToken: 'fake-id-token', ...consent }) });
  return res;
}

const googleInfo = (over: Record<string, unknown> = {}) => ({
  aud: AUD,
  sub: 'google-sub-1',
  email: 'native-user@example.test',
  email_verified: 'true',
  name: 'Google Name',
  picture: 'https://lh3.googleusercontent.com/a/google-photo=s96-c',
  ...over,
});

beforeAll(() => {
  process.env.GOOGLE_WEB_CLIENT_ID = AUD;
});
beforeEach(async () => {
  await planService.seedDefaultPlans();
});
afterEach(() => {
  global.fetch = realFetch;
});

describe('native Google sign-in keeps the user\'s own name and photo', () => {
  it('creates the account with Google data and the two starter categories', async () => {
    mockGoogle(googleInfo());
    const res = await nativeLogin();
    expect(res.status).toBe(200);
    const user = await User.findOne({ email: 'native-user@example.test' });
    expect(user?.username).toBe('Google Name');
    expect(user?.image).toMatch(/^data:image\/png;base64,/);
    const cats = await Category.find({ user: user!._id });
    expect(cats.map((c) => c.title).sort()).toEqual(['Income', 'Uncategorized']);
    expect(cats.every((c) => c.isStarter)).toBe(true);
  });

  it('does not put Google\'s name and photo back after the user changed them', async () => {
    mockGoogle(googleInfo({ sub: 'google-sub-2', email: 'keeps@example.test' }));
    expect((await nativeLogin()).status).toBe(200);
    await User.updateOne(
      { email: 'keeps@example.test' },
      { username: 'My Own Name', image: 'data:image/jpeg;base64,MINE' }
    );

    // Same person signs in again; Google now reports a different name/photo.
    mockGoogle(
      googleInfo({
        sub: 'google-sub-2',
        email: 'keeps@example.test',
        name: 'Renamed On Google',
        picture: 'https://lh3.googleusercontent.com/a/new-photo=s96-c',
      })
    );
    expect((await nativeLogin()).status).toBe(200);
    const user = await User.findOne({ email: 'keeps@example.test' });
    expect(user?.username).toBe('My Own Name');
    expect(user?.image).toBe('data:image/jpeg;base64,MINE');
  });

  it('fills a missing photo from Google', async () => {
    mockGoogle(googleInfo({ sub: 'google-sub-3', email: 'fills@example.test' }));
    expect((await nativeLogin()).status).toBe(200);
    await User.updateOne({ email: 'fills@example.test' }, { $unset: { image: 1 } });
    expect((await nativeLogin()).status).toBe(200);
    const user = await User.findOne({ email: 'fills@example.test' });
    expect(user?.image).toMatch(/^data:image\/png;base64,/);
  });
});
