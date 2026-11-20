/**
 * DraftFlow 0.3 — automatic self-review of the latest reply.
 *
 * After SillyTavern renders a character message, DraftFlow runs one extra quiet
 * generation. The model first audits that message against the active preset's
 * requirements, then rewrites it so those requirements are satisfied. The
 * message is replaced in place, so the chat keeps a single reply.
 *
 * No imports from SillyTavern's module tree: everything comes from
 * SillyTavern.getContext(), so the folder works from data/<user>/extensions or
 * the global third-party folder without path edits.
 */

const MODULE_KEY = 'DraftFlow';
const EXTENSION_ID = 'third-party/SillyTavern-DraftFlow';

const REVIEW_PROMPT_DEFAULT = [
    'The last message in the chat is the finished reply {{char}} just wrote. Do not continue the scene and do not write a new turn.',
    '',
    'Your job is to make that reply comply with the active preset as closely as possible. The preset, character card, and chat history above define the rules: output format, required sections, tags, language rules, analysis or translation blocks, POV, tense, length, and anything else the preset insists on. Follow them even if the draft did not.',
    '',
    '<message>',
    '%DRAFT%',
    '</message>',
    '',
    'Step 1 — audit. In <audit>, briefly list every mandatory requirement you can find in the active preset and character card. For each one, say whether the draft satisfies it and what you will fix. Keep it to one line per requirement.',
    '',
    'Step 2 — rewrite. In <revised>, output the complete final reply with every requirement satisfied. If the draft missed a required section or rule, add or repair it. Do not drop required content to make the reply shorter or cleaner, and do not restate the audit.',
    '',
    'Output exactly these two blocks and nothing else. The revised text must be the entire message, not a summary or a continuation.',
].join('\n');

const REVIEW_PROMPT_V02 = [
    'The last message in the chat is the finished reply {{char}} just wrote. Do not continue the scene and do not write a new message.',
    '',
    '<message>',
    '%DRAFT%',
    '</message>',
    '',
    'Critique it privately:',
    '- continuity with the preceding chat and established facts',
    "- {{char}}'s voice, mannerisms, knowledge, and boundaries",
    "- no control over {{user}}'s words, thoughts, or actions",
    '- concrete detail, clear cause and effect, no filler or repeated beats',
    '- the same tense, POV, and approximate length; keep every fact that matters',
    '',
    'Then output ONLY the rewritten message between <revised> and </revised>.',
    'Do not include the critique, a preamble, labels, or commentary. If it is already good, change as little as possible.',
].join('\n');

const PROMPT_VERSION = 3;

const DEFAULT_SETTINGS = {
    enabled: true,
    refineSwipes: true,
    maxTokens: 0,
    reviewPrompt: REVIEW_PROMPT_DEFAULT,
    promptVersion: PROMPT_VERSION,
    showDetails: false,
};

let isRefining = false;
let stopRequested = false;
let lastDetails = null;

/** @returns {any} Live SillyTavern context. */
function ctx() {
    return SillyTavern.getContext();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

/** FNV-1a, enough to notice that a message changed since the last refinement. */
function hashString(value) {
    const text = String(value ?? '');
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
}

function getSettings() {
    const context = ctx();
    context.extensionSettings[MODULE_KEY] ??= {};
    const settings = context.extensionSettings[MODULE_KEY];
    const storedPromptVersion = settings.promptVersion;

    for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
        if (settings[key] === undefined) {
            settings[key] = value;
        }
    }

    if (storedPromptVersion !== PROMPT_VERSION) {
        if (!settings.reviewPrompt || settings.reviewPrompt === REVIEW_PROMPT_V02) {
            settings.reviewPrompt = REVIEW_PROMPT_DEFAULT;
        } else if (!String(settings.reviewPrompt).includes('<audit>')) {
            console.warn('[DraftFlow] Custom review prompt kept. Add an <audit> step to it to use the compliance pass.');
        }
        settings.promptVersion = PROMPT_VERSION;
        saveSettings();
    }

    return settings;
}

function saveSettings() {
    ctx().saveSettingsDebounced();
}

function messageElement(messageId) {
    return $(`.mes[mesid="${messageId}"]`);
}

function setRefiningIndicator(messageId, active) {
    messageElement(messageId).toggleClass('draftflow-refining', !!active);
}

function lockSend(locked) {
    const context = ctx();
    if (locked) {
        context.deactivateSendButtons?.();
    } else {
        context.activateSendButtons?.();
    }
}

