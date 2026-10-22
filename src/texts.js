// -----------------------------------------------------------------------------
// Texts the integration writes outside the widget (src/widgets.js): the
// connection status, the "Test the connection" report, the errors, and what
// the bot answers in Zulip. Four languages, the four of the Gladys
// interface; German says "du", Spanish "usted". test/i18n.test.js checks
// every table.
// -----------------------------------------------------------------------------

import { ERROR_KINDS } from './zulip/client.js';

export const LANGUAGE_FALLBACK = 'en';

export const pick = (text, language) => text[language] ?? text[LANGUAGE_FALLBACK];

/** Applies `render` to each language of a table of functions. */
export const each = (table, render) =>
  Object.fromEntries(Object.entries(table).map(([lang, value]) => [lang, render(value, lang)]));

// One short explanation per error kind (src/zulip/client.js).
export const ERROR_TEXT = {
  [ERROR_KINDS.NOT_CONFIGURED]: {
    en: 'enter the address of the Zulip organization, the e-mail and the API key of the bot',
    fr: "saisissez l'adresse de l'organisation Zulip, l'e-mail et la clé d'API du robot",
    de: 'gib die Adresse der Zulip-Organisation, die E-Mail und den API-Schlüssel des Bots ein',
    es: 'introduzca la dirección de la organización Zulip, el correo y la clave de API del bot',
  },
  [ERROR_KINDS.INVALID_URL]: {
    en: 'organization address not understood, e.g. https://example.zulipchat.com',
    fr: "adresse de l'organisation incomprise, ex. https://example.zulipchat.com",
    de: 'Adresse der Organisation nicht verstanden, z. B. https://example.zulipchat.com',
    es: 'dirección de la organización no válida, p. ej. https://example.zulipchat.com',
  },
  [ERROR_KINDS.NO_CREDENTIALS]: {
    en: 'enter the e-mail and the API key of the bot',
    fr: "saisissez l'e-mail et la clé d'API du robot",
    de: 'gib die E-Mail und den API-Schlüssel des Bots ein',
    es: 'introduzca el correo y la clave de API del bot',
  },
  [ERROR_KINDS.UNREACHABLE]: {
    en: 'the Zulip server does not answer',
    fr: 'le serveur Zulip ne répond pas',
    de: 'der Zulip-Server antwortet nicht',
    es: 'el servidor Zulip no responde',
  },
  [ERROR_KINDS.TIMEOUT]: {
    en: 'the Zulip server answers too slowly',
    fr: 'le serveur Zulip répond trop lentement',
    de: 'der Zulip-Server antwortet zu langsam',
    es: 'el servidor Zulip responde demasiado lento',
  },
  [ERROR_KINDS.NOT_ZULIP]: {
    en: 'no Zulip server at this address: check it',
    fr: 'pas de serveur Zulip à cette adresse : vérifiez-la',
    de: 'kein Zulip-Server unter dieser Adresse: prüfe sie',
    es: 'no hay servidor Zulip en esta dirección: revísela',
  },
  [ERROR_KINDS.CREDENTIALS]: {
    en: 'bot e-mail or API key refused (wrong, regenerated or bot deactivated)',
    fr: "e-mail ou clé d'API du robot refusés (erronés, régénérés ou robot désactivé)",
    de: 'E-Mail oder API-Schlüssel des Bots abgelehnt (falsch, neu erzeugt oder Bot deaktiviert)',
    es: 'correo o clave de API del bot rechazados (erróneos, regenerados o bot desactivado)',
  },
  [ERROR_KINDS.FORBIDDEN]: {
    en: 'refused by the server: may the bot do this?',
    fr: 'refusé par le serveur : le robot a-t-il le droit de le faire ?',
    de: 'vom Server abgelehnt: Darf der Bot das?',
    es: 'rechazado por el servidor: ¿tiene el bot permiso para hacerlo?',
  },
  [ERROR_KINDS.NOT_FOUND]: {
    en: 'channel or user not found on the server',
    fr: 'canal ou utilisateur introuvable sur le serveur',
    de: 'Kanal oder Benutzer auf dem Server nicht gefunden',
    es: 'canal o usuario no encontrado en el servidor',
  },
  [ERROR_KINDS.REJECTED]: {
    en: 'refused by the server (private channel without the bot? message too long?)',
    fr: 'refusé par le serveur (canal privé sans le robot ? message trop long ?)',
    de: 'vom Server abgelehnt (privater Kanal ohne den Bot? Nachricht zu lang?)',
    es: 'rechazado por el servidor (¿canal privado sin el bot? ¿mensaje demasiado largo?)',
  },
  [ERROR_KINDS.RATE_LIMITED]: {
    en: 'too many requests: the server asks to slow down',
    fr: 'trop de requêtes : le serveur demande de ralentir',
    de: 'zu viele Anfragen: Der Server bittet um eine Pause',
    es: 'demasiadas solicitudes: el servidor pide ir más despacio',
  },
  [ERROR_KINDS.SERVER]: {
    en: 'the Zulip server answered with an error',
    fr: 'le serveur Zulip a répondu par une erreur',
    de: 'der Zulip-Server hat mit einem Fehler geantwortet',
    es: 'el servidor Zulip ha respondido con un error',
  },
  [ERROR_KINDS.QUEUE_EXPIRED]: {
    en: 'the event queue expired on the server: reconnecting',
    fr: "la file d'événements a expiré sur le serveur : reconnexion",
    de: 'die Ereigniswarteschlange ist auf dem Server abgelaufen: Verbinde neu',
    es: 'la cola de eventos ha caducado en el servidor: reconectando',
  },
};

