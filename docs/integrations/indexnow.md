# IndexNow

State today: **UNKNOWN** (key not configured; hosting not checked).

Protocol facts (indexnow.org): key file `https://<host>/<key>.txt` containing the key (8–128 chars of a-z A-Z 0-9 -); submit to `https://api.indexnow.org/indexnow` with `host`, `key`, `keyLocation`, `urlList` (batches up to 10,000); one submission is shared with participating engines (Bing, Yandex, Naver, Seznam, Yep). Google does not use IndexNow.

Phase 1: the adapter only **checks** that the key file is hosted (`indexNow.keyHosted`). Submission is a production-facing action and is deliberately not implemented until change management for it is agreed (submit only changed canonical URLs, never bulk re-submission).
