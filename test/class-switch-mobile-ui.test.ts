import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import { type App, cleanUp, newSession, openApp, owner, root, scriptedModel, until } from "./helpers.ts";
import { createHandler } from "../src/server/http.ts";
import { Browsers } from "../src/server/browser.ts";
import { findBrowser } from "../src/server/browser/discovery.ts";
import type { BrowserPage } from "../src/server/browser/page.ts";

const browser = findBrowser();
const real = { skip: browser === undefined ? "no Chromium-based browser" : false } as const;
let app: App;
let server: Server;
let browsers: Browsers;
let page: BrowserPage;
let base: string;
let session: number;
const ext = join(root, "data", "extensions");
const waitFor = async (selector: string) => until(async () => (await page.evaluate(`return JSON.stringify(!!document.querySelector(${JSON.stringify(selector)}))`)) === "true", selector);

test("owner sees class switch in the phone Places sheet and it keeps the current class", real, async () => {
    mkdirSync(join(ext, "phrog-classes"), { recursive: true });
    writeFileSync(join(ext, "phrog-classes.ts"), `/** Classes: test class picker routes. */\nimport { defineDoc } from "@earendil-works/pi-durable";\nconst TestClass = defineDoc({kind:"x.test.class",version:1,scope:"conversation",initial:()=>({selected:"coding"})});\nexport default (_host, web) => { web.client("phrog-classes", { access: "owner" }); web.conversationRoute("GET", "c/:conversation/class", async (req) => ({ ...(await req.snapshot(TestClass, req.conversation.id, req.context)), classes: { coding: { name: "Coding" }, design: { name: "Design" } } }), { conversation: "conversation", access: "owner" }); web.conversationRoute("POST", "c/:conversation/class", async (req) => { await req.commit(async tx=>{(await tx.doc(TestClass,req.conversation.id)).selected=req.body.selected}); return {selected:req.body.selected}; }, { conversation: "conversation", access: "owner" }); };`);
    writeFileSync(join(ext, "phrog-classes/index.js"), `export default (pocket) => { const menu=pocket.menu({id:"classes-mobile",label:"Class",hint:"Loading class…",group:"app",sheet:"classes"}); pocket.onConversation((id)=>{if(id!==null)pocket.api(\`c/\${id}/class\`).then(v=>menu.update({label:\`Class · \${v.classes[v.selected].name}\`,hint:"Switch class"}));}); pocket.sheet({id:"classes",title:"Choose your class",component:()=>pocket.html\`<p>Class choices</p>\`}); pocket.menu({id:"classes-session",label:"Class",hint:"Switch session class",group:"session",sheet:"classes"}); };`);
    app = await openApp(scriptedModel());
    await app.setExtensionEnabled(owner(app), "phrog-classes.ts", true);
    session = await newSession(app);
    server = createServer(createHandler({ app, listen: { host: "127.0.0.1", port: 0 }, restart: () => {} }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    browsers = new Browsers({ dataDir: mkdtempSync(join(root, "class-mobile-ui-")), load: async () => undefined, save: () => {} });
    page = await browsers.open(1);
    await page.setViewport({ width: 390, height: 844, scale: 1, mobile: true });
    await page.navigate(`${base}/login?token=${encodeURIComponent(app.config.ownerToken)}`);
    await page.evaluate(`(await import("/store.js")).navigate(${session})`);
    await waitFor('.topbar [aria-label="Menu"]');
    await page.evaluate(`document.querySelector('.topbar [aria-label="Menu"]').click()`);
    await waitFor('.places');
    const label = await page.evaluate(`return JSON.stringify([...document.querySelectorAll('.place-label')].map(x=>x.textContent))`);
    assert.match(label, /Class/);
    await page.evaluate(`(await import('/store.js')).openSheet({type:'menu'})`);
    await waitFor('.menu-session');
    const sessionEntry = await page.evaluate(`return JSON.stringify(document.querySelector('.menu-session')?.innerText)`);
    assert.match(sessionEntry, /Class/);
    const auth = await page.evaluate(`return JSON.stringify((await import('/store.js')).store.state.me?.role)`);
    assert.equal(auth, '"owner"');
    await page.evaluate(`(await import('/extension-ui.js')).openPage('phrog-classes','guild')`);
    await waitFor('.ext-page');
    assert.equal(await page.evaluate(`return JSON.stringify(document.querySelector('.ext-page')!==null)`), "true");

    const beforeResponse = await fetch(`${base}/api/x/phrog-classes/c/${session}/class`, {
        headers: { "X-Pocket": "1", Cookie: `pocket_auth=${encodeURIComponent(app.config.ownerToken)}` },
    });
    const before = (await beforeResponse.json()).selected as string;
    const response = await fetch(`${base}/api/x/phrog-classes/c/${session}/class`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pocket": "1", Cookie: `pocket_auth=${encodeURIComponent(app.config.ownerToken)}` },
        body: JSON.stringify({ selected: "design" }),
    });
    assert.equal(response.status, 200);
    const afterRead = await fetch(`${base}/api/x/phrog-classes/c/${session}/class`, {
        headers: { "X-Pocket": "1", Cookie: `pocket_auth=${encodeURIComponent(app.config.ownerToken)}` },
    });
    assert.equal((await afterRead.json()).selected, "design");
    const restore = await fetch(`${base}/api/x/phrog-classes/c/${session}/class`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Pocket": "1", Cookie: `pocket_auth=${encodeURIComponent(app.config.ownerToken)}` },
        body: JSON.stringify({ selected: before }),
    });
    assert.equal(restore.status, 200);
    const restored = await fetch(`${base}/api/x/phrog-classes/c/${session}/class`, {
        headers: { "X-Pocket": "1", Cookie: `pocket_auth=${encodeURIComponent(app.config.ownerToken)}` },
    });
    assert.equal((await restored.json()).selected, before);
});

after(async () => {
    await browsers?.closeAll({ final: true });
    server?.closeAllConnections(); server?.close();
    await app?.close(); cleanUp();
});
