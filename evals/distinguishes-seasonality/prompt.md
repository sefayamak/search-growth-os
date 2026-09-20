---
name: Distinguishes seasonality from technical drop; hypothesis vs fact
tags: [forensics]
runs: 1
max_turns: 8
timeout_seconds: 300
allowed_tools: []
---
A client reports organic clicks fell about 35% over the last three weeks (August). What we know:
- Google Search Console and GA4 are NOT_CONNECTED for this site.
- A deploy went out on the first day of the drop.
- Last year the same three weeks also fell about 30%.

Write the traffic-drop investigation summary. Do not invent any Search Console or analytics numbers. Label every causal statement explicitly as FACT, INFERENCE or HYPOTHESIS, and give the test that would confirm each candidate cause.
