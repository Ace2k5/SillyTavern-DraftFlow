# DraftFlow

A small SillyTavern extension that gives the model **one extra turn to review its own reply** before you move on.

After each character message is generated, DraftFlow runs one hidden generation in which the model reads that
exact message, critiques it privately, and rewrites it. The rewrite replaces the draft **in place**, so the chat
history keeps a single message — the revised one.

This is not a multi-turn batch generator. One reply in, one improved reply out.

## What it looks like

1. You send your message. SillyTavern generates the character's reply normally, and it appears.
2. DraftFlow immediately dims that message and runs one quiet review generation.
3. When the rewrite arrives, the message text is replaced (swipes, token count and rendering are updated too).
   A toast confirms it, and **Revert last refinement** restores the previous text if you prefer it.

Because the draft is generated first, you will briefly see the original reply and then the revised version. That
is intentional: the model is reviewing the message it actually wrote, not a separate planning draft.

## How it works

- Listens for `CHARACTER_MESSAGE_RENDERED` before other extensions, so the review runs on fresh replies and swipes.
- Builds a quiet prompt containing the reply plus a rubric: continuity, character voice, no godmoding the user,
  concrete detail, no repeated beats, preserved facts and length.
- Requests the rewrite between `<revised>` and `</revised>` tags, with the raw output as a fallback.
- Replaces `message.mes`, the active swipe, its swipe metadata, and the token count, then re-renders and saves the chat.
- Stores the previous text in `chat_metadata.DraftFlow.lastRefinement` so the most recent swap can be reverted.

Everything is obtained through `SillyTavern.getContext()`, so the folder works from
`data/<user>/extensions` or the global `public/scripts/extensions/third-party` directory without path edits.

## Install

1. Copy the `SillyTavern-DraftFlow` folder into `SillyTavern/data/<your-user>/extensions/`
   (usually `SillyTavern/data/default-user/extensions/`), or install it from
   `https://github.com/Ace2k5/SillyTavern-DraftFlow` through the Extensions manager.
2. Reload the SillyTavern page.
3. Open the Extensions panel (plug icon) and enable **DraftFlow**.

Only a page reload is needed, not a server restart.

## Usage

- **Automatic (default):** enabled on install. Every new character reply gets one review pass.
- **Manual:** wand menu → **DraftFlow: refine last reply**, the button in the settings drawer, or
  `/draftflow`. Manual runs work even when automatic refinement is off.
- **Undo a swap:** wand menu → **DraftFlow: revert last refinement**, or the button in the settings drawer.

Refinement is skipped when it would be unsafe or pointless: group chats, first messages, continuations, system
messages, stopped generations, an already-refined message, or a chat/message that changed mid-pass.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Refine every new reply automatically | on | Off means only manual runs. |
| Also refine swipes and regenerations | on | Off limits automatic refinement to fresh replies; `/draftflow` still works on a swipe. |
| Max revision tokens | 0 (auto) | Auto sizes the budget from the reply, about 1.3×. Raise for long replies that get cut off. |
| Review prompt | built in | Editable. `%DRAFT%` is replaced with the reply; `{{char}}` / `{{user}}` are resolved by SillyTavern. |

## Cost

Two generations per refined reply instead of one, so roughly double latency and tokens. The draft is still
generated at normal speed; the extra time is spent while the response is dimmed. Turn the automatic toggle off
if you only want the pass occasionally.

## Limitations

- **Solo character chats only.** Group chats are skipped in this version.
- **The reply visibly changes.** This is the requested behavior; if you need the final text to appear only once,
  the review has to run before display, which delays the first output by a full generation.
- **Revert is one step.** Only the most recent refinement can be undone, and only while the message still contains
  the revised text.
- **Tag-based parsing.** If the model ignores `<revised>`, the whole cleaned output is used. A model that writes a
  critique into the same block can leak it into the reply; shorten or harden the review prompt if that happens.
- **Edited/deleted messages during a pass** cause that revision to be discarded rather than overwriting your edit.
- **Streaming does not hide the draft.** Streaming finishes, the message is rendered, then the revision replaces it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Replies never change | Enable the extension and the "Refine every new reply" toggle; check the browser console for `[DraftFlow]` errors. |
| "Refinement cancelled" | You pressed stop, or the generation was aborted. The original reply stays. |
| Only the first part of the reply is revised | Raise **Max revision tokens** or set it to 0 for auto. |
| Revert button missing | The last refinement belongs to another chat, or the message text no longer matches the stored revision. |
| `/draftflow` is unknown | Extension is disabled or the page was not reloaded after installing. |

## Version history

- **0.2.0** — rewritten as an automatic post-reply self-review pass with in-place replacement and one-step revert.
  The earlier on-demand multi-message generator was removed.
- **0.1.0** — initial batch generator (draft several messages on demand).

## Files

```
SillyTavern-DraftFlow/
  manifest.json   extension manifest
  index.js        review pipeline, replacement, revert, settings, /draftflow
  settings.html   settings drawer
  style.css       refinement indicator and layout
```
