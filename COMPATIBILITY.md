# Experimental compatibility providers

Legado and Venera are API 3 content providers. The host imports no engine code. The engines expose injectable network and state interfaces and can run outside Readest. Signed packages include the QuickJS WASM binary; imported source scripts execute only inside QuickJS, never in the outer worker JavaScript realm.

## Build and validation

Prepare `@readest/plugin-sdk` 0.2.0-x1 from the application checkout, then install dependencies:

```powershell
pnpm sdk:prepare --local ../readest-exp-network-sources/packages/plugin-sdk
pnpm update @readest/plugin-sdk
pnpm fixtures:prepare
pnpm check
pnpm test
pnpm build --dev --experimental --channel beta
```

Use `pnpm sign --experimental --channel beta` with the configured Ed25519 release signer for a release candidate. `--dev` uses a local test signer. Experimental release packages contain only Legado and Venera; stable Kavita/Komga 0.1.1 assets remain immutable. `node scripts/sign-plugins.mjs --test --test-all` includes all four packages only for development regression tests and rejects a production signer. Source script updates do not replace engine packages, and engine updates do not rewrite source definitions.

`tests/fixtures/sources.lock.json` pins the exact upstream revision, URL and SHA256 of each fixture. Replay tests use synthetic HTTP responses with unmodified upstream source rules. They do not prove current website availability. Optional live checks require `READEST_COMPATIBILITY_LIVE=1`; their `.artifacts/compatibility-live.json` report contains names, stages and errors, never credentials or chapter bodies. Live tests require search, details, chapters, nonempty content and an actual image download for comics. Missing chapters and empty responses fail verification.

## Boundaries

- One engine instance owns one QuickJS module and serializes its calls. Asyncify services support Legado's synchronous network calls; Venera network calls use VM promises.
- Defaults: 64 MiB VM memory, 512 KiB stack, 15 seconds per evaluation, 16 MiB response, 8 concurrent network requests, 4 MiB parser input, 50,000 HTML handles, 1 MiB stored value. Cancellation rejects pending calls even when the injected HTTP implementation fails to stop.
- All network requests and cookies go through the instance-bound public SDK. Permission and redirect enforcement remain host responsibilities. Cookie snapshots are loaded only for approved origins and never written into engine state.
- JSONPath scripting is disabled in the outer parser. JavaScript expressions run in QuickJS. Host regex rules reject excessive complexity; unrestricted source regex still runs inside the interrupted VM.
- Unsupported Android/Java classes, WebView authentication, image transforms, RSA and UI methods throw an identified unsupported-capability error. Runtime APIs are implemented according to tested source usage; this is not a claim of full ecosystem compatibility.
- Venera supports source JS import, source-list inspection, search defaults, grouped chapters, settings, state, HTML, encoding, hashing/HMAC, AES, form login, Cookie hooks and image request headers. Lists are inspected without fetching their children.
- Legado supports JSON/TXT rules, CSS/JSoup, XPath, JSONPath, regex, combinations, variables, templates, init rules, URL request options, basic form login, directory/content pagination and synchronous JavaScript networking. Remote `jsLib` dependencies and dynamic login UI protocols report unsupported capability.
- Native and web hosts have different network capabilities. The engine never adds a proxy or bypasses TLS/captcha checks.

## Dependencies and source provenance

All direct versions are fixed in `package.json` and transitively locked in `pnpm-lock.yaml`. QuickJS core/WASM 0.31.0 (MIT) is pinned because 0.32.0 failed runtime-disposal tests. Cheerio (MIT), xmldom (MIT), xpath (MIT), JSONPath Plus (MIT), safe-regex2 (MIT), iconv-lite-umd (MIT) and CryptoJS 4.2.0 (MIT) provide parsing/conversion. CryptoJS is upstream-discontinued; it is used only for compatibility digest/cipher operations, not passwords, randomness, signing or security protocols. The application never relies on MD5/SHA1 for integrity.

The Venera fixture repository does not provide a repository-wide LICENSE at the pinned revision. Its source scripts are test inputs, are not included in signed plugin packages, and their existing notices are preserved. XIU2 fixtures are GPL-3.0. The additional Shuhaige fixture is pinned to speauty/legado.sources commit `ff3e1928f575fb235a50cc54f286fbc1d1babe90`. Source archives exclude both downloaded Venera scripts and this additional fixture, retaining their pin/download script. New engine implementation is original code under this repository's AGPL-3.0 license.

Live acceptance on Windows/Node 24.20.0 passed MangaDex, Komiic and Comick including actual image bytes, and 酷我小说, 阅友小说 and 书海阁 including nonempty visible chapter text. The original XIU2 acceptance candidates remain in replay tests; their current sites required authentication/WebView, returned HTTP errors, or failed TLS/network requests. Additional accessible sources were used for live acceptance, with raw definitions unchanged. `tests/fixtures/sources.lock.json` records all fixture digests; `.artifacts/compatibility-live.json` keeps per-source results and timestamps. This verifies engine behavior against these endpoints, not native/browser host behavior, which is tested separately in the application.

`prepare-sdk` accepts an explicit local SDK path for development and requires an immutable application commit for CI. The experimental workflow builds and uploads an immutable artifact before a separate publication job, so a failed upload can resume with the original bytes. Release repository URLs point to the prerelease assets; users select the beta channel. Stable Pages and Kavita/Komga releases remain unchanged. Build and publication were authorized on 2026-10-23 and remain gated by the SDK pin and compatibility checks.
