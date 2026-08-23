-- Sources behind a paid subscription.
--
-- Manta gave three free chapters and then served a six-page purchase notice for the next
-- 99. Every one downloaded, every one recorded as a success, and the ledger then believed
-- those chapters were held, so a real source's chapter 4 would have been skipped as
-- already present. Silently storing a paywall notice is worse than storing nothing.
--
-- Matched on the source name with a case-insensitive regex, because a source's name is
-- stable across Suwayomi instances while its numeric id is not, and one publisher ships
-- several language variants under one name stem.
CREATE TABLE paid_source (
    pattern    text PRIMARY KEY,
    note       text,
    added_at   timestamptz NOT NULL DEFAULT now()
);

INSERT INTO paid_source (pattern, note) VALUES
  ('manta',       'subscription; three free chapters then a six-page purchase notice'),
  ('comikey',     'subscription and per-chapter unlock'),
  ('coolmic',     'subscription'),
  ('mangamo',     'subscription'),
  ('toomics',     'subscription and per-chapter unlock'),
  ('lezhin',      'per-chapter purchase'),
  ('tappytoon',   'per-chapter purchase'),
  ('tapas',       'ink-based per-chapter unlock'),
  ('inkr',        'subscription'),
  ('netcomics',   'subscription'),
  ('pocket ?comics', 'per-chapter unlock'),
  ('piccoma',     'per-chapter unlock'),
  ('bilibili',    'per-chapter unlock'),
  ('futekiya',    'subscription'),
  ('renta',       'rental and purchase'),
  ('azuki',       'subscription'),
  ('manga ?planet', 'subscription'),
  ('kmanga',      'per-chapter unlock');
