/**
 * DraftFlow — draft → self-review → multi-turn insert for SillyTavern.
 *
 * The extension deliberately imports nothing from SillyTavern's module tree:
 * everything it needs comes from SillyTavern.getContext(), so the folder can live
 * in data/<user>/extensions or in the global third-party folder without path edits.
 */

const MODULE_KEY = 'DraftFlow';
const EXTENSION_ID = 'third-party/SillyTavern-DraftFlow';

const DRAFT_PROMPT_DEFAULT = [
    'You are drafting, not writing the final reply. Continue the current scene with the next %TURNS% message(s) from {{char}}.',
    '',
    'Write a rough first pass. Prioritize:',
    '- what {{char}} wants right now, and what is in the way',
    '- concrete actions, dialogue, and sensory detail',
    '- a cause-and-effect chain from one message to the next',
    '- an opening beat that reacts to the last message in the chat',
    '',
    'Rules:',
    "- Write only {{char}}'s messages. Never write {{user}}'s words, thoughts, or actions.",
    '- Do not summarize, explain, or comment on the task.',
    '- Separate each message with a line containing exactly @@TURN@@.',
    '- If %TURNS% is 1, output exactly one message and no separator.',
].join('\n');

const REVIEW_PROMPT_DEFAULT = [
    'Below is your own rough draft of the next %TURNS% message(s) from {{char}}.',
    '',
    '<draft>',
    '%DRAFT%',
    '</draft>',
    '',
    'Review the draft privately against these criteria:',
    '- continuity with the preceding chat, established facts, and the current scene state',
    "- {{char}}'s voice, mannerisms, knowledge, and boundaries, with no out-of-character knowledge",
    "- no control over {{user}}'s words, thoughts, or actions",
    '- each message reacts to the previous one; no repeated beats or restated openings',
    '- specific, concrete detail; remove filler, purple prose, and meta-commentary',
    '- the final message leaves the scene open for {{user}}',
    '',
    'Fix every problem silently. Then output ONLY the improved final messages, separated by a line containing exactly @@TURN@@.',
    'Do not include the critique, headings, labels, or any explanation.',
].join('\n');

const DEFAULT_SETTINGS = {
    turns: 3,
    refine: true,
    tokensPerTurn: 400,
    draftPrompt: DRAFT_PROMPT_DEFAULT,
    reviewPrompt: REVIEW_PROMPT_DEFAULT,
};

let isRunning = false;

