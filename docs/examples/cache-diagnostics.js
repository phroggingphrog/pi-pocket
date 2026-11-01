// Cache diagnostics browser panel. The server checks conversation access for every request.
export const pocketApi = 1;

export default function setup(pocket) {
    if (typeof pocket.panel !== "function" || typeof pocket.onConversation !== "function") {
        return;
    }

    const { html, useState, useEffect, Loader } = pocket;
    const money = (n) => `$${n.toFixed(6)}`;
    const number = (n) => n.toLocaleString();

    function Panel() {
        const [conversation, setConversation] = useState(pocket.conversationId());
        const [data, setData] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const [version, setVersion] = useState(0);

        useEffect(() => pocket.onConversation(setConversation), []);
        useEffect(() => {
            const controller = new AbortController();

            setData(null);
            setError(null);

            if (conversation !== null) {
                pocket
                    .api(`usage/${encodeURIComponent(conversation)}`, undefined, {
                        signal: controller.signal,
                    })
                    .then(setData, (failure) => {
                        if (!controller.signal.aborted) {
                            setError(failure.message);
                        }
                    });
            }

            return () => controller.abort();
        }, [conversation, version]);

        async function sample() {
            setBusy(true);

            try {
                await pocket.api(`sample/${encodeURIComponent(conversation)}`, {});
                setVersion((value) => value + 1);
            } catch (failure) {
                setError(failure.message);
            } finally {
                setBusy(false);
            }
        }

        function rows(t) {
            return [
                ["Uncached input", t.input, t.costInput],
                ["Cache read", t.cacheRead, t.costRead],
                ["Cache write", t.cacheWrite, t.costWrite],
                ["Output", t.output, t.costOutput],
            ].map(
                ([label, tokens, cost]) =>
                    html`<div class="setting">
                        <span>${label}</span
                        ><span class="mono">${number(tokens)} · ${money(cost)}</span>
                    </div>`,
            );
        }

        if (conversation === null) {
            return html`<p>Open a conversation to see its cache usage.</p>`;
        }

        if (error) {
            return html`<div class="error-box">${error}</div>
                <button class="button" onClick=${() => setVersion((v) => v + 1)}>
                    Try again
                </button>`;
        }

        if (!data) {
            return html`<${Loader} label="Reading cache usage" />`;
        }

        const t = data.totals;
        const prompt = t.input + t.cacheRead + t.cacheWrite;

        return html`<div style="padding: 8px; overflow-wrap: anywhere">
            <p>Provider-reported conversation totals. Tool usage is not included.</p>
            ${rows(t)}
            <div class="setting">
                <strong>Total cost</strong><span class="mono">${money(t.costTotal)}</span>
            </div>
            <p>
                Cache read share:
                ${prompt ? `${((100 * t.cacheRead) / prompt).toFixed(1)}%` : "unavailable"}
            </p>
            <button class="button" style="min-height: 44px" disabled=${busy} onClick=${sample}>
                Record sample
            </button>
            <button
                class="button"
                style="min-height: 44px; margin-left: 8px"
                onClick=${() => setVersion((v) => v + 1)}
            >
                Refresh view
            </button>
            <h3>Provider and model totals</h3>
            <p>These totals do not establish a matched benchmark between systems.</p>
            ${data.models.length ? data.models.map((model) => html`<div><strong>${model.model}</strong>${rows(model.totals)}</div>`) : html`<p>No model usage recorded yet.</p>`}
            <h3>Manual samples</h3>
            <p>Up to 12 cumulative samples. Recording does not warm the cache.</p>
            ${data.samples.length ? data.samples.map((s) => html`<div><strong>${new Date(s.at).toLocaleString()}</strong>${rows(s.totals)}</div>`) : html`<p>No samples yet. Select Record sample to save one.</p>`}
            <h3>Committed response and refresh observations</h3>
            <p>
                Up to 100 observations recorded after each usage commit. A crash can interrupt
                observation storage. Older requests and compaction summaries are not included.
            </p>
            ${data.observations.length ? data.observations.map((s) => html`<div><strong>${new Date(s.at).toLocaleString()} · ${s.source} · ${s.outcome}</strong>${rows(s)}</div>`) : html`<p>No observations recorded yet. Historical request details are unavailable.</p>`}
            <p>Cache expiry and refresh decision causes are not available.</p>
        </div>`;
    }

    pocket.panel({ id: "cache", title: "Cache diagnostics", icon: "pulse", component: Panel });
}
