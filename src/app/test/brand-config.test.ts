import { BRAND } from '../config/brand.config';

describe('backend brand configuration', () => {
  it('defines the approved public identity and the Orbit Madar contact values', () => {
    expect(BRAND.productName).toBe('Madar Flow');
    expect(BRAND.companyName).toBe('Orbit Madar');
    expect(BRAND.attribution).toBe('Madar Flow by Orbit Madar');
    expect(BRAND.supportEmail).toBe('info@orbit-madar.com');
    expect(BRAND.website).toBe('https://orbit-madar.com');
  });
});
