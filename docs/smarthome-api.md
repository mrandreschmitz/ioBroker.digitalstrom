# Smart Home API paths

The adapter uses the digitalSTROM Smart Home API for two optional bulk reads:

```text
GET /api/v1/apartment/meterings/values   (all meter values, one request)
GET /api/v1/apartment/status             (all device output values, one request)
```

All structure reads, device and zone commands, sensor values, button events and scene events continue
to use the classic dSS JSON API. The notification websocket and the other methods implemented by the
client are not started by the adapter.

## Output values

With the option enabled, the initial output reads at startup and the re-reads after a scene call are
served by ONE apartment status request instead of one classic read per output channel. Triggers are
collected for two seconds, so a room scene across many devices still costs a single request.

The status delivers each output already in the scale the ioBroker states use: the API normalizes every
channel to its official value range (brightness 0..100, colortemp 0..1000, ...), which is exactly the
`classic * max / nativeMax` conversion of the classic read callbacks. Values are rounded to whole
numbers like before, and the brightness of a light goes through the same helper that maintains the
boolean `.state` including the switch threshold.

Rules learned from live measurements against a real dSS:

- An output that is currently moving carries NO `value` field in the status. Missing means
  "unchanged", never null. The channel is asked again after 15 seconds, up to four times - after that
  the classic read delivers whatever it can.
- Boolean output channels (`airLouverAuto`, `airFlowAuto`) stay on the classic read; their 0/1
  representation in the new API is not verified.
- A failed status request falls back to the classic reads immediately and pauses the Smart Home reads
  for five minutes.

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

## Which API is working

`info.meteringApi` holds the API that delivered the last meter reading:

| value | meaning |
| --- | --- |
| `smarthome` | every circuit came from the Smart Home API, one request per cycle |
| `classic` | the classic API did the work, either completely or for the circuits the new API left out |

The state changes only when the path changes, so it can be charted without noise. The classic API is
what serves everything else, so as long as devices, scenes and sensors keep updating it is working.

`info.connection` is deliberately NOT set by a cycle that only used the Smart Home API: such a cycle
sends no classic request and therefore cannot testify about it. A dSS that is really unreachable still
turns the connection off, because the new API fails as well and the classic fallback reports it.
