# Cora meeting page

The page Recall.ai renders as Cora's camera and microphone in meetings. No secrets live here: the voice session is issued by the cora-voice Supabase function only for bots it created.

Security: every script loads from this origin, and each page carries a Content-Security-Policy listing the only hosts it may talk to. `elevenlabs-client-0.16.0.js` is `@elevenlabs/client` 0.16.0 with `livekit-client` 2.22.3, bundled with `bun build --format=iife` from the npm packages (tarball integrity checked) and loaded with an SRI hash; rebuild it and update the `integrity` attribute in `index.html` to upgrade. `libsamplerate-2.1.2.worklet.js` is the resampler the SDK would otherwise fetch from jsdelivr. `show.html` only frames https pages on forgex.ai and futurexgtm.com.
