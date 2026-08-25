/**
 * SMITE 2 god roster, as SmiteSource URL slugs (https://smitesource.com/god/<slug>).
 * Taken from smitesource.com's sitemap; add new slugs here as gods release.
 */
export const GOD_SLUGS = [
  'achilles', 'agni', 'ah-puch', 'aladdin', 'amaterasu', 'anhur', 'anubis',
  'aphrodite', 'apollo', 'ares', 'artemis', 'artio', 'athena', 'atlas',
  'awilix', 'bacchus', 'bari', 'baron-samedi', 'bastet', 'bellona',
  'cabrakan', 'cerberus', 'cernunnos', 'chaac', 'charon', 'chiron',
  'chronos', 'cu-chulainn', 'cupid', 'da-ji', 'danzaburou', 'discordia',
  'eset', 'fenrir', 'ganesha', 'geb', 'gilgamesh', 'guan-yu', 'hades',
  'hecate', 'hercules', 'horus', 'hou-yi', 'hun-batz', 'ishtar', 'ix-chel',
  'izanami', 'janus', 'jing-wei', 'jormungandr', 'kali', 'khepri',
  'kukulkan', 'loki', 'medusa', 'mercury', 'merlin', 'mordred',
  'morgan-le-fay', 'mulan', 'ne-zha', 'neith', 'nemesis', 'nu-wa', 'nut',
  'odin', 'osiris', 'pele', 'poseidon', 'ra', 'rama', 'ratatoskr', 'scylla',
  'sobek', 'sol', 'sun-wukong', 'susano', 'sylvanus', 'thanatos',
  'the-morrigan', 'thor', 'tsukuyomi', 'ullr', 'vulcan', 'xbalanque',
  'xing-tian', 'yemoja', 'ymir', 'zeus',
];

/** Slugs whose display name isn't just Title-Cased words. */
const DISPLAY_OVERRIDES = {
  'cu-chulainn': 'Cú Chulainn',
  'morgan-le-fay': 'Morgan Le Fay',
  'the-morrigan': 'The Morrigan',
};

export function godDisplayName(slug) {
  return (
    DISPLAY_OVERRIDES[slug] ||
    slug
      .split('-')
      .map((w) => w[0].toUpperCase() + w.slice(1))
      .join(' ')
  );
}

export function godPageUrl(slug) {
  return `https://smitesource.com/god/${slug}`;
}

// Each god as its sequence of lowercase word tokens ("baron-samedi" →
// ["baron","samedi"]), longest first so "morgan-le-fay" wins over "ra".
const GOD_TOKENS = GOD_SLUGS.map((slug) => ({ slug, tokens: slug.split('-') })).sort(
  (a, b) => b.tokens.length - a.tokens.length
);

const tokenize = (text) =>
  String(text)
    .toLowerCase()
    // Normalize accents/apostrophes (Cú → cu, Chang'e → change) before splitting.
    .normalize('NFD')
    .replace(/[̀-ͯ'']/g, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * Find a god name inside free-form rich-presence text. Matches whole word
 * sequences only, so short names ("Ra", "Nut", "Sol") can't false-positive as
 * substrings of other words. Returns the slug, or null.
 */
export function findGodIn(texts) {
  const words = texts.filter(Boolean).flatMap(tokenize);
  for (const { slug, tokens } of GOD_TOKENS) {
    for (let i = 0; i + tokens.length <= words.length; i++) {
      if (tokens.every((t, j) => words[i + j] === t)) return slug;
    }
  }
  return null;
}
