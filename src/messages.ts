import { MAX_PHRASE_LENGTH, MAX_TRANSLATION_LENGTH } from './db.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from './passwords.js';
import { MAX_CONTEXT_LENGTH } from './suggest.js';

/** The languages the app can show, chosen by each user. */
export type Language = 'en' | 'es';

export const LANGUAGES: readonly Language[] = ['en', 'es'];

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

/**
 * The language to answer in, from an Accept-Language header such as
 * "es-CR,es;q=0.9,en;q=0.8": the most preferred one the app has, or English.
 */
export function languageFrom(header: string | undefined): Language {
  const preferred = (header ?? '')
    .split(',')
    .map((part) => {
      const [tag, ...params] = part.trim().split(';');
      const q = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      return { language: tag.trim().toLowerCase().split('-')[0], q: q ? Number(q.slice(2)) : 1 };
    })
    .filter(({ q }) => Number.isFinite(q) && q > 0)
    .sort((a, b) => b.q - a.q)
    .find(({ language }) => isLanguage(language));
  return (preferred?.language as Language | undefined) ?? 'en';
}

const en = {
  notLoggedIn: 'Not logged in',
  wrongLogin: 'Wrong email or password',
  loginRequired: 'Email and password are required',
  signupRequired: 'Email, password, and invite code are required',
  unusableInvite: 'This invite is not valid, was already used, or has expired',
  invalidEmail: 'Enter a valid email',
  passwordTooShort: `Use at least ${MIN_PASSWORD_LENGTH} characters for the password`,
  passwordTooLong: `Use at most ${MAX_PASSWORD_LENGTH} characters for the password`,
  emailTaken: 'An account with that email already exists',
  onlyAdminInvites: 'Only the admin can invite people',
  invalidText: `Phrase must be 1 to ${MAX_PHRASE_LENGTH} characters`,
  invalidTranslation: `Translation must be text of up to ${MAX_TRANSLATION_LENGTH} characters`,
  invalidContext: `Context must be text of up to ${MAX_CONTEXT_LENGTH} characters`,
  phraseNotFound: 'Phrase not found',
  translationUnavailable: "Translation isn't available",
  translationLimit: (limit: number) => `You've used today's ${limit} translations. More tomorrow.`,
  translationFailed: "Couldn't translate right now",
  suggestionsUnavailable: "Suggestions aren't available right now",
  suggestionLimit: (limit: number) => `You've used today's ${limit} suggestions. More tomorrow.`,
  suggestionsFailed: "Couldn't get an answer right now. Try again.",
  invalidRecording: 'Send the recording as audio',
  recordingTooLong: 'The recording is too long. Say just the phrase.',
  pronunciationUnavailable: "Pronunciation scores aren't available right now",
  pronunciationLimit: (limit: number) => `You've used today's ${limit} pronunciation scores. More tomorrow.`,
  pronunciationFailed: "Couldn't score it right now. Try again.",
  noSpeech: "Couldn't hear you. Get closer to the microphone and try again.",
};

export type Messages = typeof en;

const es: Messages = {
  notLoggedIn: 'No has iniciado sesión',
  wrongLogin: 'Correo o contraseña incorrectos',
  loginRequired: 'Escribe tu correo y tu contraseña',
  signupRequired: 'Escribe el correo, la contraseña y el código de invitación',
  unusableInvite: 'Esta invitación no es válida, ya se usó o venció',
  invalidEmail: 'Escribe un correo válido',
  passwordTooShort: `Usa al menos ${MIN_PASSWORD_LENGTH} caracteres en la contraseña`,
  passwordTooLong: `Usa como máximo ${MAX_PASSWORD_LENGTH} caracteres en la contraseña`,
  emailTaken: 'Ya existe una cuenta con ese correo',
  onlyAdminInvites: 'Solo el administrador puede invitar personas',
  invalidText: `La frase debe tener de 1 a ${MAX_PHRASE_LENGTH} caracteres`,
  invalidTranslation: `La traducción debe tener como máximo ${MAX_TRANSLATION_LENGTH} caracteres`,
  invalidContext: `El contexto debe tener como máximo ${MAX_CONTEXT_LENGTH} caracteres`,
  phraseNotFound: 'No se encontró la frase',
  translationUnavailable: 'La traducción no está disponible',
  translationLimit: (limit) => `Ya usaste las ${limit} traducciones de hoy. Mañana tendrás más.`,
  translationFailed: 'No se pudo traducir en este momento',
  suggestionsUnavailable: 'Las sugerencias no están disponibles en este momento',
  suggestionLimit: (limit) => `Ya usaste las ${limit} sugerencias de hoy. Mañana tendrás más.`,
  suggestionsFailed: 'No se pudo obtener una respuesta. Inténtalo de nuevo.',
  invalidRecording: 'Envía la grabación como audio',
  recordingTooLong: 'La grabación es demasiado larga. Di solo la frase.',
  pronunciationUnavailable: 'La calificación de pronunciación no está disponible en este momento',
  pronunciationLimit: (limit) => `Ya usaste las ${limit} calificaciones de pronunciación de hoy. Mañana tendrás más.`,
  pronunciationFailed: 'No se pudo calificar en este momento. Inténtalo de nuevo.',
  noSpeech: 'No te escuché. Acércate al micrófono e inténtalo de nuevo.',
};

const MESSAGES: Record<Language, Messages> = { en, es };

/** The API's messages for people, in the given language. */
export function messagesFor(language: Language): Messages {
  return MESSAGES[language];
}
