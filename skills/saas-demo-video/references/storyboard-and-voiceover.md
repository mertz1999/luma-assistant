# Storyboard And Voiceover Templates

## 30-Second SaaS Story

| Time | Scene | Voiceover |
|---|---|---|
| 0.0-3.0 | Problem hook | A customer asks the question every shop hears: can I see how this looks on me? |
| 3.0-6.0 | Admin action | The shop adds the product image and saves the product in seconds. |
| 6.0-9.0 | Link creation | The app creates a private customer link with limits and expiration. |
| 9.0-12.0 | Manual send | The app prepares a message so the owner can copy it and send it manually. |
| 12.0-17.0 | Customer flow | The customer opens the link, uploads one photo, and starts the try-on. |
| 17.0-22.0 | Generation | The app generates the result while preserving the customer image and applying product details. |
| 22.0-26.0 | Result | The customer sees the product on their own photo. |
| 26.0-30.0 | Outcome/CTA | The shop tracks activity and creates private try-on links in seconds. |

## 48-Second SaaS Story

Use when the user already has generated narration around 45-50 seconds.

| Time | Scene |
|---|---|
| 0.0-4.6 | Problem hook |
| 4.6-9.4 | Add product |
| 9.4-13.9 | Create private link |
| 13.9-19.5 | Copy ready message |
| 19.5-22.2 | Send link through existing channel |
| 22.2-26.9 | Customer opens link and uploads |
| 26.9-33.1 | Generation animation |
| 33.1-38.0 | Result reveal |
| 38.0-43.9 | Dashboard outcome |
| 43.9-47.9 | Final CTA |

## Voice Model Prompt

```text
Create a polished SaaS demo voiceover.

Tone:
Confident, warm, modern, premium, and clear.
Sound like a professional SaaS product demo, not a hard sales ad.
Pacing should match the timestamps exactly.
Use natural pauses between scenes.
Avoid sounding robotic, overly excited, or dramatic.

Pronunciation:
Pronounce {{productName}} as "{{pronunciation}}".

Script:
{{timestampedScript}}
```

## Implementation Checklist

- Use real screenshots/assets where possible.
- Keep captions short enough to read without blocking the UI.
- Put cursor targets on real elements with `data-demo-cursor-target`.
- Use DOM measurement for cursor positioning.
- Add `/demo?scene=<id>` preview support.
- Test 1440x900 and a mobile viewport such as 390x844.
- Match scene durations to generated audio exactly when provided.
