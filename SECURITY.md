# Security model

This plugin gives an AI assistant access to a local search index over *your own*
text files. It runs entirely on your machine. This page states exactly what it
does, what it does not do, and what you are trusting when you install it.

## What it never does

- **No network egress while running.** The plugin and the Python engine talk to
  `127.0.0.1` only. There is no telemetry, no analytics, no cloud call. You can
  verify this yourself: every `fetch(` / `http` call in the source is either
  `127.0.0.1:<port>` or a `file:` path.
- **Installation is the one time it goes online.** `scripts/setup.ps1` /
  `scripts/download_models.py` use `pip` and Hugging Face to fetch Python
  packages and the embedding model (optionally through `-Mirror`, and pinned with
  `-Revision` / `HF_REVISION` when you want reproducibility). After that, running
  the plugin needs no network.
- **No remote service.** No account, no API key, no server of ours.
- **No destructive operation on your documents.** It never deletes, moves or
  renames anything you registered. Inside *its own data directory* it does
  replace index files atomically (`os.replace`) and remove its own temporary
  files and stale lock files (`os.unlink`) — that is how a half-written index can
  never be loaded. Removing the data directory is the uninstall.
- **No admin rights.** The installer creates a private virtual environment
  inside the plugin folder and installs Python packages there. It does not touch
  PATH, the registry, or anything system-wide.
- **No reading outside what you point it at, except the session archive you can
  turn off.** It reads the source folders you register (plus the folder of the
  session you are in, if automatic project registration is on), for the
  extensions listed in the config. Separately, the "last session brief" feature
  reads your local DSH session archive under `~/.dsh/sessions` and writes
  plain-text transcripts and summary cards for the *same* sessions into the data
  directory (`<data_dir>/transcripts`, `<data_dir>/cards`) so they can be
  searched later. Set `handoff.auto_archive` to `false` to disable that part
  entirely.

## What it does, and what that implies

| Behaviour | Why | Implication |
|---|---|---|
| Runs a local HTTP service on `127.0.0.1:8479` | so search costs ~0.2 s instead of spawning Python each time | bound to loopback only, and every request is checked for a loopback `Host`, a loopback (or absent) `Origin`, and rejection of `Sec-Fetch-Site: cross-site`, so a web page cannot drive it; a local process without a browser origin still can, because there is no token auth |
| Binds loopback only, and refuses non-loopback unless `service.allow_remote` is explicitly set to `true` | a misconfiguration must not publish your notes to the LAN | if you enable it, you own the consequences |
| Spawns `python.exe` and, for the "open folder" buttons, your OS file manager | that is how the engine runs | no shell string interpolation: arguments are passed as an array |
| Reads and writes `engine/config.json` | shared configuration between the two halves | a corrupt config is reported, never silently rewritten into something else |
| Writes plain-text session transcripts and cards | so "what did we talk about last time" is searchable on this machine | they sit in the data directory in clear text; they never leave the machine, and `handoff.auto_archive=false` turns the feature off |
| Sends retrieved text to whatever model DSH is talking to | this is the whole point: the assistant sees the passages | text you index is only as private as your model provider — the plugin adds no extra exposure |

## What it does not protect against

- **Another process on your machine.** Local processes already share your user
  account and can read the same files directly. Do not treat the local HTTP
  service as a boundary between users on a shared machine.
- **Malicious content in indexed files.** Retrieved passages are shown to the
  model as context. If you index files written by untrusted parties, treat them
  like untrusted input (the plugin does not execute anything it finds there, but
  the model may be influenced by text it reads).
- **Supply chain of the dependencies.** `torch`, `sentence-transformers` and
  friends are installed from official indexes. Floors are declared in
  `scripts/requirements.txt`; the installer prints the exact versions it used so
  a report can be reproduced. Model downloads default to the official Hugging
  Face repository and accept `-Mirror` / `-Revision` overrides.

## Reporting

If you find a security problem, please open a **private security advisory** on
the repository rather than a public issue, and include: DSH version, plugin
version, OS, and the smallest reproduction you can manage. Please do not include
your indexed content or personal paths.

General questions and bug reports are welcome in the repository's issues and
discussions.
