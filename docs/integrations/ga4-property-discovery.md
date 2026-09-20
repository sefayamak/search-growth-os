# Finding the GA4 numeric property that owns `G-EYY9Z20XJ4`

`G-EYY9Z20XJ4` is a **measurement ID**: it identifies a web data stream, not a
property. The Data API only accepts the numeric **property ID**. One property
can own several streams, so the mapping must be read, never guessed.

Why this is open at all: the account listing shows six properties (decideplan,
My Happy Made, pamaistudio, Rightlisted, Sefa Yamak - GA4, Untitled Portraits)
and **none is named pamistanbul.com**. The most likely owner is
`Sefa Yamak - GA4` (426911036), the oldest and most generically named one, but
that is an inference and the registry keeps the field UNKNOWN until you confirm.

## Shortest exact procedure (about 30 seconds, no credentials needed)

1. Open GA4 and switch to the **Sefa Yamak** account (76122862).
2. Admin (bottom-left gear) → under **Property**, click **Data streams**.
3. Look at the stream list. The web stream shows its measurement ID on the right.
4. If it reads `G-EYY9Z20XJ4`, you are in the right property. Read its numeric ID
   from Admin → **Property settings** → **PROPERTY ID** (top right), or from the
   browser URL: `.../a76122862p<PROPERTY_ID>/...` — the digits after `p`.
5. If it does not match, use the property switcher at the top and repeat for the
   next property. Start with `Sefa Yamak - GA4`.

Send me the number only. It is not a secret and goes into `config/sites.yaml`.

### Faster if you prefer the URL

Open each property once and read the URL. In
`analytics.google.com/analytics/web/#/a76122862p551083665/...` the account is
`76122862` and the property is `551083665`. The property whose Data streams page
lists `G-EYY9Z20XJ4` is the one we want.

## Then: is `lead_form_submit` really a key event?

The registry currently lists `lead_form_submit` as the pilot's conversion event,
taken from the site repository's commit history. That is not evidence that GA4
records it, and it will not be used as a KPI until it is.

Once credentials exist, this is checked in one call rather than by eye:

```
runReport(property=properties/<ID>,
          dimensions=[eventName],
          metrics=[eventCount],
          dateRanges=[last 28 days])
```

Three possible outcomes, and each is reported as it is:

| Result | Meaning | What the registry gets |
|---|---|---|
| `lead_form_submit` appears with a non-zero count | the event fires | keep it, and confirm it is marked as a key event in Admin → Events |
| the event exists but the count is zero | tracking is wired but nothing converted, or it broke | keep it, flag the zero, do not treat it as a baseline |
| the event name is absent | it is not what GA4 actually records | replace it with the real event name; never keep a KPI that does not exist |

Worth knowing while you are in there: the site's own `docs/measurement/`
records that a lead was previously counted even when the form submission
failed, and that this was fixed on 2026-08-02 so a lead only fires on
backend-verified acceptance. That means any comparison spanning that date is
comparing two different definitions, which is exactly the kind of thing that
looks like a traffic drop and is not one.

## What I will not do

Guess the property ID. Enable the Admin API to enumerate properties (reporting
does not need it). Treat the measurement ID as a property ID. Report a
conversion number before the event is verified.
