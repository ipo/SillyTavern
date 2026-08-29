/* global globalThis */
import http from 'node:http';
import { test, expect } from '@playwright/test';

class ControlledSseServer {
    constructor() {
        this.requestCount = 0;
        this.abortedCount = 0;
        this.response = null;
        this.server = http.createServer((request, response) => {
            this.requestCount++;
            request.resume();
            response.writeHead(200, {
                'content-type': 'text/event-stream',
                'cache-control': 'no-cache',
                'access-control-allow-origin': '*',
            });
            response.flushHeaders();
            this.response = response;
            response.on('close', () => {
                if (!response.writableEnded) this.abortedCount++;
            });
        });
    }

    async start() {
        await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    }

    get url() {
        const address = this.server.address();
        return `http://127.0.0.1:${address.port}/v1/chat/completions`;
    }

    async waitForRequest(requestCount = 1, timeout = 5000) {
        await expect.poll(() => this.requestCount, { timeout }).toBeGreaterThanOrEqual(requestCount);
    }

    send(choice) {
        this.response.write(`data: ${JSON.stringify({ choices: [choice] })}\n\n`);
    }

    done() {
        this.response.end('data: [DONE]\n\n');
    }

    error() {
        this.response.end('data: {malformed}\n\n');
    }

    async stop() {
        this.response?.destroy();
        await new Promise(resolve => this.server.close(resolve));
    }
}

class ControlledJsonServer {
    constructor() {
        this.requestCount = 0;
        this.responses = [];
        this.server = http.createServer((request, response) => {
            this.requestCount++;
            request.resume();
            this.responses.push(response);
        });
    }

    async start() {
        await new Promise(resolve => this.server.listen(0, '127.0.0.1', resolve));
    }

    get url() {
        const address = this.server.address();
        return `http://127.0.0.1:${address.port}/v1/chat/completions`;
    }

    async waitForRequest(requestCount = 1) {
        await expect.poll(() => this.requestCount).toBeGreaterThanOrEqual(requestCount);
    }

    respond(choices) {
        const response = this.responses.at(-1);
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ choices: choices.map(content => ({ message: { content } })) }));
    }

    async stop() {
        for (const response of this.responses) {
            response.destroy();
        }
        await new Promise(resolve => this.server.close(resolve));
    }
}

