import { describe, expect, it } from 'vitest';
import { languageFrom, messagesFor } from '../src/messages.js';

describe('languageFrom', () => {
  it.each([
    [undefined, 'en'],
    ['', 'en'],
    ['es', 'es'],
    ['es-CR', 'es'],
    ['ES-mx,en;q=0.5', 'es'],
    ['en-US,es;q=0.9', 'en'],
    ['fr-FR,es;q=0.8,en;q=0.5', 'es'],
    ['en;q=0.2,es;q=0.9', 'es'],
    ['fr, de', 'en'],
    ['es;q=0', 'en'],
  ])('reads %j as %s', (header, expected) => {
    expect(languageFrom(header)).toBe(expected);
  });
});

describe('messagesFor', () => {
  it('has every message in both languages', () => {
    const english = messagesFor('en');
    const spanish = messagesFor('es');

    expect(Object.keys(spanish).sort()).toEqual(Object.keys(english).sort());
    for (const key of Object.keys(english) as (keyof typeof english)[]) {
      expect(typeof spanish[key]).toBe(typeof english[key]);
      expect(spanish[key]).not.toEqual(english[key]);
    }
  });
});
