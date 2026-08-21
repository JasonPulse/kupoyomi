-- A wider search has to be resumable: there are 538 en/all extensions against 18
-- installed, each install is an APK download plus a dex2jar conversion, and the sweep
-- takes hours. Recording what has been tried means it can stop and continue.
CREATE TABLE probe_attempt (
    pkg_name    text PRIMARY KEY,
    sources     integer NOT NULL DEFAULT 0,
    hits        integer NOT NULL DEFAULT 0,
    kept        boolean NOT NULL DEFAULT false,
    error       text,
    probed_at   timestamptz NOT NULL DEFAULT now()
);