/** The explanation of an error, in one language. */
export function errorText(err, language) {
  const text = ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER];
  return pick(text, language);
}

/** The explanation of an error, in the four languages. */
export const errorTexts = (err) =>
  each(ERROR_TEXT[err?.kind] ?? ERROR_TEXT[ERROR_KINDS.SERVER], (text) => text);

// The connection status of the Configuration screen when some watched channels
// or allowed people could not be found (the bot works with the others).
export const PARTIAL_STATUS = {
  en: (failed) => `Connected, but not found or not joined: ${failed}`,
  fr: (failed) => `Connecté, mais introuvables ou non rejoints : ${failed}`,
  de: (failed) => `Verbunden, aber nicht gefunden oder nicht beigetreten: ${failed}`,
  es: (failed) => `Conectado, pero no encontrados o sin acceso: ${failed}`,
};

// The report of the "Test the connection" action (and of the widget button).
export const REPORT_TEXT = {
  en: {
    connected: (user) => `Connected as ${user}.`,
    channels: (joined, total) => `Watched channels: ${joined}/${total}.`,
    noChannels: 'No watched channel yet.',
    users: (found, total) => `Allowed people found: ${found}/${total}.`,
    noUsers: 'No allowed person: the bot answers nobody.',
    failed: (error) => `Connection failed: ${error}.`,
  },
  fr: {
    connected: (user) => `Connecté en tant que ${user}.`,
    channels: (joined, total) => `Canaux surveillés : ${joined}/${total}.`,
    noChannels: 'Aucun canal surveillé pour l’instant.',
    users: (found, total) => `Personnes autorisées trouvées : ${found}/${total}.`,
    noUsers: 'Aucune personne autorisée : le robot ne répond à personne.',
    failed: (error) => `Échec de la connexion : ${error}.`,
  },
  de: {
    connected: (user) => `Verbunden als ${user}.`,
    channels: (joined, total) => `Beobachtete Kanäle: ${joined}/${total}.`,
    noChannels: 'Noch kein beobachteter Kanal.',
    users: (found, total) => `Erlaubte Personen gefunden: ${found}/${total}.`,
    noUsers: 'Keine erlaubte Person: Der Bot antwortet niemandem.',
    failed: (error) => `Verbindung fehlgeschlagen: ${error}.`,
  },
  es: {
    connected: (user) => `Conectado como ${user}.`,
    channels: (joined, total) => `Canales vigilados: ${joined}/${total}.`,
    noChannels: 'Todavía no hay ningún canal vigilado.',
    users: (found, total) => `Personas autorizadas encontradas: ${found}/${total}.`,
    noUsers: 'Ninguna persona autorizada: el bot no responde a nadie.',
    failed: (error) => `Fallo de conexión: ${error}.`,
  },
};

// What the bot writes in Zulip, in a direct message.
export const BOT_TEXT = {
  en: {
    linked: (name) =>
      `Hello ${name}! Your Zulip account is now linked to Gladys: write to me here.`,
    notLinked:
      'Your Zulip account is not linked to Gladys yet. In Gladys, open Integrations → Zulip → Configuration, click "Generate a link code", then send me the code here.',
    unavailable: 'Gladys cannot read your message right now, please try again later.',
  },
  fr: {
    linked: (name) => `Bonjour ${name} ! Votre compte Zulip est lié à Gladys : écrivez-moi ici.`,
    notLinked:
      'Votre compte Zulip n’est pas encore lié à Gladys. Dans Gladys, ouvrez Intégrations → Zulip → Configuration, cliquez sur « Générer un code de liaison », puis envoyez-moi le code ici.',
    unavailable: 'Gladys ne peut pas lire votre message pour l’instant, réessayez plus tard.',
  },
  de: {
    linked: (name) =>
      `Hallo ${name}! Dein Zulip-Konto ist jetzt mit Gladys verknüpft: Schreib mir hier.`,
    notLinked:
      'Dein Zulip-Konto ist noch nicht mit Gladys verknüpft. Öffne in Gladys Integrationen → Zulip → Konfiguration, klicke auf „Verknüpfungscode generieren“ und schick mir dann den Code hier.',
    unavailable: 'Gladys kann deine Nachricht gerade nicht lesen, versuch es später noch einmal.',
  },
  es: {
    linked: (name) => `¡Hola ${name}! Su cuenta Zulip está vinculada a Gladys: escríbame aquí.`,
    notLinked:
      'Su cuenta Zulip aún no está vinculada a Gladys. En Gladys, abra Integraciones → Zulip → Configuración, pulse «Generar un código de vinculación» y envíeme el código aquí.',
    unavailable: 'Gladys no puede leer su mensaje en este momento, inténtelo más tarde.',
  },
};
