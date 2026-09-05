import { describe, it, expect } from 'vitest';
import { SponsorInput, linkText } from '../../src/modules/sponsor/repo';

// The sponsored card's link goes to every install and is handed straight to a
// phone's launcher, so both halves matter: what gets through, and what the row
// ends up holding once it has.

const base = { enabled: false, brand: 'UltraTech' };

/** The stored `linkUrl` for one kind + one typed value, or the error message. */
function save(linkKind: string, linkUrl: string): string {
  const r = SponsorInput.safeParse({ ...base, linkKind, linkUrl });
  return r.success ? r.data.linkUrl : (r.error.issues[0]?.message ?? 'rejected');
}

describe('sponsor link — what each kind accepts', () => {
  it('keeps an https address as it stands', () => {
    expect(save('web', 'https://ultratechcement.com/dealers')).toBe(
      'https://ultratechcement.com/dealers',
    );
  });

  it('still refuses anything but https, whatever scheme it wears', () => {
    for (const bad of ['ultratechcement.com', 'http://x.com', 'javascript:alert(1)', 'intent://x']) {
      expect(save('web', bad)).toMatch(/https:\/\//);
    }
  });

  it('turns a typed phone number into a tel: URI, spacing and all', () => {
    expect(save('phone', '+91 98765-43210')).toBe('tel:+919876543210');
    expect(save('phone', '(0744) 2345678')).toBe('tel:07442345678');
  });

  it('will not take a phone number that is not one', () => {
    expect(save('phone', '12345')).toMatch(/6 to 15 digits/);
    expect(save('phone', 'call us')).toMatch(/6 to 15 digits/);
  });

  it('builds a wa.me link, and insists on the country code', () => {
    expect(save('whatsapp', '+91 98765 43210')).toBe('https://wa.me/919876543210');
    // Ten digits is an Indian number with the 91 left off — wa.me would open a
    // chat with nobody, so it is stopped here rather than on the phone.
    expect(save('whatsapp', '9876543210')).toMatch(/country code/);
  });

  it('writes an email as mailto:', () => {
    expect(save('email', ' sales@ultratech.com ')).toBe('mailto:sales@ultratech.com');
    expect(save('email', 'sales@ultratech')).toMatch(/email address/);
  });

  it('accepts an empty link for every kind — no link means no button', () => {
    for (const kind of ['web', 'phone', 'whatsapp', 'email']) {
      expect(save(kind, '')).toBe('');
    }
  });

  it('defaults to web, which is what every row written before this existed meant', () => {
    const r = SponsorInput.safeParse({ ...base, linkUrl: 'https://x.com' });
    expect(r.success && r.data.linkKind).toBe('web');
  });
});

describe('linkText — what the app puts on the button', () => {
  it('undresses each URI back to the readable form', () => {
    expect(linkText('phone', 'tel:+919876543210')).toBe('+919876543210');
    expect(linkText('email', 'mailto:sales@ultratech.com')).toBe('sales@ultratech.com');
    expect(linkText('whatsapp', 'https://wa.me/919876543210')).toBe('+919876543210');
    expect(linkText('web', 'https://ultratechcement.com/')).toBe('ultratechcement.com');
  });

  it('is empty when there is no link at all', () => {
    expect(linkText('web', '')).toBe('');
  });
});
