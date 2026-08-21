-- Small key/value store for facts about the deployment itself, as opposed to the
-- library. First use: when stall detection first ran, so its initial pass can
-- establish a baseline instead of alerting on every already-quiet series at once.
CREATE TABLE settings (
    key   text PRIMARY KEY,
    value text NOT NULL,
    set_at timestamptz NOT NULL DEFAULT now()
);