/** @returns {any} Live SillyTavern context. */
function ctx() {
    return SillyTavern.getContext();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function makeBatchId() {
    return `df-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function escapeRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getSettings() {
    const context = ctx();
    context.extensionSettings[MODULE_KEY] ??= {};
    const settings = context.extensionSettings[MODULE_KEY];

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function getResponseBudget(turns) {
    const perTurn = Number(getSettings().tokensPerTurn) || 0;
    const context = ctx();
    const contextSize = Number(context.maxContext) || 8192;
    const cap = Math.max(256, Math.floor(contextSize * 0.5));

    if (perTurn > 0) {
        return Math.min(cap, Math.max(64, perTurn * turns));
    }

    // A single message may use the user's normal reply length; multi-turn batches
    // get proportional headroom so the parser does not see a cut-off sequence.
    return turns > 1 ? Math.min(cap, 400 * turns) : null;
}

function label(text, name) {
    const value = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!name) {
        return value;
    }

    const prefix = new RegExp(`^${escapeRegExp(name)}\\s*[:：]\\s*`, 'i');
    return value.replace(prefix, '').trim();
}

function stripWrappingFence(text) {
    return String(text ?? '')
        .replace(/^\s*```[a-z0-9_-]*\s*\n?/i, '')
        .replace(/\n?\s*```\s*$/i, '')
        .trim();
}

/**
 * Removes a leading "Here are the final messages:" style preamble.
 * @param {string} text Model output
 * @returns {string} Text without the preamble
 */
function stripPreamble(text) {
    return String(text ?? '').replace(
        /^\s*(?:here (?:is|are)[^\n:]*|(?:rough\s+)?draft|final(?: messages)?|improved(?: messages)?|polished(?: messages)?)\s*:\s*\n?/i,
        '',
    );
}

/**
 * Splits a model reply on the turn marker and cleans each part.
 * @param {string} text Model output
 * @param {number} turns Requested number of messages
 * @returns {string[]} Messages, at most `turns`
 */
function parseTurns(text, turns) {
    const cleaned = stripPreamble(stripWrappingFence(text));
    if (!cleaned) {
        return [];
    }

    const parts = cleaned
        .split(/^[ \t*_>-]*@@TURN@@[ \t*_>-]*$/im)
        .map((part) => label(part, ctx().name2))
        .map((part) => stripWrappingFence(part))
        .filter((part) => part.length > 0);

    if (parts.length === 1 && turns > 1) {
        console.debug('[DraftFlow] Model returned a single block for a multi-turn batch.');
    }

    return parts.slice(0, turns);
}

function setUiBusy(busy) {
    const $button = $('#draftflow_wand_button');
    $button.toggleClass('disabled', busy);
    $button.find('.draftflow_wand_label').text(busy ? 'Drafting…' : 'DraftFlow');
    $('#draftflow_generate').prop('disabled', busy);
}

function getBatch() {
    const context = ctx();
    const batch = context.chatMetadata?.[MODULE_KEY]?.lastBatch;
    if (!batch || batch.chatId !== context.getCurrentChatId()) {
        return null;
    }
    return batch;
}

function updateUndoButton() {
    const hasBatch = !!getBatch();
    $('#draftflow_undo').toggle(hasBatch);
    $('#draftflow_undo_wand').toggle(hasBatch);
}

async function generateDraft(turns) {
    const context = ctx();
    const settings = getSettings();
    const prompt = String(settings.draftPrompt ?? DRAFT_PROMPT_DEFAULT).replaceAll('%TURNS%', String(turns));

    toastr.info(`Writing the first draft…`, 'DraftFlow', { timeOut: 2200, preventDuplicates: true });

    const response = await context.generateQuietPrompt({
        quietPrompt: prompt,
        responseLength: getResponseBudget(turns),
        removeReasoning: true,
        trimToSentence: true,
    });

    const draft = String(response ?? '').trim();
    if (!draft) {
        throw new Error('The draft pass returned nothing. Check the connection or that the request was not stopped.');
    }

    console.debug('[DraftFlow] Draft:\n' + draft);
    return draft;
}

async function reviewDraft(draft, turns) {
    const context = ctx();
    const settings = getSettings();
    const prompt = String(settings.reviewPrompt ?? REVIEW_PROMPT_DEFAULT)
        .replaceAll('%TURNS%', String(turns))
        .split('%DRAFT%').join(draft);

    toastr.info(`Reviewing its own draft…`, 'DraftFlow', { timeOut: 2200, preventDuplicates: true });

    const response = await context.generateQuietPrompt({
        quietPrompt: prompt,
        responseLength: getResponseBudget(turns),
        removeReasoning: true,
        trimToSentence: true,
    });

    const finalText = String(response ?? '').trim();
    if (!finalText) {
        throw new Error('The review pass returned nothing.');
    }

    console.debug('[DraftFlow] Final:\n' + finalText);
    return finalText;
}

async function insertTurns(parts, chatId) {
    const context = ctx();
    const batchId = makeBatchId();
    const startIndex = context.chat.length;

    try {
        for (const part of parts) {
            await context.saveReply({ type: 'normal', getMessage: part });
            const message = context.chat[context.chat.length - 1];
            if (message && typeof message === 'object') {
                message.extra ??= {};
                message.extra.draftflow = true;
                message.extra.draftflowBatch = batchId;
            }
        }
    } catch (error) {
        while (context.chat.length > startIndex) {
            context.chat.pop();
        }
        await context.saveChat();
        await context.reloadCurrentChat();
        throw error;
    }

    context.chatMetadata ??= {};
    context.chatMetadata[MODULE_KEY] = {
        ...(context.chatMetadata?.[MODULE_KEY] ?? {}),
        lastBatch: {
            chatId,
            batchId,
            count: parts.length,
            createdAt: Date.now(),
        },
    };

    await context.saveChat();
    context.scrollChatToBottom?.();
}

async function undoLastBatch() {
    const context = ctx();
    const batch = getBatch();

    if (!batch) {
        toastr.info(`There is no DraftFlow batch to undo in this chat.`, 'DraftFlow');
        return;
    }

    const tagged = [];
    context.chat.forEach((message, index) => {
        if (message?.extra?.draftflowBatch === batch.batchId) {
            tagged.push(index);
        }
    });

    const first = tagged[0];
    const isTail = tagged.length === batch.count && first === context.chat.length - tagged.length;

    if (!isTail) {
        toastr.warning(
            `The chat changed since this batch. Delete its messages manually instead of using Undo.`,
            'DraftFlow',
        );
        return;
    }

    for (let index = context.chat.length - 1; index >= first; index--) {
        context.chat.splice(index, 1);
    }

    delete context.chatMetadata[MODULE_KEY].lastBatch;
    await context.saveChat();
    await context.reloadCurrentChat();
    updateUndoButton();
    toastr.success(`Removed ${tagged.length} message(s).`, 'DraftFlow');
}

async function runDraftFlow({ turns, refine } = {}) {
    const context = ctx();

    if (isRunning) {
        toastr.info(`DraftFlow is already running.`, 'DraftFlow');
        return false;
    }

    if (context.groupId) {
        toastr.warning(`DraftFlow does not support group chats yet.`, 'DraftFlow');
        return false;
    }

    if (context.characterId === undefined || !context.characters?.[context.characterId]) {
        toastr.warning(`Open a character chat first.`, 'DraftFlow');
        return false;
    }

    if (!Array.isArray(context.chat) || context.chat.length === 0) {
        toastr.warning(`Start a chat before running DraftFlow.`, 'DraftFlow');
        return false;
    }

    if ($('#mes_stop').is(':visible') || context.streamingProcessor) {
        toastr.warning(`Wait for the current generation to finish.`, 'DraftFlow');
        return false;
    }

    const pendingText = String($('#send_textarea').val() ?? '').trim();
    if (pendingText) {
        toastr.warning(`Send your typed message first — DraftFlow continues from the current chat.`, 'DraftFlow');
        return false;
    }

    const settings = getSettings();
    const requestedTurns = Number(turns ?? settings.turns);
    const batchTurns = clamp(Number.isFinite(requestedTurns) ? Math.floor(requestedTurns) : 1, 1, 10);
    const withReview = refine === undefined ? Boolean(settings.refine) : Boolean(refine);
    const chatId = context.getCurrentChatId();

    isRunning = true;
    setUiBusy(true);

    try {
        const draft = await generateDraft(batchTurns);
        let finalText = draft;

        if (withReview) {
            try {
                finalText = await reviewDraft(draft, batchTurns);
            } catch (error) {
                console.error('[DraftFlow] Review pass failed', error);
                const insertDraftAnyway = await context.Popup.show.confirm(
                    'DraftFlow',
                    `The review pass failed. Insert the unrefined draft instead?`,
                );
                if (!insertDraftAnyway) {
                    const cancelled = new Error('Cancelled after the review pass failed.');
                    cancelled.isCancel = true;
                    throw cancelled;
                }
                finalText = draft;
            }
        }

        const parts = parseTurns(finalText, batchTurns);
        if (!parts.length) {
            throw new Error('Could not parse any messages from the model output.');
        }

        if (context.getCurrentChatId() !== chatId) {
            throw new Error('The chat changed while DraftFlow was running.');
        }

        await insertTurns(parts, chatId);

        const count = parts.length;
        toastr.success(
            count === 1
                ? `Inserted 1 message. Use Undo to remove it.`
                : `Inserted ${count} messages. Use Undo to remove them.`,
            'DraftFlow',
            { timeOut: 5000 },
        );
        return true;
    } catch (error) {
        if (error?.isCancel) {
            console.debug('[DraftFlow]', error);
            toastr.info(String(error.message), 'DraftFlow');
            return false;
        }

        console.error('[DraftFlow]', error);
        toastr.error(String(error?.message ?? error), 'DraftFlow', { timeOut: 8000 });
        return false;
    } finally {
        isRunning = false;
        setUiBusy(false);
        updateUndoButton();
    }
}

function bindSettingsPanel() {
    const settings = getSettings();

    $('#draftflow_turns')
        .val(settings.turns)
        .on('input change', function () {
            const value = clamp(parseInt(String($(this).val()), 10) || 1, 1, 10);
            settings.turns = value;
            $(this).val(value);
            saveSettings();
        });

    $('#draftflow_refine')
        .prop('checked', !!settings.refine)
        .on('change', function () {
            settings.refine = !!$(this).prop('checked');
            saveSettings();
        });

    $('#draftflow_tokens')
        .val(settings.tokensPerTurn)
        .on('input change', function () {
            const value = clamp(parseInt(String($(this).val()), 10) || 0, 0, 8000);
            settings.tokensPerTurn = value;
            $(this).val(value);
            saveSettings();
        });

    $('#draftflow_draft_prompt')
        .val(settings.draftPrompt)
        .on('input', function () {
            settings.draftPrompt = String($(this).val());
            saveSettings();
        });

    $('#draftflow_review_prompt')
        .val(settings.reviewPrompt)
        .on('input', function () {
            settings.reviewPrompt = String($(this).val());
            saveSettings();
        });

    $('#draftflow_reset_prompts').on('click', () => {
        settings.draftPrompt = DRAFT_PROMPT_DEFAULT;
        settings.reviewPrompt = REVIEW_PROMPT_DEFAULT;
        $('#draftflow_draft_prompt').val(DRAFT_PROMPT_DEFAULT);
        $('#draftflow_review_prompt').val(REVIEW_PROMPT_DEFAULT);
        saveSettings();
        toastr.info(`Prompt templates restored to defaults.`, 'DraftFlow');
    });

    $('#draftflow_generate').on('click', () => runDraftFlow());
    $('#draftflow_undo').on('click', () => undoLastBatch());
}

async function addSettingsPanel() {
    if ($('.draftflow-settings').length > 0) {
        return;
    }

    const context = ctx();
    const html = await context.renderExtensionTemplateAsync(EXTENSION_ID, 'settings');
    const $container = $('#extensions_settings2').length ? $('#extensions_settings2') : $('#extensions_settings');
    $container.append(html);
    bindSettingsPanel();
    updateUndoButton();
}

function addWandButtons(attempt = 0) {
    const $menu = $('#extensionsMenu');
    if (!$menu.length) {
        if (attempt < 20) {
            setTimeout(() => addWandButtons(attempt + 1), 250);
        }
        return;
    }

    if ($('#draftflow_wand_button').length > 0) {
        return;
    }

    const $button = $(`
        <div id="draftflow_wand_button" class="list-group-item flex-container flexGap5" title="Draft, self-review, then insert consecutive messages">
            <div class="fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div>
            <span class="draftflow_wand_label">DraftFlow</span>
        </div>
    `);

    const $undo = $(`
        <div id="draftflow_undo_wand" class="list-group-item flex-container flexGap5" title="Remove the messages from the last DraftFlow batch" style="display: none;">
            <div class="fa-solid fa-rotate-left extensionsMenuExtensionButton"></div>
            <span>Undo DraftFlow batch</span>
        </div>
    `);

    $menu.append($undo).append($button);

    $button.on('click', () => runDraftFlow());
    $undo.on('click', () => undoLastBatch());

    updateUndoButton();
}

function registerSlashCommand() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandNamedArgument, ARGUMENT_TYPE } = context;

    if (!SlashCommandParser || !SlashCommand || !SlashCommandNamedArgument || !ARGUMENT_TYPE) {
        console.warn('[DraftFlow] Slash command API is unavailable; skipping /draftflow registration.');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'draftflow',
        returns: 'status',
        helpString: 'Draft the next few character messages, self-review them, then insert them into the chat. Named args: turns=1-10, refine=true|false.',
        namedArgumentList: [
            SlashCommandNamedArgument.fromProps({
                name: 'turns',
                description: 'Number of consecutive character messages to generate (1-10).',
                typeList: [ARGUMENT_TYPE.NUMBER],
                isRequired: false,
            }),
            SlashCommandNamedArgument.fromProps({
                name: 'refine',
                description: 'Run the self-review pass before inserting.',
                typeList: [ARGUMENT_TYPE.BOOLEAN],
                isRequired: false,
            }),
        ],
        callback: async (args) => {
            const turns = args?.turns === undefined ? undefined : Number(args.turns);
            const refine = args?.refine === undefined ? undefined : String(args.refine) !== 'false';
            const inserted = await runDraftFlow({ turns, refine });
            return inserted ? 'DraftFlow: inserted' : 'DraftFlow: nothing inserted';
        },
    }));
}

jQuery(async () => {
    try {
        getSettings();
    } catch (error) {
        console.error('[DraftFlow] Could not initialize settings', error);
    }

    try {
        await addSettingsPanel();
    } catch (error) {
        console.error('[DraftFlow] Could not add the settings panel', error);
    }

    try {
        addWandButtons();
    } catch (error) {
        console.error('[DraftFlow] Could not add the wand menu entries', error);
    }

    try {
        registerSlashCommand();
    } catch (error) {
        console.error('[DraftFlow] Could not register /draftflow', error);
    }

    try {
        const context = ctx();
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => updateUndoButton());
    } catch (error) {
        console.error('[DraftFlow] Could not subscribe to chat changes', error);
    }
});
