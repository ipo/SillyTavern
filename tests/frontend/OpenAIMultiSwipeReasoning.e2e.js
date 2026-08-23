import { test, expect } from '@playwright/test';

test.describe('OpenAI multi-swipe reasoning', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/');
        const user = page.locator('#userList .userSelect').last();
        if (await user.count()) {
            await user.click();
        }
        await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 0 });
    });

    test('keeps interleaved native reasoning aligned with each streamed swipe', async ({ page }) => {
        const events = [
            { choices: [{ index: 0, delta: { reasoning_content: 'reasoning-0' } }] },
            { choices: [{ index: 2, delta: { reasoning: 'reasoning-2' } }] },
            { choices: [{ index: 1, delta: { reasoning_content: 'reasoning-1' } }] },
            { choices: [{ index: 0, delta: { content: 'primary' } }] },
            { choices: [{ index: 2, delta: { content: 'swipe-2' } }] },
            { choices: [{ index: 1, delta: { content: 'swipe-1' } }] },
        ];
        const sse = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`;

        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: sse,
        }));

        const stream = await page.evaluate(async () => {
            const { sendOpenAIRequest, oai_settings, chat_completion_sources } = await import('./scripts/openai.js');
            const previous = {
                chat_completion_source: oai_settings.chat_completion_source,
                custom_model: oai_settings.custom_model,
                stream_openai: oai_settings.stream_openai,
                n: oai_settings.n,
                show_thoughts: oai_settings.show_thoughts,
            };

            try {
                Object.assign(oai_settings, {
                    chat_completion_source: chat_completion_sources.CUSTOM,
                    custom_model: 'test-model',
                    stream_openai: true,
                    n: 3,
                    show_thoughts: true,
                });
                const generator = await sendOpenAIRequest('normal', [{ role: 'user', content: 'test' }]);
                let latest = null;
                for await (const frame of generator()) {
                    latest = {
                        text: frame.text,
                        swipes: [...frame.swipes],
                        swipeReasoning: [...frame.swipeReasoning],
                        primaryReasoning: frame.state.reasoning,
                    };
                }
                return latest;
            } finally {
                Object.assign(oai_settings, previous);
            }
        });

        expect(stream).toEqual({
            text: 'primary',
            swipes: ['swipe-1', 'swipe-2'],
            swipeReasoning: ['reasoning-1', 'reasoning-2'],
            primaryReasoning: 'reasoning-0',
        });

        const finalized = await page.evaluate(async () => {
            const { parseReasoningInSwipes, ReasoningType } = await import('./scripts/reasoning.js');
            const { syncSwipeToMes } = await import('./script.js');
            const { power_user } = await import('./scripts/power-user.js');
            const previousReasoning = structuredClone(power_user.reasoning);

            try {
                Object.assign(power_user.reasoning, { auto_parse: true, prefix: '<think>', suffix: '</think>' });
                const swipes = ['<think>inline-1</think>swipe-1', '<think>inline-2</think>swipe-2'];
                const swipeInfo = swipes.map(() => ({ extra: {} }));
                parseReasoningInSwipes(swipes, swipeInfo, 12, ['reasoning-1', 'reasoning-2']);

                const reloaded = JSON.parse(JSON.stringify({
                    swipe_id: 0,
                    swipes: ['primary', ...swipes],
                    swipe_info: [
                        { extra: { reasoning: 'reasoning-0', reasoning_type: ReasoningType.Model } },
                        ...swipeInfo,
                    ],
                }));
                const selections = [0, 1, 2].map(swipeId => {
                    const message = structuredClone(reloaded);
                    syncSwipeToMes(null, swipeId, message);
                    return { mes: message.mes, extra: message.extra };
                });

                const plainSwipeInfo = [{ extra: {} }];
                parseReasoningInSwipes(['plain swipe'], plainSwipeInfo, 12);
                return { swipes, swipeInfo, selections, plainSwipeInfo };
            } finally {
                Object.assign(power_user.reasoning, previousReasoning);
            }
        });

        expect(finalized.swipes).toEqual(['swipe-1', 'swipe-2']);
        expect(finalized.swipeInfo.map(info => info.extra)).toEqual([
            { reasoning: 'reasoning-1', reasoning_type: 'model' },
            { reasoning: 'reasoning-2', reasoning_type: 'model' },
        ]);
        expect(finalized.selections).toEqual([
            { mes: 'primary', extra: { reasoning: 'reasoning-0', reasoning_type: 'model' } },
            { mes: 'swipe-1', extra: { reasoning: 'reasoning-1', reasoning_type: 'model' } },
            { mes: 'swipe-2', extra: { reasoning: 'reasoning-2', reasoning_type: 'model' } },
        ]);
        expect(finalized.plainSwipeInfo).toEqual([{ extra: {} }]);
    });

    test('does not retain native swipe reasoning when Show Thoughts is disabled', async ({ page }) => {
        const sse = 'data: {"choices":[{"index":1,"delta":{"reasoning_content":"hidden","content":"<think>inline</think>swipe"}}]}\n\ndata: [DONE]\n\n';
        await page.route('**/api/backends/chat-completions/generate', route => route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
            body: sse,
        }));

        const swipeInfo = await page.evaluate(async () => {
            const { sendOpenAIRequest, oai_settings, chat_completion_sources } = await import('./scripts/openai.js');
            const { parseReasoningInSwipes } = await import('./scripts/reasoning.js');
            const { power_user } = await import('./scripts/power-user.js');
            const previous = {
                chat_completion_source: oai_settings.chat_completion_source,
                custom_model: oai_settings.custom_model,
                stream_openai: oai_settings.stream_openai,
                n: oai_settings.n,
                show_thoughts: oai_settings.show_thoughts,
            };
            const previousReasoning = structuredClone(power_user.reasoning);

            try {
                Object.assign(oai_settings, {
                    chat_completion_source: chat_completion_sources.CUSTOM,
                    custom_model: 'test-model',
                    stream_openai: true,
                    n: 2,
                    show_thoughts: false,
                });
                Object.assign(power_user.reasoning, { auto_parse: true, prefix: '<think>', suffix: '</think>' });
                const generator = await sendOpenAIRequest('normal', [{ role: 'user', content: 'test' }]);
                let latest = null;
                for await (const frame of generator()) latest = frame;
                const info = latest.swipes.map(() => ({ extra: {} }));
                parseReasoningInSwipes(latest.swipes, info, null, latest.swipeReasoning);
                return info;
            } finally {
                Object.assign(oai_settings, previous);
                Object.assign(power_user.reasoning, previousReasoning);
            }
        });

        expect(swipeInfo).toEqual([{ extra: { reasoning: 'inline', reasoning_duration: null, reasoning_type: 'parsed' } }]);
    });
});