async function preparePage(page, server, {
    n = 3,
    generationType = 'swipe',
    seed = true,
    continuous,
    stream = true,
    startViaSendButton = false,
    initialText = 'initial request',
    chatSaveHandler,
} = {}) {
    await page.goto('/');
    const user = page.locator('#userList .userSelect').last();
    if (await user.count()) await user.click();
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    const onboarding = page.locator('dialog .onboarding');
    if (await onboarding.isVisible()) {
        await page.locator('dialog .popup-button-ok').click();
    }
    if (startViaSendButton) {
        await page.waitForFunction(async () => (await import('./script.js')).settingsReady, undefined, { timeout: 0 });
    }
    await page.route('**/api/chats/save', chatSaveHandler ?? (route => route.fulfill({ status: 200, body: '{}' })));
    await page.route('**/api/backends/chat-completions/generate', route => route.continue({ url: server.url }));
    const testCharacter = startViaSendButton ? {
        name: 'Test Assistant',
        avatar: 'none',
        chat: 'continuous-mutex-test',
        description: '',
        personality: '',
        scenario: '',
        first_mes: '',
        mes_example: '',
        data: {
            name: 'Test Assistant',
            description: '',
            personality: '',
            scenario: '',
            first_mes: '',
            mes_example: '',
            alternate_greetings: [],
            extensions: {},
        },
    } : undefined;

    await page.evaluate(async ({ n, generationType, hasSeed, continuous, stream, startViaSendButton, initialText, testCharacter }) => {
        const script = await import('./script.js');
        const { oai_settings, chat_completion_sources } = await import('./scripts/openai.js');
        const { power_user } = await import('./scripts/power-user.js');
        const { event_types } = await import('./scripts/events.js');
        await script.clearChat({ clearData: true });
        const oldInfo = index => ({
            send_date: `old-${index}`,
            gen_started: `old-start-${index}`,
            gen_finished: `old-finish-${index}`,
            extra: { marker: `old-${index}` },
        });
        if (hasSeed) {
            const message = {
                name: 'Test Assistant',
                is_user: false,
                is_system: false,
                send_date: 'old-1',
                mes: 'old-1',
                swipe_id: 2,
                swipes: ['old-0', 'old-1'],
                swipe_info: [oldInfo(0), oldInfo(1)],
                extra: { marker: 'old-1' },
            };
            script.chat.push(message);
            script.addOneMessage(message, { scroll: false });
        }
        globalThis.$('#main_api').val('openai').trigger('change');
        script.setOnlineStatus('Connected');
        Object.assign(oai_settings, {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_model: 'live-multiswipe-test',
            custom_url: 'https://example.invalid/v1',
            stream_openai: stream,
            n,
            show_thoughts: true,
        });
        power_user.streaming_fps = 20;
        power_user.auto_swipe = false;
        if (typeof continuous === 'boolean') {
            power_user.continuous_multi_swipe_generation = continuous;
        }
        if (generationType === 'impersonate') {
            script.eventSource.once(event_types.IMPERSONATE_READY, text => globalThis.__ticket2ImpersonateReady = text);
        }
        if (startViaSendButton) {
            script.characters.splice(0, script.characters.length, testCharacter);
            script.setCharacterId(0);
            script.setCharacterName(testCharacter.name);
            globalThis.$('#send_textarea').val(initialText).trigger('input');
        } else {
            globalThis.__ticket2Generation = script.Generate(generationType);
        }
    }, { n, generationType, hasSeed: seed, continuous, stream, startViaSendButton, initialText, testCharacter });
    if (startViaSendButton) {
        await page.waitForFunction(() => globalThis.$?._data(globalThis.document.querySelector('#send_but'), 'events')?.click?.some(event => event.handler.toString().includes('userInputGenerateMutex')), undefined, { timeout: 0 });
        await page.evaluate(() => globalThis.$('#send_but').trigger('click'));
    }
    await server.waitForRequest(1, startViaSendButton ? 15000 : 5000);
    if (generationType !== 'impersonate') {
        await expect(page.locator('#chat .mes.last_mes')).toBeVisible();
    }
}

const counterText = locator => locator.evaluate(element => element.textContent.replaceAll('\u200b', ''));
const clickArrow = locator => locator.evaluate(element => element.click());
const waitForRequestsToSettle = () => new Promise(resolve => setTimeout(resolve, 150));

