# DraftFlow

A small SillyTavern extension that gives the model **one extra turn to review its own reply against your active
preset** before you move on.

After each character message is generated, DraftFlow runs one hidden generation in two steps: the model first
audits the reply against the rules in the active preset and character card (format, sections, tags, language
rules, analysis/translation blocks, POV, and so on), then rewrites the reply so those rules are satisfied. The
rewrite replaces the draft **in place**, so the chat history keeps a single message — the revised one.

This is not a multi-turn batch generator. One reply in, one more compliant reply out.

## What it looks like

1. You send your message. SillyTavern generates the character's reply normally, and it appears.
2. DraftFlow dims that message and runs one quiet review generation.
3. The model returns a private `<audit>` listing the preset requirements and whether the draft met them, then a
   `<revised>` message with those requirements satisfied.
4. The reply is replaced in place (swipes, token count and rendering are updated too). A toast confirms it, and
   **Revert last refinement** restores the previous text if you prefer it.

The audit never appears in the chat; it is written to the browser console (`[DraftFlow] Review audit:`) so you can
see what the model thought the preset required. Because the draft is generated first, you briefly see the original
reply and then the revised version — the model is reviewing the message it actually wrote.

## How it works

- Listens for `CHARACTER_MESSAGE_RENDERED` before other extensions, so it runs on fresh replies and swipes.
- Sends the reply back through the same prompt stack: active Chat Completion preset, Prompt Manager entries,
  character card, persona, world info, author's note, and chat history. Disabled prompts are excluded.
- The quiet review instruction asks for `<audit>` first — enumerating mandatory requirements from the preset —
  and then `<revised>` with the complete corrected message. This forces the model to check compliance explicitly
  instead of only polishing prose.
- Parses `<revised>`, replaces `message.mes`, the active swipe, its swipe metadata, and the token count, then
  re-renders and saves the chat.
- Stores the previous text in `chat_metadata.DraftFlow.lastRefinement` so the most recent swap can be reverted.

Everything is obtained through `SillyTavern.getContext()`, so the folder works from `data/<user>/extensions` or
the global `public/scripts/extensions/third-party` directory without path edits.

## Install

1. Copy the `SillyTavern-DraftFlow` folder into `SillyTavern/data/<your-user>/extensions/`
   (usually `SillyTavern/data/default-user/extensions/`), or install it from
   `https://github.com/Ace2k5/SillyTavern-DraftFlow` through the Extensions manager.
2. Reload the SillyTavern page.
3. Open the Extensions panel (plug icon) and enable **DraftFlow**.

Only a page reload is needed, not a server restart.

## Usage

- **Automatic (default):** enabled on install. Every new character reply gets one audit-and-rewrite pass.
- **Manual:** wand menu → **DraftFlow: refine last reply**, the button in the settings drawer, or `/draftflow`.
  Manual runs work even when automatic refinement is off.
- **Undo a swap:** wand menu → **DraftFlow: revert last refinement**, or the button in the settings drawer.

Refinement is skipped when it would be unsafe or pointless: group chats, first messages, continuations, system
messages, stopped generations, an already-refined message, or a chat/message that changed mid-pass.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Refine every new reply automatically | on | Off means only manual runs. |
| Also refine swipes and regenerations | on | Off limits automatic refinement to fresh replies; `/draftflow` still works on a swipe. |
| Max revision tokens | 0 (auto) | Auto sizes the budget from the reply plus roughly 400 tokens of audit headroom. Raise for long replies with many required sections. |
| Review prompt | built in | Editable. `%DRAFT%` is replaced with the reply; `{{char}}` / `{{user}}` are resolved by SillyTavern. Keep the `<audit>` / `<revised>` structure intact. |

## Cost

Two generations per refined reply instead of one, so roughly double latency and tokens. The draft is generated at
normal speed; the extra time is spent while the response is dimmed. Turn the automatic toggle off if you only
want the pass occasionally.

## Limitations

- **Solo character chats only.** Group chats are skipped in this version.
- **The review is self-reported.** The audit is the same model listing what it believes the preset requires; it
  can miss or misreport a rule, and there is no deterministic validator or repair pass. DraftFlow raises the odds
  of compliance, it does not guarantee it.
- **The reply visibly changes.** This is the requested behavior; if you need the final text to appear only once,
  the review has to run before display, which delays the first output by a full generation.
- **Revert is one step.** Only the most recent refinement can be undone, and only while the message still contains
  the revised text.
- **Tag-based parsing.** If the model ignores `<revised>`, any `<audit>` block is stripped and the remaining text is
  used. A model that writes commentary outside the tags can leak it into the reply; harden the review prompt if
  that happens.
- **Edited/deleted messages during a pass** cause that revision to be discarded rather than overwriting your edit.
- **Streaming does not hide the draft.** Streaming finishes, the message is rendered, then the revision replaces it.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| Replies never change | Enable the extension and the "Refine every new reply" toggle; check the browser console for `[DraftFlow]` errors. |
| Required sections still missing | Look at the `[DraftFlow] Review audit:` log. If the audit did not list them, make the requirement more explicit in the review prompt or in the preset entry. |
| "Refinement cancelled" | You pressed stop, or the generation was aborted. The original reply stays. |
| Only the first part of the reply is revised | Raise **Max revision tokens** or set it to 0 for auto. |
| Revert button missing | The last refinement belongs to another chat, or the message text no longer matches the stored revision. |
| `/draftflow` is unknown | Extension is disabled or the page was not reloaded after installing. |

## Version history

- **0.3.0** — the review now audits the active preset's requirements in an `<audit>` block before rewriting,
  instead of only polishing the reply. Upgrading from 0.2 replaces the built-in review prompt; a customized prompt
  is kept, with a console warning explaining that it needs an `<audit>` step.
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
