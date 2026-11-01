import { cleanUp, newSession, openApp, owner, root, say, scriptedModel, until } from "./helpers.ts";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { after, test } from "node:test";
import { execFileSync } from "node:child_process";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import { createHandler } from "../src/server/http.ts";

after(cleanUp);

test(
    "authenticated cache panel works at phone and desktop widths",
    { skip: findBrowser() ? false : "Chromium unavailable" },
    async () => {
        const dataDir = join(root, "cache-ui");
        const ext = join(dataDir, "extensions");

        mkdirSync(ext, { recursive: true });
        copyFileSync(
            new URL("../docs/examples/cache-diagnostics.ts", import.meta.url),
            join(ext, "cache-diagnostics.ts"),
        );
        copyFileSync(
            new URL("../docs/examples/cache-diagnostics.js", import.meta.url),
            join(ext, "cache-diagnostics.js"),
        );
        symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(ext, "node_modules"));
        const app = await openApp(scriptedModel(), dataDir);

        await app.setExtensionEnabled(owner(app), "cache-diagnostics.ts", true);
        const id = await newSession(app);

        await say(app, id, "test usage");
        const server = createServer(
            createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }),
        );

        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
        const browsers = new Browsers({
            dataDir: mkdtempSync(join(root, "cache-browser-")),
            load: async () => undefined,
            save: () => {},
        });

        try {
            const page = await browsers.open(1);

            await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
            await page.navigate(`${base}/s/${id}`);
            await until(
                async () =>
                    JSON.parse(
                        await page.evaluate(
                            `return JSON.stringify(Boolean(document.querySelector('[title="Cache diagnostics"]')))`,
                        ),
                    ),
                "panel button",
            );

            for (const [name, width, height] of [
                ["desktop", 1280, 800],
                ["mobile", 390, 844],
            ] as const) {
                await page.setViewport({ width, height, scale: 1, mobile: false });
                const result = JSON.parse(
                    await page.evaluate(`
                const button = document.querySelector('[title="Cache diagnostics"]');
                if (!document.body.textContent.includes('Provider and model totals')) button.click();
                return JSON.stringify(true);
            `),
                );

                assert.equal(result, true);
                await until(
                    async () =>
                        JSON.parse(
                            await page.evaluate(
                                `return JSON.stringify(document.body.textContent.includes('Provider and model totals') && document.body.textContent.includes('faux/faux-1'))`,
                            ),
                        ),
                    "cache data",
                );

                if (name === "desktop") {
                    await page.evaluate(
                        `document.querySelectorAll('button').forEach(b => { if (b.textContent.trim() === 'Record sample') b.click(); }); return 'ok';`,
                    );
                    await until(
                        async () =>
                            JSON.parse(
                                await page.evaluate(
                                    `return JSON.stringify(!document.body.textContent.includes('No samples yet. Select Record sample'))`,
                                ),
                            ),
                        "saved sample",
                    );
                }

                await new Promise((resolve) => setTimeout(resolve, 300));
                const dimensions = JSON.parse(
                    await page.evaluate(
                        `return JSON.stringify({width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, text: document.body.textContent, panel: document.querySelector('[title="Cache diagnostics"]')?.getBoundingClientRect().toJSON()})`,
                    ),
                );

                assert.ok(dimensions.scroll <= dimensions.width, "no horizontal page overflow");
                assert.match(dimensions.text, /crash can interrupt\s+observation storage/i);
                const shot = await page.screenshot();
                const jpeg = `/tmp/cache-diagnostics-${name}.jpg`;

                writeFileSync(jpeg, Buffer.from(shot.data, "base64"));
                execFileSync("python3", [
                    "-c",
                    "from PIL import Image; import sys; Image.open(sys.argv[1]).save(sys.argv[2])",
                    jpeg,
                    `/tmp/cache-diagnostics-${name}.png`,
                ]);
            }
        } finally {
            await browsers.closeAll({ final: true });
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
            await app.close();
        }
    },
);
