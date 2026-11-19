# Security model

This plugin gives an AI assistant access to a local search index over *your own*
text files. It runs entirely on your machine. This page states exactly what it
does, what it does not do, and what you are trusting when you install it.

## What it never does

- **No network egress.** The plugin and the Python engine talk to
  `127.0.0.1` only. There is no telemetry, no analytics, no cloud call. You can
  verify this yourself: every `fetch(` / `http` call in the source is either
  `127.0.0.1:<port>` or a `file:` path.
- **No remote service.** No account, no API key, no server of ours.
- **No destructive filesystem operation.** There is no delete, move, rename or
  permission change anywhere in the code. The index it writes lives in its own
  directory; removing that directory is the uninstall.
- **No admin rights.** The installer creates a private virtual environment
  inside the plugin folder and installs Python packages there. It does not touch
  PATH, the registry, or anything system-wide.
- **No reading outside what you point it at.** It only reads files under the
  source folders you register (plus the folder of the session you are in, if
  automatic project registration is on), for the extensions listed in the
  config.

## What it does, and what that implies

| Behaviour | Why | Implication |
|---|---|---|
| Runs a local HTTP service on `127.0.0.1:8479` | so search costs ~0.2 s instead of spawning Python each time | bound to loopback only, and every request is checked for a loopback `Host`, a loopback (or absent) `Origin`, and rejection of `Sec-Fetch-Site: cross-site`, so a web page cannot drive it; a local process without a browser origin still can, because there is no token auth |
| Binds loopback only, and refuses non-loopback unless `service.allow_remote` is explicitly set to `true` | a misconfiguration must not publish your notes to the LAN | if you enable it, you own the consequences |
| Spawns `python.exe` and, for the "open folder" buttons, your OS file manager | that is how the engine runs | no shell string interpolation: arguments are passed as an array |
| Reads and writes `engine/config.json` | shared configuration between the two halves | a corrupt config is reported, never silently rewritten into something else |
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
  a report can be reproduced.

## Reporting

If you find a security problem, please open a private security advisory on the
repository (or contact the maintainer directly) rather than a public issue, and
include: DSH version, plugin version, OS, and the smallest reproduction you can
manage. Please do not include your indexed content or personal paths.