function installSendGuard() {
    const isEnter = (event) => event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.isComposing;

    document.addEventListener('keydown', (event) => {
        if (!isRefining || !isEnter(event)) {
            return;
        }
        if (event.target instanceof HTMLTextAreaElement && event.target.id === 'send_textarea') {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);

    document.addEventListener('click', (event) => {
        if (!isRefining) {
            return;
        }
        if (event.target instanceof Element && event.target.closest('#send_but')) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    }, true);
}

/**
 * Sends the model's audit to the console for debugging. The audit is never
 * shown in the chat; it only exists to make the model enumerate the preset's
 * requirements before rewriting.
 * @param {string} raw Model output
 * @returns {string} Audit text, or an empty string
 */
function extractAudit(raw) {
    const audit = String(raw ?? '').match(/<audit>([\s\S]*?)<\/audit>/i);
    return audit ? audit[1].trim() : '';
}

function logAudit(audit) {
    if (audit) {
        console.debug('[DraftFlow] Review audit:\n' + audit);
    } else {
        console.debug('[DraftFlow] The review did not return an <audit> block.');
    }
}

/**
 * Splits inline reasoning from the model output when the backend includes it in
 * the response text. Reasoning returned in a separate API field is not part of
 * the quiet generation result, so there is nothing to show for those backends.
 * @param {string} raw Model output
 * @returns {{reasoning: string, content: string}}
 */
function splitReasoning(raw) {
    const text = String(raw ?? '');
    const context = ctx();
    if (typeof context.parseReasoningFromString === 'function') {
        try {
            const parsed = context.parseReasoningFromString(text, { strict: false });
            if (parsed?.reasoning) {
                return { reasoning: parsed.reasoning, content: parsed.content ?? '' };
            }
        } catch (error) {
            console.debug('[DraftFlow] Could not parse reasoning', error);
        }
    }
    return { reasoning: '', content: text };
}

function escapeHtml(value) {
    return String(value ?? '')
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&#039;');
}

/**
 * Pulls the rewritten message out of the model output.
 * @param {string} raw Model output
 * @returns {string} Clean revised text
 */
function extractRevision(raw) {
    let text = String(raw ?? '').replace(/\r\n/g, '\n').trim();
    const tagged = text.match(/<revised>([\s\S]*?)<\/revised>/i);
    if (tagged) {
        text = tagged[1];
    } else {
        // If the wrapper is missing, drop a preceding audit and use the rest.
        text = text.replace(/<audit>[\s\S]*?<\/audit>/i, '').trim();
    }

    text = text
        .replace(/^\s*(?:here (?:is|are)[^\n:]*|revised(?: message)?|rewritten(?: message)?|final(?: message)?)\s*:\s*\n?/i, '')
        .replace(/^\s*```[a-z0-9_-]*\s*\n?/i, '')
        .replace(/\n?\s*```\s*$/i, '')
        .replace(/^\s*<revised>\s*/i, '')
        .replace(/\s*<\/revised>\s*$/i, '');

    return text.trim();
}

async function estimateResponseLength(original) {
    const configured = Number(getSettings().maxTokens) || 0;
    if (configured > 0) {
        return configured;
    }

    try {
        const context = ctx();
        const tokens = await context.getTokenCountAsync(original, 0);
        const contextSize = Number(context.maxContext) || 8192;
        if (Number.isFinite(tokens) && tokens > 0) {
            // Room for the rewritten message plus the private audit that precedes it.
            return Math.min(Math.max(384, Math.ceil(tokens * 1.3) + 400), Math.floor(contextSize * 0.5));
        }
    } catch {
        // Fall through to the backend's default reply length.
    }

    return null;
}

function getRefinementRecord() {
    const context = ctx();
    const record = context.chatMetadata?.[MODULE_KEY]?.lastRefinement;
    if (!record || record.chatId !== context.getCurrentChatId()) {
        return null;
    }

    const message = context.chat?.[record.messageId];
    if (!message || message.mes !== record.revised) {
        return null;
    }

    return { record, message };
}

function updateActionButtons() {
    const hasRevert = !!getRefinementRecord();
    const hasDetails = !!lastDetails;
    $('#draftflow_revert').toggle(hasRevert);
    $('#draftflow_revert_wand').toggle(hasRevert);
    $('#draftflow_details').toggle(hasDetails);
    $('#draftflow_details_wand').toggle(hasDetails);
    $('#draftflow_refine').prop('disabled', isRefining);
    $('#draftflow_wand_button').toggleClass('disabled', isRefining);
}

/**
 * Runs one review generation and replaces the message with the revision.
 * @param {number} messageId Message index in the chat
 * @param {{manual?: boolean}} [options] Options
 * @returns {Promise<boolean>} True if the message was replaced
 */
async function refineReply(messageId, { manual = false } = {}) {
    const context = ctx();
    const settings = getSettings();

    if (isRefining) {
        if (manual) {
            toastr.info('DraftFlow is already refining a reply.', 'DraftFlow');
        }
        return false;
    }

    if (!settings.enabled && !manual) {
        return false;
    }

    if (context.groupId || context.characterId === undefined) {
        if (manual) {
            toastr.warning('DraftFlow supports solo character chats only.', 'DraftFlow');
        }
        return false;
    }

    if (!Array.isArray(context.chat)) {
        return false;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system || message.extra?.isSmallSys) {
        if (manual) {
            toastr.info('The last message is not a character reply.', 'DraftFlow');
        }
        return false;
    }

    if (typeof message.mes !== 'string' || !message.mes.trim() || messageId !== context.chat.length - 1) {
        return false;
    }

    const original = message.mes;
    const swipeId = Number.isInteger(message.swipe_id) ? message.swipe_id : 0;
    const originalHash = hashString(original);
    if (!manual && message.extra?.draftflowHash === originalHash) {
        return false;
    }

    const chatId = context.getCurrentChatId();
    if (manual) {
        stopRequested = false;
    }
    isRefining = true;
    setRefiningIndicator(messageId, true);
    updateActionButtons();

    const progressToast = toastr.info('Refining the latest reply…', 'DraftFlow', {
        timeOut: 0,
        extendedTimeOut: 0,
        preventDuplicates: true,
    });
    lockSend(true);

    try {
        const prompt = String(settings.reviewPrompt ?? REVIEW_PROMPT_DEFAULT).split('%DRAFT%').join(original);
        const responseLength = await estimateResponseLength(original);

        const raw = await context.generateQuietPrompt({
            quietPrompt: prompt,
            responseLength,
            removeReasoning: false,
            trimToSentence: true,
        });

        if (stopRequested) {
            toastr.info('Refinement cancelled.', 'DraftFlow');
            return false;
        }

        const { reasoning, content } = splitReasoning(raw);
        if (reasoning) {
            console.debug('[DraftFlow] Review reasoning:\n' + reasoning);
        }

        const audit = extractAudit(content);
        logAudit(audit);
        const revised = extractRevision(content);

        lastDetails = {
            chatId,
            messageId,
            at: Date.now(),
            prompt,
            audit,
            reasoning,
            raw: content,
            original,
            revised,
            applied: false,
        };

        if (!revised) {
            throw new Error('The review pass returned nothing usable.');
        }

        if (revised === original) {
            message.extra ??= {};
            message.extra.draftflowHash = originalHash;
            toastr.info('DraftFlow reviewed the reply; no changes were needed.', 'DraftFlow', { timeOut: 2500 });
            return false;
        }

        if (context.getCurrentChatId() !== chatId) {
            throw new Error('The chat changed before the revision could be applied.');
        }

        const live = context.chat[messageId];
        if (!live || live !== message || live.mes !== original) {
            toastr.info('The reply changed while refining; the revision was discarded.', 'DraftFlow');
            return false;
        }

        let tokenCount = null;
        if (context.powerUserSettings?.message_token_count_enabled) {
            try {
                tokenCount = await context.getTokenCountAsync(revised, 0);
            } catch {
                tokenCount = null;
            }
        }

        context.chatMetadata ??= {};
        context.chatMetadata[MODULE_KEY] = {
            ...(context.chatMetadata[MODULE_KEY] ?? {}),
            lastRefinement: { chatId, messageId, swipeId, original, revised, at: Date.now() },
        };

        live.mes = revised;
        if (Array.isArray(live.swipes) && Number.isInteger(live.swipe_id)) {
            live.swipes[live.swipe_id] = revised;
        }
        if (Array.isArray(live.swipe_info) && live.swipe_info[swipeId] && typeof live.swipe_info[swipeId] === 'object') {
            live.swipe_info[swipeId].extra ??= {};
            if (tokenCount !== null) {
                live.swipe_info[swipeId].extra.token_count = tokenCount;
            }
        }

        live.extra ??= {};
        delete live.extra.display_text;
        delete live.extra.reasoning_display_text;
        live.extra.draftflowHash = hashString(revised);
        live.extra.draftflowRefinedAt = Date.now();
        if (tokenCount !== null) {
            live.extra.token_count = tokenCount;
        }

        context.updateMessageBlock?.(messageId, live);
        await context.saveChat();
        lastDetails.applied = true;
        updateActionButtons();
        toastr.success('Reply refined.', 'DraftFlow', { timeOut: 2000, preventDuplicates: true });
        if (settings.showDetails) {
            showRefinementDetails();
        }
        return true;
    } catch (error) {
        if (stopRequested || error?.name === 'AbortError' || /abort/i.test(String(error?.message))) {
            toastr.info('Refinement cancelled.', 'DraftFlow');
        } else {
            console.error('[DraftFlow] Refinement failed', error);
            toastr.error(String(error?.message ?? error), 'DraftFlow', { timeOut: 6000 });
        }
        return false;
    } finally {
        isRefining = false;
        setRefiningIndicator(messageId, false);
        if (progressToast) {
            toastr.clear(progressToast);
        }
        lockSend(false);
        updateActionButtons();
    }
}

async function refineLastReply() {
    const context = ctx();
    if (isRefining) {
        toastr.info('DraftFlow is already refining a reply.', 'DraftFlow');
        return;
    }

    const messageId = context.chat?.length ? context.chat.length - 1 : -1;
    if (messageId < 0) {
        toastr.warning('Open a chat first.', 'DraftFlow');
        return;
    }

    await refineReply(messageId, { manual: true });
}

async function revertLastRefinement() {
    const context = ctx();
    const found = getRefinementRecord();

    if (!found) {
        toastr.info('There is no DraftFlow refinement to revert in this chat.', 'DraftFlow');
        return;
    }

    const { record, message } = found;

    let tokenCount = null;
    if (context.powerUserSettings?.message_token_count_enabled) {
        try {
            tokenCount = await context.getTokenCountAsync(record.original, 0);
        } catch {
            tokenCount = null;
        }
    }

    message.mes = record.original;
    if (Array.isArray(message.swipes) && Number.isInteger(record.swipeId)) {
        message.swipes[record.swipeId] = record.original;
    }
    if (Array.isArray(message.swipe_info) && message.swipe_info[record.swipeId]) {
        message.swipe_info[record.swipeId].extra ??= {};
        if (tokenCount !== null) {
            message.swipe_info[record.swipeId].extra.token_count = tokenCount;
        }
    }

    if (message.extra) {
        delete message.extra.display_text;
        delete message.extra.reasoning_display_text;
        delete message.extra.draftflowHash;
        delete message.extra.draftflowRefinedAt;
        if (tokenCount !== null) {
            message.extra.token_count = tokenCount;
        }
    }

    delete context.chatMetadata[MODULE_KEY].lastRefinement;
    context.updateMessageBlock?.(record.messageId, message);
    await context.saveChat();
    updateActionButtons();
    toastr.success('Reverted to the original reply.', 'DraftFlow');
}

function showRefinementDetails() {
    if (!lastDetails) {
        toastr.info('No refinement details are available in this session.', 'DraftFlow');
        return;
    }

    const context = ctx();
    const details = lastDetails;
    const section = (title, body, open = false) => {
        if (!body) {
            return '';
        }
        return `<details class="draftflow-details-section"${open ? ' open' : ''}><summary>${escapeHtml(title)}</summary><pre>${escapeHtml(body)}</pre></details>`;
    };

    const meta = `Message ${details.messageId} · ${new Date(details.at).toLocaleString()} · ${details.applied ? 'applied' : 'not applied'}`;
    const html = `<div class="draftflow-details">
        <div class="draftflow-details-meta">${escapeHtml(meta)}</div>
        ${section('Audit', details.audit, true)}
        ${section('Reasoning', details.reasoning)}
        ${section('Original reply', details.original)}
        ${section('Final reply', details.revised, true)}
        ${section('Raw model output', details.raw)}
        ${section('Review prompt', details.prompt)}
    </div>`;

    if (typeof context.callGenericPopup === 'function') {
        context.callGenericPopup(html, context.POPUP_TYPE.TEXT, '', {
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });
    } else {
        console.debug('[DraftFlow] Refinement details', details);
        toastr.info('Details were written to the browser console.', 'DraftFlow');
    }
}

function onGenerationStarted(type) {
    if (type !== 'quiet') {
        stopRequested = false;
    }
}

function onGenerationStopped() {
    stopRequested = true;
}

async function onCharacterMessageRendered(rawMessageId, type) {
    if (isRefining || stopRequested) {
        return;
    }

    const settings = getSettings();
    if (!settings.enabled) {
        return;
    }

    if (type !== 'normal' && type !== 'swipe') {
        return;
    }

    if (type === 'swipe' && !settings.refineSwipes) {
        return;
    }

    const context = ctx();
    if (context.groupId || context.characterId === undefined) {
        return;
    }

    const messageId = Number(rawMessageId);
    if (!Array.isArray(context.chat) || !Number.isInteger(messageId) || messageId !== context.chat.length - 1) {
        return;
    }

    const message = context.chat[messageId];
    if (!message || message.is_user || message.is_system || !message.mes?.trim()) {
        return;
    }

    if (message.extra?.draftflowHash === hashString(message.mes)) {
        return;
    }

    await refineReply(messageId);
}

function bindSettingsPanel() {
    const settings = getSettings();

    $('#draftflow_enabled')
        .prop('checked', !!settings.enabled)
        .on('change', function () {
            settings.enabled = !!$(this).prop('checked');
            saveSettings();
            updateActionButtons();
        });

    $('#draftflow_swipes')
        .prop('checked', !!settings.refineSwipes)
        .on('change', function () {
            settings.refineSwipes = !!$(this).prop('checked');
            saveSettings();
        });

    $('#draftflow_show_details')
        .prop('checked', !!settings.showDetails)
        .on('change', function () {
            settings.showDetails = !!$(this).prop('checked');
            saveSettings();
        });

    $('#draftflow_tokens')
        .val(settings.maxTokens)
        .on('input change', function () {
            const value = clamp(parseInt(String($(this).val()), 10) || 0, 0, 8000);
            settings.maxTokens = value;
            $(this).val(value);
            saveSettings();
        });

    $('#draftflow_prompt')
        .val(settings.reviewPrompt)
        .on('input', function () {
            settings.reviewPrompt = String($(this).val());
            saveSettings();
        });

    $('#draftflow_reset_prompt').on('click', () => {
        settings.reviewPrompt = REVIEW_PROMPT_DEFAULT;
        $('#draftflow_prompt').val(REVIEW_PROMPT_DEFAULT);
        saveSettings();
        toastr.info('Review prompt restored to its default.', 'DraftFlow');
    });

    $('#draftflow_refine').on('click', () => refineLastReply());
    $('#draftflow_revert').on('click', () => revertLastRefinement());
    $('#draftflow_details').on('click', () => showRefinementDetails());
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
    updateActionButtons();
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

    const $refine = $(`
        <div id="draftflow_wand_button" class="list-group-item flex-container flexGap5" title="Run the DraftFlow self-review pass on the latest reply">
            <div class="fa-solid fa-feather-pointed extensionsMenuExtensionButton"></div>
            <span class="draftflow_wand_label">DraftFlow: refine last reply</span>
        </div>
    `);

    const $revert = $(`
        <div id="draftflow_revert_wand" class="list-group-item flex-container flexGap5" title="Restore the reply from before the last DraftFlow refinement" style="display: none;">
            <div class="fa-solid fa-rotate-left extensionsMenuExtensionButton"></div>
            <span>DraftFlow: revert last refinement</span>
        </div>
    `);

    const $details = $(`
        <div id="draftflow_details_wand" class="list-group-item flex-container flexGap5" title="Show the audit, reasoning, and raw output from the last refinement" style="display: none;">
            <div class="fa-solid fa-magnifying-glass-chart extensionsMenuExtensionButton"></div>
            <span>DraftFlow: show last refinement details</span>
        </div>
    `);

    $menu.append($details).append($revert).append($refine);

    $refine.on('click', () => refineLastReply());
    $revert.on('click', () => revertLastRefinement());
    $details.on('click', () => showRefinementDetails());

    updateActionButtons();
}

function registerSlashCommand() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand } = context;

    if (!SlashCommandParser || !SlashCommand) {
        console.warn('[DraftFlow] Slash command API is unavailable; skipping /draftflow registration.');
        return;
    }

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'draftflow',
        returns: 'status',
        helpString: 'Run the DraftFlow self-review pass on the latest character reply, even when automatic refinement is off.',
        callback: async () => {
            await refineLastReply();
            return 'DraftFlow: refinement requested';
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
        installSendGuard();
        const context = ctx();
        context.eventSource.makeFirst(context.eventTypes.CHARACTER_MESSAGE_RENDERED, onCharacterMessageRendered);
        context.eventSource.on(context.eventTypes.GENERATION_STARTED, onGenerationStarted);
        context.eventSource.on(context.eventTypes.GENERATION_STOPPED, onGenerationStopped);
        context.eventSource.on(context.eventTypes.CHAT_CHANGED, () => updateActionButtons());
        context.eventSource.on(context.eventTypes.MESSAGE_DELETED, () => updateActionButtons());
    } catch (error) {
        console.error('[DraftFlow] Could not subscribe to chat events', error);
    }
});
