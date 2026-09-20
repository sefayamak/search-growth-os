---
name: media-search-audit
description: Audit images and video as search assets — alt semantics, captions, surrounding text, dimensions, lazy loading, responsive delivery, image sitemap needs, video metadata/transcripts/thumbnails, and whether key original visuals are discoverable. Use for a photo/film studio's portfolio visibility.
allowed-tools: Bash(npm run cli*) Read Grep Glob Agent
arguments: [site_url]
---
**Evidence**: `media.*` findings, `records[].html.images`, source templates for background-image/CSS-only visuals.
**Procedure**: `search-performance-engineer` reviews delivery and discoverability; `content-evidence-strategist` reviews captions/surrounding text for real descriptive value.
**Stop**: no keyword-stuffed alt text; alt describes actual visual meaning.
