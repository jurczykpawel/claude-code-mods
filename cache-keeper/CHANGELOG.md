# Changelog

## 1.6.1

- Keep warm now pings while a turn waits for your answer (a question, a permission) or for a long command. Before, it paused for the whole turn, so the cache expired after about an hour of waiting even though the footer showed the window as kept. A ping is held back only while a model request is actually in flight.

## 1.6.0

- Start keep warm automatically with `CACHE_KEEPER_KEEPWARM_HOURS=1–72`, including on resume. Every real message restarts the time limit; `/keepwarm off` still stops it.
- Skip the cold-send dialog for unattended sessions with `CACHE_KEEPER_GUARD=off`, without changing saved settings for other chats.
- Ignore missing or invalid environment values.
