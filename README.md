# DraftFlow

A small SillyTavern extension that generates **several consecutive character messages in one pass** by first
drafting them, then letting the model review and rewrite its own draft before anything is posted.

The idea is simple: the model is much better at fixing a scene it can *read* than at writing a perfect scene cold.
DraftFlow gives it that second look without you copy-pasting anything.

## How it works

1. **Draft pass** — a background generation (same character, persona, lorebook, author's note and chat history)
   writes a rough version of the next *N* messages. Content first, polish later.
2. **Review pass** — a second background generation receives the draft and a short rubric: continuity, character
   voice, no godmoding the user, turn-to-turn reactions, concrete detail. It silently fixes the problems and
   returns the final messages.
3. **Insert** — the final text is split on `@@TURN@@`, cleaned up, and turned into real character messages with
   SillyTavern's own message pipeline (avatar, swipes, token counts). The batch is tagged so it can be removed again
   with Undo.

Both passes use `generateQuietPrompt`, so they appear in the same context as your normal replies but never post a
message by themselves.

## Install

1. Copy the `SillyTavern-DraftFlow` folder into:
   `SillyTavern/data/<your-user>/extensions/`
   (for most installs that is `SillyTavern/data/default-user/extensions/`).
2. Reload the SillyTavern page.
3. Open the Extensions panel (plug icon) and enable **DraftFlow**.
4. Its settings drawer appears at the bottom of the Extensions panel.

No server restart is needed — only a page reload so the client discovers the new folder.

## Use

- Type and send your own message first.
- Then click the wand (magic wand) menu → **DraftFlow**, or press the **Generate now** button in the settings
  drawer, or run:

  ```
  /draftflow turns=3
  /draftflow turns=2 refine=false
  ```

The messages are inserted immediately. A toast confirms the count; use **Undo last batch** in the wand menu (or in
the settings drawer) to remove them.

> DraftFlow refuses to run while the input box contains unsent text. This is deliberate: it continues the chat that
> is already on screen, so the pending message must be sent first.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Messages per batch | 3 | 1–10 consecutive character messages. |
| Self-review pass | on | Two API calls. Turn it off to insert the raw draft (cheaper, rougher). |
| Max tokens per message | 400 | Output budget per turn. Raise it for long-form prose. |
| Draft / review prompts | built in | Editable under *Prompt templates*. `%TURNS%` and `%DRAFT%` are substituted by the extension; `{{char}}` / `{{user}}` are resolved by SillyTavern. |
| Undo last batch | — | Only available while the batch is still at the end of the chat. |

## Limitations (v0.1)

- **Solo chats only.** Group chats are blocked because speaker attribution across a batch needs a different design.
- **Two generations per run.** Expect roughly double latency and token cost compared with one normal reply.
- **Immediate insert, no preview.** That was the chosen workflow; the Undo button is the safety net.
- **Undo is conservative.** If you add or delete messages after a batch, Undo refuses rather than cutting into the
  middle of the chat.
- **Other extensions see each inserted message** through `MESSAGE_RECEIVED`. Auto-summary, TTS or similar features
  may react to a batch as N separate messages.
- **Parsing is marker-based.** If the model ignores `@@TURN@@`, you get fewer messages than requested (often one).
  Lower the batch size or strengthen the prompt template in that case.
- **No reasoning display.** Quiet generations have their reasoning stripped by default.

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| `/draftflow` is unknown | Extension not enabled, or the page was not reloaded after copying the folder. |
| "Send your typed message first" | Clear or send the input box, then run DraftFlow. |
| "Open a character chat first" | DraftFlow needs a character and a non-empty chat. |
| Nothing inserted, error toast | Check the ST server console and the browser console; the draft or review request failed or was stopped. |
| Only one message arrived | The model did not use the separator. Lower *Messages per batch* or edit the draft prompt. |
| Undo does nothing | The batch is no longer at the end of the chat, or you are in a different chat. |

## Files

```
SillyTavern-DraftFlow/
  manifest.json   extension manifest
  index.js        settings, pipeline, insertion, Undo, slash command
  settings.html   settings drawer
  style.css       minimal layout tweaks
```

## Design notes

- No imports from SillyTavern's module tree: everything is obtained through `SillyTavern.getContext()`, so the
  folder works from `data/<user>/extensions` or the global `public/scripts/extensions/third-party` directory
  without path edits.
- The draft and review passes are sequential, so even backends that allow only one request at a time are fine.
- The batch record lives in `chat_metadata.DraftFlow.lastBatch`, so Undo survives a page reload. The inserted
  messages are tagged in `message.extra.draftflowBatch`.
