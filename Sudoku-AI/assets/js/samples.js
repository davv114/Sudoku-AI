/**
 * Griglie di esempio per provare l'app anche senza fotocamera o API key.
 * Ogni stringa contiene 81 caratteri (0 = cella vuota).
 */

export const SAMPLES = [
  {
    id: 'facile',
    label: 'Facile',
    difficulty: 1,
    source: 'Esempio classico',
    grid:
      '530070000' +
      '600195000' +
      '098000060' +
      '800060003' +
      '400803001' +
      '700020006' +
      '060000280' +
      '000419005' +
      '000080079',
  },
  {
    id: 'medio',
    label: 'Medio',
    difficulty: 3,
    source: 'Project Euler #96',
    grid:
      '003020600' +
      '900305001' +
      '001806400' +
      '008102900' +
      '700000008' +
      '006708200' +
      '002609500' +
      '800203009' +
      '005010300',
  },
  {
    id: 'difficile',
    label: 'Difficile',
    difficulty: 5,
    source: 'Norvig, "hardest"',
    grid:
      '000000010' +
      '400000000' +
      '020000000' +
      '000050407' +
      '008000300' +
      '001090000' +
      '300400200' +
      '050100000' +
      '000806000',
  },
];

export function getSample(id) {
  return SAMPLES.find((sample) => sample.id === id) ?? SAMPLES[0];
}