test.describe('live streamed multi-swipe navigation', () => {
    /** @type {ControlledSseServer} */
    let server;

    test.beforeEach(async () => {
        server = new ControlledSseServer();
        await server.start();
    });

    test.afterEach(async () => {
        await server.stop();
    });

    test('combines persisted and sparse live choices without changing persisted data', async ({ page }) => {
        await preparePage(page, server);
        const message = page.locator('#chat .mes.last_mes');
        const counter = message.locator('.swipes-counter');

        server.send({ index: 0, delta: { reasoning_content: 'reasoning-0', content: 'primary-a.' } });
        await expect(message.locator('.mes_text')).toContainText('primary-a.');
        await expect(message).toHaveClass(/live-multiswipe/);
        await expect.poll(() => counterText(counter)).toBe('3/3');

        server.send({ index: 2, delta: { reasoning_content: 'reasoning-2', content: 'choice-2a.' } });
        await expect.poll(() => counterText(counter)).toBe('3/4');
        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('choice-2a.');
        await expect.poll(() => counterText(counter)).toBe('4/4');

        server.send({ index: 0, delta: { content: '-primary-b.' } });
        await expect(message.locator('.mes_text')).toContainText('choice-2a.');
        server.send({ index: 1, delta: { reasoning_content: 'reasoning-1', content: 'choice-1.' } });
        await expect.poll(() => counterText(counter)).toBe('5/5');

        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('choice-1.');
        server.send({ index: 2, delta: { content: '-choice-2b.' } });
        await expect(message.locator('.mes_text')).toContainText('choice-1.');
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('primary-a.-primary-b.');
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('old-1');
        await expect.poll(() => counterText(counter)).toBe('2/5');
        const oldSnapshot = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            return structuredClone({ swipeId: chat.at(-1).swipe_id, old: chat.at(-1).swipe_info.slice(0, 2), swipes: chat.at(-1).swipes.slice(0, 2) });
        });
        server.send({ index: 0, delta: { content: '-primary-c.' } });
        server.send({ index: 1, delta: { content: '-choice-1b.' } });
        await expect(message.locator('.mes_text')).toContainText('old-1');
        await expect.poll(async () => page.evaluate(async () => {
            const { chat } = await import('./script.js');
            return JSON.stringify({ swipeId: chat.at(-1).swipe_id, old: chat.at(-1).swipe_info.slice(0, 2), swipes: chat.at(-1).swipes.slice(0, 2) });
        })).toBe(JSON.stringify(oldSnapshot));

        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('old-0');
        await clickArrow(message.locator('.swipe_left'));
        expect(server.requestCount).toBe(1);
        expect(server.abortedCount).toBe(0);
        await clickArrow(message.locator('.swipe_right'));
        await clickArrow(message.locator('.swipe_right'));
        await clickArrow(message.locator('.swipe_right'));
        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('choice-2a.-choice-2b.');

        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);

        const result = await page.evaluate(async () => {
            const script = await import('./script.js');
            const saved = JSON.parse(JSON.stringify(script.chat.at(-1)));
            const reloaded = structuredClone(saved);
            script.syncSwipeToMes(null, saved.swipe_id, reloaded);
            return {
                saved,
                reloaded: { mes: reloaded.mes, reasoning: reloaded.extra.reasoning },
                liveClass: globalThis.document.querySelector('#chat .mes.last_mes').classList.contains('live-multiswipe'),
            };
        });
        expect(result.saved.swipes).toEqual(['old-0', 'old-1', 'primary-a.-primary-b.-primary-c.', 'choice-1.-choice-1b.', 'choice-2a.-choice-2b.']);
        expect(result.saved.swipe_info).toHaveLength(5);
        expect(result.saved.swipe_id).toBe(4);
        expect(result.saved.mes).toBe('choice-2a.-choice-2b.');
        expect(result.saved.extra.reasoning).toBe('reasoning-2');
        expect(result.saved.swipe_info.slice(0, 2).map(info => info.extra.marker)).toEqual(['old-0', 'old-1']);
        expect(result.reloaded).toEqual({ mes: 'choice-2a.-choice-2b.', reasoning: 'reasoning-2' });
        expect(result.liveClass).toBe(false);
    });

    test('maps primary and persisted selections across a second manual batch', async ({ page }) => {
        await preparePage(page, server);
        const message = page.locator('#chat .mes.last_mes');

        server.send({ index: 0, delta: { content: 'first-primary' } });
        server.send({ index: 1, delta: { content: 'first-alternate' } });
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);

        await expect.poll(async () => page.evaluate(async () => {
            const { chat } = await import('./script.js');
            return JSON.stringify({ swipeId: chat.at(-1).swipe_id, mes: chat.at(-1).mes, swipes: chat.at(-1).swipes });
        })).toBe(JSON.stringify({
            swipeId: 2,
            mes: 'first-primary',
            swipes: ['old-0', 'old-1', 'first-primary', 'first-alternate'],
        }));

        await page.evaluate(async () => (await import('./script.js')).showSwipeButtons());
        await clickArrow(message.locator('.swipe_right'));
        await expect.poll(async () => page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipe_id)).toBe(3);
        await expect.poll(() => page.evaluate(() => !globalThis.document.body.dataset.swiping)).toBe(true);
        await page.evaluate(async () => {
            const script = await import('./script.js');
            script.chat.at(-1).swipe_id = script.chat.at(-1).swipes.length;
            globalThis.__ticket2Generation = script.Generate('swipe');
        });
        await server.waitForRequest(2);
        server.send({ index: 0, delta: { content: 'second-primary' } });
        await expect(message).toHaveClass(/live-multiswipe/);
        await expect.poll(() => counterText(message.locator('.swipes-counter'))).toBe('5/5');
        server.send({ index: 3, delta: { content: 'second-alternate' } });
        await expect.poll(() => counterText(message.locator('.swipes-counter'))).toBe('5/6');

        await clickArrow(message.locator('.swipe_left'));
        await clickArrow(message.locator('.swipe_left'));
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('old-1');
        server.send({ index: 0, delta: { content: '-continued' } });
        await expect(message.locator('.mes_text')).toContainText('old-1');
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);

        const result = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            const saved = chat.at(-1);
            const reloaded = structuredClone(saved);
            (await import('./script.js')).syncSwipeToMes(null, saved.swipe_id, reloaded);
            return {
                swipeId: saved.swipe_id,
                mes: saved.mes,
                swipes: saved.swipes,
                swipeInfoLength: saved.swipe_info.length,
                reloaded: { mes: reloaded.mes, marker: reloaded.extra.marker },
            };
        });
        expect(result).toEqual({
            swipeId: 1,
            mes: 'old-1',
            swipes: ['old-0', 'old-1', 'first-primary', 'first-alternate', 'second-primary-continued', 'second-alternate'],
            swipeInfoLength: 6,
            reloaded: { mes: 'old-1', marker: 'old-1' },
        });
    });

    test('stopping discards transient alternatives and restores the primary partial', async ({ page }) => {
        await preparePage(page, server);
        const message = page.locator('#chat .mes.last_mes');
        server.send({ index: 0, delta: { content: 'primary-partial' } });
        server.send({ index: 1, delta: { content: 'discard-me' } });
        await expect(message).toHaveClass(/live-multiswipe/);
        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('discard-me');

        await page.evaluate(async () => {
            const script = await import('./script.js');
            script.stopGeneration();
            await globalThis.__ticket2Generation;
        });

        const result = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            const saved = chat.at(-1);
            return {
                mes: saved.mes,
                swipes: saved.swipes,
                swipeInfoLength: saved.swipe_info.length,
                liveClass: globalThis.document.querySelector('#chat .mes.last_mes').classList.contains('live-multiswipe'),
                displayed: globalThis.document.querySelector('#chat .mes.last_mes .mes_text').textContent,
            };
        });
        expect(result.mes).toBe('primary-partial');
        expect(result.swipes).toEqual(['old-0', 'old-1', 'primary-partial']);
        expect(result.swipeInfoLength).toBe(3);
        expect(result.liveClass).toBe(false);
        expect(result.displayed).toContain('primary-partial');
        expect(result.displayed).not.toContain('discard-me');
    });

    test('stream errors remove transient choices without persisting them', async ({ page }) => {
        await preparePage(page, server);
        const message = page.locator('#chat .mes.last_mes');
        server.send({ index: 0, delta: { content: 'error-primary' } });
        server.send({ index: 2, delta: { content: 'error-alternate' } });
        await expect(message).toHaveClass(/live-multiswipe/);
        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('error-alternate');

        server.error();
        await page.evaluate(() => globalThis.__ticket2Generation);

        const result = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            const saved = chat.at(-1);
            return {
                mes: saved.mes,
                swipes: saved.swipes,
                swipeInfoLength: saved.swipe_info.length,
                liveClass: globalThis.document.querySelector('#chat .mes.last_mes').classList.contains('live-multiswipe'),
            };
        });
        expect(result).toEqual({
            mes: 'error-primary',
            swipes: ['old-0', 'old-1', 'error-primary'],
            swipeInfoLength: 3,
            liveClass: false,
        });
    });

    test('a true one-entry message never exposes transient multi-swipe controls', async ({ page }) => {
        await preparePage(page, server, { n: 1, generationType: 'normal', seed: false });
        const message = page.locator('#chat .mes.last_mes');
        server.send({ index: 0, delta: { content: 'single-choice.' } });
        await expect(message.locator('.mes_text')).toContainText('single-choice.');
        await expect(message).not.toHaveClass(/live-multiswipe/);
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);
        const swipes = await page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipes);
        expect(swipes).toEqual(['single-choice.']);
    });

    test('n=1 streamed impersonation finalizes without requiring a chat message', async ({ page }) => {
        await preparePage(page, server, { n: 1, generationType: 'impersonate' });
        server.send({ index: 0, delta: { content: 'impersonated reply' } });
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);

        const result = await page.evaluate(async () => {
            const { chat } = await import('./script.js');
            return {
                textarea: globalThis.document.querySelector('#send_textarea').value,
                eventText: globalThis.__ticket2ImpersonateReady,
                chat: structuredClone(chat),
            };
        });
        expect(result.textarea).toBe('impersonated reply');
        expect(result.eventText).toBe('impersonated reply');
        expect(result.chat).toHaveLength(1);
        expect(result.chat[0].swipes).toEqual(['old-0', 'old-1']);
    });
});

