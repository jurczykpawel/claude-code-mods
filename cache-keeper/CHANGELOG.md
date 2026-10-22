# Changelog

## 1.6.0

- Start keep warm automatically with `CACHE_KEEPER_KEEPWARM_HOURS=1–72`, including on resume. Every real message restarts the time limit; `/keepwarm off` still stops it.
- Skip the cold-send dialog for unattended sessions with `CACHE_KEEPER_GUARD=off`, without changing saved settings for other chats.
- Ignore missing or invalid environment values.
