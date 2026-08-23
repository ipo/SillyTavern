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

    async waitForRequest() {
        await expect.poll(() => this.response !== null).toBe(true);
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

async function preparePage(page, server, { n = 3, generationType = 'swipe' } = {}) {
    await page.goto('/');
    const user = page.locator('#userList .userSelect').last();
    if (await user.count()) await user.click();
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    const onboarding = page.locator('dialog .onboarding');
    if (await onboarding.isVisible()) {
        await page.locator('dialog .popup-button-ok').click();
    }
    await page.route('**/api/chats/save', route => route.fulfill({ status: 200, body: '{}' }));
    await page.route('**/api/backends/chat-completions/generate', route => route.continue({ url: server.url }));

    await page.evaluate(async ({ n, generationType }) => {
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
        const seed = {
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
        script.chat.push(seed);
        script.addOneMessage(seed, { scroll: false });
        globalThis.$('#main_api').val('openai').trigger('change');
        script.setOnlineStatus('Connected');
        Object.assign(oai_settings, {
            chat_completion_source: chat_completion_sources.CUSTOM,
            custom_model: 'live-multiswipe-test',
            custom_url: 'https://example.invalid/v1',
            stream_openai: true,
            n,
            show_thoughts: true,
        });
        power_user.streaming_fps = 20;
        power_user.auto_swipe = false;
        if (generationType === 'impersonate') {
            script.eventSource.once(event_types.IMPERSONATE_READY, text => globalThis.__ticket2ImpersonateReady = text);
        }
        globalThis.__ticket2Generation = script.Generate(generationType);
    }, { n, generationType });
    await server.waitForRequest();
}

const counterText = locator => locator.evaluate(element => element.textContent.replaceAll('\u200b', ''));
const clickArrow = locator => locator.evaluate(element => element.click());

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

    test('navigates only observed choices and finalizes the selected choice once', async ({ page }) => {
        await preparePage(page, server);
        const message = page.locator('#chat .mes.last_mes');
        const counter = message.locator('.swipes-counter');

        server.send({ index: 0, delta: { reasoning_content: 'reasoning-0', content: 'primary-a' } });
        await expect(message.locator('.mes_text')).toContainText('primary-a');
        await expect(message).not.toHaveClass(/live-multiswipe/);

        server.send({ index: 2, delta: { reasoning_content: 'reasoning-2', content: 'choice-2a' } });
        await expect.poll(() => counterText(counter)).toBe('1/2');

        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('choice-2a');
        await expect.poll(() => counterText(counter)).toBe('2/2');

        server.send({ index: 0, delta: { content: '-primary-b' } });
        await expect.poll(() => message.locator('.mes_text').textContent()).toContain('choice-2a');
        await clickArrow(message.locator('.swipe_right'));
        await clickArrow(message.locator('.swipe_right'));
        expect(server.requestCount).toBe(1);
        expect(server.abortedCount).toBe(0);

        server.send({ index: 1, delta: { reasoning_content: 'reasoning-1', content: 'choice-1' } });
        await expect.poll(() => counterText(counter)).toBe('3/3');
        await expect(message.locator('.mes_text')).toContainText('choice-2a');

        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('choice-1');
        await expect.poll(() => counterText(counter)).toBe('2/3');
        server.send({ index: 2, delta: { content: '-choice-2b' } });
        await expect.poll(() => message.locator('.mes_text').textContent()).toContain('choice-1');
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('primary-a-primary-b');
        await expect.poll(() => counterText(counter)).toBe('1/3');
        await clickArrow(message.locator('.swipe_left'));
        await clickArrow(message.locator('.swipe_left'));
        expect(server.requestCount).toBe(1);
        expect(server.abortedCount).toBe(0);
        await clickArrow(message.locator('.swipe_right'));
        await clickArrow(message.locator('.swipe_right'));
        await expect(message.locator('.mes_text')).toContainText('choice-2a-choice-2b');

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
        expect(result.saved.swipes).toEqual(['old-0', 'old-1', 'primary-a-primary-b', 'choice-1', 'choice-2a-choice-2b']);
        expect(result.saved.swipe_info).toHaveLength(5);
        expect(result.saved.swipe_id).toBe(4);
        expect(result.saved.mes).toBe('choice-2a-choice-2b');
        expect(result.saved.extra.reasoning).toBe('reasoning-2');
        expect(result.saved.swipe_info.slice(0, 2).map(info => info.extra.marker)).toEqual(['old-0', 'old-1']);
        expect(result.saved.swipes.every(value => typeof value === 'string')).toBe(true);
        expect(result.reloaded).toEqual({ mes: 'choice-2a-choice-2b', reasoning: 'reasoning-2' });
        expect(result.liveClass).toBe(false);
        expect(server.requestCount).toBe(1);
        expect(server.abortedCount).toBe(0);

        await page.evaluate(async () => (await import('./script.js')).showSwipeButtons());
        await clickArrow(message.locator('.swipe_left'));
        await expect(message.locator('.mes_text')).toContainText('choice-1');
        await expect.poll(async () => page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipe_id)).toBe(3);
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

    test('n=1 never exposes transient multi-swipe controls', async ({ page }) => {
        await preparePage(page, server, { n: 1 });
        const message = page.locator('#chat .mes.last_mes');
        server.send({ index: 0, delta: { content: 'single-choice' } });
        await expect(message.locator('.mes_text')).toContainText('single-choice');
        await expect(message).not.toHaveClass(/live-multiswipe/);
        server.done();
        await page.evaluate(() => globalThis.__ticket2Generation);
        const swipes = await page.evaluate(async () => (await import('./script.js')).chat.at(-1).swipes);
        expect(swipes).toEqual(['old-0', 'old-1', 'single-choice']);
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