test.describe('continuous multi-swipe generation', () => {
    /** @type {ControlledSseServer} */
    let server;

    test.beforeEach(async () => {
        server = new ControlledSseServer();
        await server.start();
    });

    test.afterEach(async () => {
        await server.stop();
    });

    test('defaults off and does not request another batch when disabled', async ({ page }) => {
        await preparePage(page, server);
        await expect(page.locator('#continuous_multi_swipe_generation')).not.toBeChecked();
        server.send({ index: 0, delta: { content: 'disabled-primary' } });
        server.send({ index: 1, delta: { content: 'disabled-alternate' } });
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(1);
    });

    test('streams sequential batches through forced overswipe from an old selection and Stop ends the session', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        const message = page.locator('#chat .mes.last_mes');
        server.send({ index: 0, delta: { content: 'first-primary' } });
        server.send({ index: 1, delta: { content: 'first-alternate' } });
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('old-1');
        server.done();

        await server.waitForRequest(2);
        server.send({ index: 0, delta: { content: 'second-primary' } });
        server.send({ index: 1, delta: { content: 'second-alternate' } });
        server.done();
        await server.waitForRequest(3);

        await page.evaluate(async () => (await import('./script.js')).stopGeneration());
        await expect.poll(() => server.abortedCount).toBeGreaterThanOrEqual(1);
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(3);
        const result = await page.evaluate(async () => {
            const message = (await import('./script.js')).chat.at(-1);
            return { swipeId: message.swipe_id, swipes: message.swipes.slice(0, 6), swipeInfoLength: message.swipe_info.length };
        });
        expect(result.swipeId).toBeGreaterThanOrEqual(6);
        expect(result.swipes).toEqual(['old-0', 'old-1', 'first-primary', 'first-alternate', 'second-primary', 'second-alternate']);
        expect(result.swipeInfoLength).toBeGreaterThanOrEqual(6);
    });

    test('a single-choice batch terminates without retrying', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        server.send({ index: 0, delta: { content: 'multi-primary' } });
        server.send({ index: 1, delta: { content: 'multi-alternate' } });
        server.done();
        await server.waitForRequest(2);
        server.send({ index: 0, delta: { content: 'single-primary' } });
        server.done();
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
    });

    test('disabling during an active batch lets it finish and prevents the next request', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        server.send({ index: 0, delta: { content: 'first-primary' } });
        server.send({ index: 1, delta: { content: 'first-alternate' } });
        server.done();
        await server.waitForRequest(2);
        await page.evaluate(async () => {
            const { power_user } = await import('./scripts/power-user.js');
            power_user.continuous_multi_swipe_generation = false;
        });
        server.send({ index: 0, delta: { content: 'finished-primary' } });
        server.send({ index: 1, delta: { content: 'finished-alternate' } });
        server.done();
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
        const swipes = await page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipes);
        expect(swipes).toContain('finished-alternate');
    });

    test('stream errors terminate without retrying', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        server.send({ index: 0, delta: { content: 'first-primary' } });
        server.send({ index: 1, delta: { content: 'first-alternate' } });
        server.done();
        await server.waitForRequest(2);
        server.error();
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
    });

    test('a chat target change during an active batch prevents the next request', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        server.send({ index: 0, delta: { content: 'first-primary' } });
        server.send({ index: 1, delta: { content: 'first-alternate' } });
        server.done();
        await server.waitForRequest(2);
        await page.evaluate(async () => {
            const script = await import('./script.js');
            script.eventSource.emit((await import('./scripts/events.js')).event_types.CHAT_CHANGED, 'different-chat');
        });
        server.send({ index: 0, delta: { content: 'changed-primary' } });
        server.send({ index: 1, delta: { content: 'changed-alternate' } });
        server.done();
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
    });

    test('waits for the send mutex to unwind, then a real typed click aborts, sends once, and starts fresh', async ({ page }) => {
        let saveCount = 0;
        let releaseCompletionSave = () => {};
        const completionSaveGate = new Promise(resolve => {
            releaseCompletionSave = resolve;
        });
        const chatSaveHandler = async route => {
            saveCount++;
            // eslint-disable-next-line playwright/no-conditional-in-test
            if (saveCount === 2) {
                await completionSaveGate;
            }
            await route.fulfill({ status: 200, body: '{}' });
        };

        try {
            await preparePage(page, server, {
                continuous: true,
                generationType: 'normal',
                startViaSendButton: true,
                chatSaveHandler,
            });
            server.send({ index: 0, delta: { content: 'first-primary' } });
            server.send({ index: 1, delta: { content: 'first-alternate' } });
            server.done();
            await expect.poll(() => saveCount).toBe(2);
            await waitForRequestsToSettle();
            expect(server.requestCount).toBe(1);

            releaseCompletionSave();
            await server.waitForRequest(2);
            await page.evaluate(() => {
                globalThis.$('#send_textarea').val('typed exactly once').trigger('input');
                globalThis.$('#send_but').trigger('click');
            });
            await expect.poll(() => server.abortedCount).toBeGreaterThanOrEqual(1);
            await server.waitForRequest(3);
            server.send({ index: 0, delta: { content: 'new-primary' } });
            server.send({ index: 1, delta: { content: 'new-alternate' } });
            server.done();
            await server.waitForRequest(4);

            const typedMessages = await page.evaluate(async () => (await import('./script.js')).chat.filter(message => message.is_user && message.mes === 'typed exactly once').length);
            expect(typedMessages).toBe(1);
            await page.evaluate(async () => (await import('./script.js')).stopGeneration());
        } finally {
            releaseCompletionSave();
        }
    });

    test('coordinates with Auto-swipe without launching duplicate batches', async ({ page }) => {
        await preparePage(page, server, { continuous: true });
        await page.evaluate(async () => {
            const { power_user } = await import('./scripts/power-user.js');
            power_user.auto_swipe = true;
            power_user.auto_swipe_minimum_length = 1000;
        });
        server.send({ index: 0, delta: { content: 'short-primary' } });
        server.send({ index: 1, delta: { content: 'short-alternate' } });
        server.done();
        await server.waitForRequest(2);
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
        await page.evaluate(async () => (await import('./script.js')).stopGeneration());
    });

    test('updates and restores the checkbox through power-user settings', async ({ page }) => {
        await page.goto('/');
        const user = page.locator('#userList .userSelect').last();
        // The user picker is absent when this test server already has an active user.
        // eslint-disable-next-line playwright/no-conditional-in-test
        if (await user.count()) await user.click();
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
        await page.waitForFunction(async () => (await import('./script.js')).settingsReady, { timeout: 0 });
        await expect(page.locator('#continuous_multi_swipe_generation')).not.toBeChecked();

        await page.evaluate(async () => {
            globalThis.$('#continuous_multi_swipe_generation').prop('checked', true).trigger('input');
            const { power_user } = await import('./scripts/power-user.js');
            if (!power_user.continuous_multi_swipe_generation) throw new Error('Checkbox listener did not update power-user settings.');
            globalThis.$('#continuous_multi_swipe_generation').prop('checked', false);
            await (await import('./scripts/power-user.js')).loadPowerUserSettings({ power_user: { continuous_multi_swipe_generation: true } }, {});
        });
        await expect(page.locator('#continuous_multi_swipe_generation')).toBeChecked();

        await page.evaluate(async () => {
            await (await import('./scripts/power-user.js')).loadPowerUserSettings({ power_user: { continuous_multi_swipe_generation: false } }, {});
        });
        await expect(page.locator('#continuous_multi_swipe_generation')).not.toBeChecked();
    });
});

test.describe('non-streaming continuous multi-swipe generation', () => {
    /** @type {ControlledJsonServer} */
    let server;

    test.beforeEach(async () => {
        server = new ControlledJsonServer();
        await server.start();
    });

    test.afterEach(async () => {
        await server.stop();
    });

    test('requests sequential batches and stops after a single-choice response', async ({ page }) => {
        await preparePage(page, server, { continuous: true, stream: false });
        server.respond(['json-primary', 'json-alternate']);
        await server.waitForRequest(2);
        server.respond(['json-single']);
        await waitForRequestsToSettle();
        expect(server.requestCount).toBe(2);
        const swipes = await page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipes);
        expect(swipes).toEqual(['old-0', 'old-1', 'json-primary', 'json-alternate', 'json-single']);
    });
});
