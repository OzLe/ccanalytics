# Security Policy

## Supported versions

ccanalytics is pre-1.0. Security fixes are applied to the latest released
version only; please upgrade before reporting an issue.

## Reporting a vulnerability

Please **do not open a public issue** for security vulnerabilities.

Instead, use GitHub's private vulnerability reporting:

1. Go to the repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue, including reproduction steps and impact.

You'll get an acknowledgement and a fix timeline through that private thread.

## Scope and threat model

ccanalytics is a **local-first** tool. It:

- reads Claude Code / Claude Desktop JSONL session files from your machine,
- stores derived analytics in a local DuckDB database under `~/.ccanalytics/`,
- never transmits your session data anywhere.

The optional web dashboard (`ccanalytics web`) runs an Express API and a Vite
server **bound to localhost**. It has permissive CORS and no authentication by
design — it is intended for single-user, local use only. **Do not expose the
web dashboard to untrusted networks** (e.g. by binding it to a public
interface or putting it behind a public proxy).

Reports about behavior outside this model — anything that exfiltrates local
data, executes untrusted input, or escalates beyond the invoking user — are
in scope and very welcome.
