# Smart Home API meter path

The adapter uses the digitalSTROM Smart Home API only for the optional bulk read of meter values:

```text
GET /api/v1/apartment/meterings/values
```

All structure reads, device and zone commands, sensor values, button events and scene events continue
to use the classic dSS JSON API. The notification websocket and the other methods implemented by the
client are not started by the adapter.

## Requirements and activation

- dSS firmware 1.19 or newer
- an application API key for the Smart Home API
- **Read meter values through the new API** enabled in the adapter settings

The button in the settings creates the API key from the existing classic App-Token. The key is stored
as an encrypted and protected native setting. The option is disabled by default. If it is disabled or
no key is configured, meter values use the classic API exactly as before.

On adapter shutdown, an in-flight key request is aborted locally and any late reply is ignored. An HTTP
abort cannot undo work the dSS may already have completed: if shutdown happens after the server accepted
the creation request but before the adapter received the reply, an unused application token may remain
on the dSS.

## Validation and fallback

One circuit is accepted only when the response contains both a finite power value and a finite energy
value. Numeric strings are converted to numbers. `null`, empty strings, `NaN` and infinite values are
treated as missing.

When only some circuits are incomplete, the adapter performs the two classic reads only for those
circuits. A transport, authentication or schema error falls back to the classic path for all circuits.
The completion status counts the requests that were actually attempted.

After a failed Smart Home request, another optional attempt is delayed by 5, 10, 20, 40 and then at
most 60 minutes. HTTP 401 and 403 start directly with the 60-minute delay. Normal classic polling
continues during the delay. Any usable Smart Home response resets the backoff.

## Energy unit

On the verified dSS20 with firmware 1.19.13 the API labels the cumulative value as `Wh`, but the value
matches the classic watt-second counter. The adapter therefore keeps the classic conversion:

```text
kWh = value / 3600 / 1000
```

This path should remain marked experimental until it has been compared on additional dSS hardware and
firmware versions.
