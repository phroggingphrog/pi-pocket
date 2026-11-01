import {
    cleanUp,
    newSession,
    openApp,
    owner,
    root,
    modelTexts,
    say,
    scriptedModel,
    until,
} from "../test/helpers.ts";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";
import { createHandler } from "../src/server/http.ts";

const chromium = findBrowser();
const real = { skip: chromium === undefined ? "no Chromium-based browser" : false } as const;
let app: Awaited<ReturnType<typeof openApp>>;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let conversation: number;
let base: string;

async function inPage<T>(script: string): Promise<T> {
    return JSON.parse(await page.evaluate(script)) as T;
}

async function settled(): Promise<void> {
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(document.getAnimations().every((each) => each.effect?.getComputedTiming().endTime === Infinity || each.playState !== "running" || each.effect?.target?.closest?.(".notices")))`,
            ),
        "animations to finish",
    );
    await new Promise((resolve) => setTimeout(resolve, 450));
}

before(async () => {
    if (!chromium) {
        return;
    }

    const data = join(root, "data");
    const dropIns = join(data, "extensions");
    const cwd = join(root, "workspace");

    mkdirSync(dropIns, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    cpSync(
        new URL("./conversation-annotations.ts", import.meta.url),
        join(dropIns, "conversation-annotations.ts"),
    );
    cpSync(
        new URL("./conversation-annotations", import.meta.url),
        join(dropIns, "conversation-annotations"),
        { recursive: true },
    );
    writeFileSync(join(cwd, "note.txt"), "First line\r\nSecond line\r\n");
    app = await openApp(scriptedModel(), data);
    conversation = Number(await newSession(app, cwd));
    await app.setExtensionEnabled(owner(app), "conversation-annotations.ts", true);
    server = createServer(
        createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({
        dataDir: mkdtempSync(join(root, "annotation-browser-")),
        load: async () => undefined,
        save: () => {},
    });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.navigate(`${base}/s/${conversation}`);
    await until(
        async () =>
            await inPage<boolean>(
                `return JSON.stringify(Boolean(document.querySelector('[title="Annotate a file"]')))`,
            ),
        "annotation button",
    );
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections();
    server?.close();
    await app?.close();
    cleanUp();
});

test(
    "file snapshot persists after reload and sends into history after the file changes",
    real,
    async () => {
        await page.click({ selector: '[title="Annotate a file"]' });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('#annotation-path')))`,
                ),
            "annotation sheet",
        );
        await settled();
        await page.fill({ selector: "#annotation-path" }, "note.txt");
        assert.equal(
            await inPage<string>(
                `return JSON.stringify(document.querySelector('#annotation-path').value)`,
            ),
            "note.txt",
        );
        await page.click({ selector: '.annotation-sheet button[type="submit"]' });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('#annotation-source') || document.querySelector('.annotation-sheet [role=alert]')))`,
                ),
            "file text or error",
        );
        const error = await inPage<string | null>(
            `return JSON.stringify(document.querySelector('.annotation-sheet [role=alert]')?.textContent ?? null)`,
        );

        assert.equal(error, null);
        await inPage(
            `const el = document.querySelector('#annotation-source'); el.focus(); el.setSelectionRange(6, 17); el.dispatchEvent(new Event('select', {bubbles:true})); return 'null'`,
        );
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('#annotation-comment')))`,
                ),
            "selection preview",
        );
        const state = await inPage<{ preview: string; overflow: boolean }>(
            `return JSON.stringify({preview:document.querySelector('.annotation-preview').innerText, overflow:document.documentElement.scrollWidth > innerWidth})`,
        );

        assert.match(state.preview, /line\r\nSecond/);
        assert.match(state.preview, /lines 1–2/);
        assert.equal(state.overflow, false);
        const shot = await page.screenshot();

        writeFileSync("/tmp/annotation-sheet-mobile.png", Buffer.from(shot.data, "base64"));
        await page.setViewport({ width: 1440, height: 900, scale: 1, mobile: false });
        const desktop = await inPage<boolean>(
            `return JSON.stringify(document.documentElement.scrollWidth > innerWidth)`,
        );

        assert.equal(desktop, false);
        const desktopShot = await page.screenshot();

        writeFileSync("/tmp/annotation-sheet-desktop.png", Buffer.from(desktopShot.data, "base64"));
        await page.fill({ selector: "#annotation-comment" }, "Please review");
        await page.click({ selector: ".annotation-sheet button.primary" });
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('.annotation-draft')))`,
                ),
            "annotation draft",
        );
        writeFileSync(join(root, "workspace", "note.txt"), "Changed file contents\n");
        await page.reload();
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(Boolean(document.querySelector('.annotation-draft')))`,
                ),
            "restored annotation draft",
        );
        await inPage(`document.querySelector('.annotation-draft summary').click(); return 'null'`);
        const restored = await inPage<string>(
            `return JSON.stringify(document.querySelector('.annotation-draft').innerText)`,
        );

        assert.match(restored, /line\r?\nSecond/);
        assert.match(restored, /Please review/);
        await page.click({ selector: '.composer button[aria-label="Send"]' });
        await until(
            async () =>
                (await modelTexts(app, conversation as never)).some((text) =>
                    text.includes("Please review"),
                ),
            "sent annotation in history",
        );
        const texts = await modelTexts(app, conversation as never);
        const sent = texts.find((text) => text.includes("Please review"));

        assert.match(sent ?? "", /line\\r\\nSecond/);
        assert.match(sent ?? "", /\\"start\\":6,\\"end\\":18/);
        assert.match(sent ?? "", /note\.txt/);
        assert.doesNotMatch(sent ?? "", /Changed file contents/);
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify(!document.querySelector('.annotation-draft'))`,
                ),
            "submitted draft removed",
        );
    },
);

test(
    "selected text from user and assistant messages opens the native annotation sheet",
    real,
    async () => {
        await say(app, conversation as never, "Unique zebra source selection");
        await until(
            async () =>
                await inPage<boolean>(
                    `return JSON.stringify([...document.querySelectorAll('.reply')].some(el => el.innerText.includes('echo: Unique zebra source selection')))`,
                ),
            "assistant reply",
        );
        await settled();

        for (const selector of [".user-row", ".reply"]) {
            const located = await inPage<boolean>(`
            const rows = [...document.querySelectorAll(${JSON.stringify(selector)})];
            const row = rows.find(el => el.innerText.includes('Unique zebra source selection'));
            if (!row) return 'false';
            const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
                const at = node.textContent.indexOf('zebra');
                if (at < 0) continue;
                const selection = getSelection();
                const range = document.createRange();
                range.setStart(node, at); range.setEnd(node, at + 5);
                selection.removeAllRanges(); selection.addRange(range);
                document.dispatchEvent(new Event('selectionchange'));
                return 'true';
            }
            return 'false';
        `);

            assert.equal(located, true, `selection in ${selector}`);
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector('.selection-message-action')))`,
                    ),
                "selection action",
            );
            await page.click({ selector: ".selection-message-action" });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector('.ext-message-action[data-module="conversation-annotations"]')))`,
                    ),
                "native message action",
            );
            await settled();
            await page.click({
                selector: '.ext-message-action[data-module="conversation-annotations"]',
            });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(Boolean(document.querySelector('.annotation-preview')))`,
                    ),
                "captured selection preview",
            );
            const preview = await inPage<string>(
                `return JSON.stringify(document.querySelector('.annotation-preview').innerText)`,
            );

            assert.match(preview, /zebra/);
            assert.match(preview, /Message/);
            await settled();
            await page.click({ selector: '.sheet button[aria-label="Close"]' });
            await until(
                async () =>
                    await inPage<boolean>(
                        `return JSON.stringify(!document.querySelector('.annotation-sheet'))`,
                    ),
                "annotation sheet closed",
            );
            await settled();
        }
    },
);
