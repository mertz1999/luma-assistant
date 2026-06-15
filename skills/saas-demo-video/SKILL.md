---
name: saas-demo-video
description: Create cinematic SaaS demo video pages and screen-recordable product presentations. Use when Codex is asked to build a /demo route, animated product walkthrough, SaaS promo presentation, screen-recording page, narrated product demo, cursor-driven UI story, or reusable demo-video system for an app or website.
---

# SaaS Demo Video

## Outcome

Build a full-screen, automatically moving demo page that can be recorded as a polished SaaS product video. Prefer a short customer story over a feature tour: problem hook, product action, customer moment, result reveal, business outcome, final CTA.

Use this skill to create or improve routes such as `/demo`, `/presentation`, `/video-demo`, or equivalent standalone HTML/React pages.

## Required Inputs

Collect or infer these before implementation. Ask only for blockers.

- Product name, domain, audience, and main promise.
- Target duration and aspect ratio, usually 30-60 seconds and 16:9.
- Existing app routes to show: signup, dashboard, product creation, link creation, customer page, analytics.
- Brand assets: logo, colors, fonts, product images, customer images, screenshots, icons, phone frames.
- Real workflow constraints: what the app actually does, what is manual, what is automatic, what data is available.
- Voiceover script or timeline. If the user has generated audio, use the exact timestamps.
- Final CTA and recording URL.

Never invent behavior that the product does not support. If a shop manually copies a link, say that instead of saying the app sends it automatically.

## Storyboard

Default 30-50 second structure:

1. Problem hook: show a realistic customer question or pain.
2. Admin action: add product, create private link, copy message.
3. Customer moment: customer receives link, opens it, uploads image, starts generation.
4. Result reveal: before/product/result side-by-side with a clean reveal animation.
5. Business outcome: dashboard metrics that matter.
6. Final CTA: short product promise and domain.

Use the app's real domain and real product language. For social commerce, show Instagram-style DM UI only as a visual story device unless the product actually integrates with Instagram APIs.

## Implementation Pattern

Use the app's existing stack. For Next.js apps, prefer:

- A route such as `src/app/demo/page.tsx`.
- A client component for the timed presentation.
- Framer Motion for scene transitions, cursor movement, reveal effects, shimmer, and zoom.
- Existing UI components, logo, palette, and assets.
- Query param scene preview, for example `/demo?scene=resultReveal`.

Core demo component behavior:

- Define scenes as data: `id`, `title`, `caption`, `durationMs`, `cursor`, and optional visual focus/camera metadata.
- Compute scene start times from `durationMs`.
- Use a wall-clock timeline so dev hot reloads or rerenders do not reset playback unexpectedly.
- Add play, pause, restart, previous, and next controls unless the user wants a pure recording page.
- If syncing with generated audio, make scene durations exactly match the audio timestamp ranges.
- Add `data-demo-cursor-target` attributes to important UI controls and calculate cursor positions from `getBoundingClientRect()`. Avoid hardcoded cursor coordinates when a real target exists.
- Use `ResizeObserver` and `requestAnimationFrame` to keep cursor targets accurate across viewport sizes.
- Respect reduced-motion settings.

## Visual Direction

Make it feel like a modern SaaS launch/demo video:

- Full-screen stage, not a normal documentation page.
- Cinematic zoom-ins on important clicks.
- Smooth cursor motion that continues from the previous cursor position.
- Short overlay captions: "1. Add product", "2. Send link", "3. Customer tries it on".
- Real app screenshots or realistic UI mockups inside browser/phone frames.
- A result reveal moment with flash, wipe, blur-to-sharp, or side-by-side comparison.
- Clean dashboard outcome shot with 2-4 high-signal metrics.
- No dense paragraphs, no developer logs, no fake technical jargon.

For mobile customer flows, use a phone frame. Ensure the content inside it remains legible on desktop and mobile recording viewports.

## Narration And Timing

If the user needs voiceover, provide a prompt for a voice model:

- Tone: confident, warm, premium, clear, not robotic.
- Pace: match target duration.
- Pronunciation notes for product name.
- Timestamped script by scene.

If the user provides generated audio timestamps, update the scene durations to those exact ranges and verify the total duration.

See `references/storyboard-and-voiceover.md` for reusable timing and narration templates.

## Validation

Before finishing:

- Run the app locally or confirm the existing dev/prod server.
- Run relevant checks: typecheck, lint, build, or framework equivalent.
- Use Playwright/browser checks at desktop and mobile sizes.
- Verify no horizontal overflow.
- Verify phone-frame content is visible.
- Verify cursor lands on the intended buttons using DOM target measurements.
- Verify each preview scene works through query params if implemented.
- Verify final public URL or local URL returns `200 OK`.
- If a video iframe is embedded, verify the iframe is present in rendered HTML.

Report any known dev-only warnings separately, such as Next HMR WebSocket failures on public IP dev servers.

## Delivery

Return:

- Demo page URL.
- What route/files were added or changed.
- Scene duration table.
- Voiceover prompt if requested.
- Validation commands/results.
- Any recording notes, such as recommended viewport size and whether to hide controls.
