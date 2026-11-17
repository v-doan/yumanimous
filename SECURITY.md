# Security

Yumanimous is a portfolio project, deployed at https://yumanimous.fly.dev. How it is hardened is
described in the [README](README.md#security).

## Reporting a vulnerability

Please report security issues privately through GitHub: **Security → Report a vulnerability** on
this repository. Don't open a public issue for them.

Useful to include: what you found, how to reproduce it, and what an attacker could do with it.
You'll get a reply within a few days.

## Scope

In scope: the deployed site and API, its WebSocket sessions, and the code in this repository.
Out of scope: denial of service by volume, and the third-party services it calls (Spoonacular,
Anthropic, Fly.io, Neon). Please don't run automated scanners at a rate that affects other users,
and don't access sessions that aren't yours.
