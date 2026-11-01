export const pocketApi = 2;

/** The character sheet of the session's class: what it is, what it may use, and what it does not give. */
export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;

    const style = html`<style>
        .guild {
            display: grid;
            gap: 1rem;
            max-width: 44rem;
        }
        .guild h2 {
            margin: 0;
            font-size: 1.1rem;
        }
        .guild p {
            margin: 0;
        }
        .guild-head {
            display: grid;
            gap: 0.25rem;
        }
        .guild-eyebrow {
            font-size: 0.75rem;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            color: var(--text);
            opacity: 0.6;
        }
        .guild-lead {
            opacity: 0.75;
        }
        .guild-stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
            gap: 0.5rem;
            margin: 0;
        }
        .guild-stats div {
            border: 1px solid var(--line);
            border-radius: 0.5rem;
            padding: 0.5rem 0.6rem;
            display: grid;
            gap: 0.15rem;
        }
        .guild-stats dt {
            font-size: 0.72rem;
            letter-spacing: 0.06em;
            text-transform: uppercase;
            opacity: 0.6;
        }
        .guild-stats dd {
            margin: 0;
            font-weight: 600;
        }
        .guild-picker {
            display: grid;
            gap: 0.4rem;
        }
        .guild-class {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.75rem;
            border: 1px solid var(--line);
            border-radius: 0.5rem;
            padding: 0.5rem 0.6rem;
        }
        .guild-class[data-active="true"] {
            border-color: var(--accent);
        }
        .guild-class-text {
            display: grid;
            gap: 0.15rem;
            min-width: 0;
        }
        .guild-class-text strong {
            font-size: 0.95rem;
        }
        .guild-small {
            font-size: 0.8rem;
            opacity: 0.7;
        }
        .guild-button {
            flex: none;
            min-height: 2.5rem;
            padding: 0 0.9rem;
            border-radius: 0.5rem;
            border: 1px solid var(--line);
            background: transparent;
            color: inherit;
            font: inherit;
            cursor: pointer;
        }
        .guild-button[data-primary="true"] {
            border-color: var(--accent);
            color: var(--accent);
        }
        .guild-button:disabled {
            opacity: 0.6;
            cursor: default;
        }
        .guild-button:focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }
        .guild-details {
            border: 1px solid var(--line);
            border-radius: 0.5rem;
            padding: 0.5rem 0.6rem;
        }
        .guild-details summary {
            cursor: pointer;
            min-height: 2rem;
            display: flex;
            align-items: center;
        }
        .guild-details ul {
            margin: 0.4rem 0 0;
            padding-left: 1.1rem;
            display: grid;
            gap: 0.15rem;
        }
        .guild-note {
            border-left: 3px solid var(--accent);
            padding: 0.4rem 0.6rem;
            font-size: 0.85rem;
            opacity: 0.85;
        }
        .guild-label {
            display: grid;
            gap: 0.35rem;
            font-weight: 600;
        }
        .guild textarea {
            width: 100%;
            box-sizing: border-box;
            min-height: 7rem;
            padding: 0.6rem;
            border: 1px solid var(--line);
            border-radius: 0.5rem;
            color: var(--text);
            background: var(--bg);
            font: inherit;
            font-weight: 400;
        }
        .guild-row {
            display: flex;
            align-items: center;
            gap: 0.6rem;
            flex-wrap: wrap;
        }
        .guild-status {
            font-size: 0.8rem;
            opacity: 0.75;
        }
        .guild-error {
            border: 1px solid currentColor;
            border-radius: 0.5rem;
            padding: 0.5rem 0.6rem;
            font-size: 0.85rem;
        }
    </style>`;

    function Guild() {
        const [id, setId] = useState(pocket.conversationId());
        const [data, setData] = useState(null);
        const [error, setError] = useState("");
        const [saving, setSaving] = useState(false);
        const [drafts, setDrafts] = useState({});
        const [saved, setSaved] = useState("");
        const [currentClass, setCurrentClass] = useState("Loading class…");

        useEffect(() => pocket.onConversation(setId), []);
        useEffect(() => {
            setData(null);
            setError("");

            if (id === null) {
                return;
            }

            let active = true;

            pocket.api(`c/${id}/class`).then(
                (value) => {
                    if (active) {
                        setData(value);
                        setDrafts(value.prompts ?? {});
                        setCurrentClass(value.selected ? value.classes[value.selected]?.name ?? value.selected : "Unassigned");
                    }
                },
                (failure) => {
                    if (active) {
                        setError(failure.message);
                        setCurrentClass("Class unavailable");
                    }
                },
            );

            return () => {
                active = false;
            };
        }, [id]);

        async function select(selected) {
            setSaved("");
            setSaving(true);
            setError("");

            try {
                const answer = await pocket.api(`c/${id}/class`, { selected });

                if (pocket.conversationId() === id) {
                    setData((previous) => ({ ...previous, selected }));
                    setCurrentClass(selected ? data.classes[selected]?.name ?? selected : "Unassigned");
                    setSaved(
                        answer.narrowed === false
                            ? "Class saved. Its tool list could not be narrowed; every call outside the class is still blocked."
                            : "Class saved. The session's tools follow it from the next message.",
                    );
                }
            } catch (failure) {
                setError(failure.message);
            } finally {
                setSaving(false);
            }
        }

        async function savePrompt() {
            const selected = data.selected;
            const prompt = drafts[selected] ?? "";

            setSaving(true);
            setError("");
            setSaved("");

            try {
                await pocket.api(`c/${id}/prompt`, { selected, prompt });

                if (pocket.conversationId() === id) {
                    setSaved("Instructions saved for this class in every session.");
                    setData((previous) => ({
                        ...previous,
                        prompts: { ...previous.prompts, [selected]: prompt },
                    }));
                }
            } catch (failure) {
                setError(failure.message);
            } finally {
                setSaving(false);
            }
        }

        async function clearMemory() {
            setSaving(true);
            setError("");
            setSaved("");

            try {
                await pocket.api(`c/${id}/memory/clear`, {});

                if (pocket.conversationId() === id) {
                    setData((previous) => ({ ...previous, memory: [] }));
                    setSaved("All lessons forgotten.");
                }
            } catch (failure) {
                setError(failure.message);
            } finally {
                setSaving(false);
            }
        }

        if (id === null) {
            return html`<div class="guild">${style}<p>Open a session to see its class.</p></div>`;
        }

        if (error && !data) {
            return html`<div class="guild">${style}<p class="guild-error" role="alert">${error}</p></div>`;
        }

        if (!data) {
            return html`<div class="guild">${style}<p class="guild-status" role="status">Loading the guild…</p></div>`;
        }

        const chosen = data.selected ? data.classes[data.selected] : null;
        const runsOnHost = chosen
            ? ["bash", "write", "edit"].some((tool) => chosen.tools.includes(tool))
            : false;
        // One string, not a template across lines: htm drops the newline before an expression, which read "bankwork".
        const memory =
            chosen === null
                ? ""
                : `Every tool outside this class is blocked for this session, as is every MCP server it does not name. Memory: Hindsight bank ${chosen.bank}${
                      chosen.bankReady === false
                          ? `, because this class asks for ${chosen.bankWanted} and Hindsight has no such bank`
                          : ""
                  }.${runsOnHost ? " No isolation: file and shell tools run as your user on this machine." : ""}`;

        return html`
            <div class="guild">
                ${style}
                <p class="guild-small" role="status">Current class: ${currentClass}</p>
                ${
                    chosen
                        ? html`
                              <div class="guild-head">
                                  <span class="guild-eyebrow">Active class</span>
                                  <h2>${chosen.name}</h2>
                                  <p class="guild-lead">${chosen.summary}</p>
                                  <p class="guild-small">Profile ${chosen.profile}</p>
                              </div>
                              <dl class="guild-stats">
                                  <div>
                                      <dt>Tools</dt>
                                      <dd>${chosen.tools.length}</dd>
                                  </div>
                                  <div>
                                      <dt>MCP servers</dt>
                                      <dd>${chosen.mcpServers.length}</dd>
                                  </div>
                                  <div>
                                      <dt>Shared bank</dt>
                                      <dd>${chosen.bank}</dd>
                                  </div>
                                  <div>
                                      <dt>Lessons</dt>
                                      <dd>${(data.memory ?? []).length}</dd>
                                  </div>
                                  <div>
                                      <dt>Isolation</dt>
                                      <dd>none</dd>
                                  </div>
                              </dl>
                <div class="guild-picker" role="group" aria-label="Classes">
                    ${Object.entries(data.classes).map(([key, each]) => {
                        const active = data.selected === key;

                        return html`
                            <div class="guild-class" key=${key} data-active=${String(active)}>
                                <div class="guild-class-text">
                                    <strong>${each.name}</strong>
                                    <span class="guild-small">${each.summary}</span>
                                    <span class="guild-small"
                                        >${each.tools.length} tools · ${each.mcpServers.length} servers ·
                                        bank ${each.bank}</span
                                    >
                                </div>
                                <button
                                    class="guild-button"
                                    data-primary=${String(active)}
                                    disabled=${saving || active}
                                    aria-label=${active
                                        ? `${each.name}, active class`
                                        : `Switch this session to ${each.name}`}
                                    onClick=${() => select(key)}
                                >
                                    ${active ? "Active" : "Choose"}
                                </button>
                            </div>
                        `;
                    })}
                </div>
                              <p class="guild-note">${memory}</p>
                              <details class="guild-details">
                                  <summary>Tools (${chosen.tools.length})</summary>
                                  <ul>
                                      ${chosen.tools.map((tool) => html`<li key=${tool}>${tool}</li>`)}
                                  </ul>
                              </details>
                              <details class="guild-details">
                                  <summary>MCP servers (${chosen.mcpServers.length})</summary>
                                  ${
                                      chosen.mcpServers.length === 0
                                          ? html`<p class="guild-small">This class uses no MCP server.</p>`
                                          : html`<ul>
                                                ${chosen.mcpServers.map(
                                                    (server) => html`<li key=${server}>${server}</li>`,
                                                )}
                                            </ul>`
                                  }
                                  <p class="guild-small">
                                      A server works only while it is connected in the app's MCP page.
                                  </p>
                              </details>
                              <details class="guild-details">
                                  <summary>
                                      Class lessons (${(data.memory ?? []).length} of ${data.limits?.notes ?? 40})
                                  </summary>
                                  ${
                                      (data.memory ?? []).length === 0
                                          ? html`<p class="guild-small">
                                                Only this class reads these lessons. Pi distils them with
                                                class_reflect and reads the fitting ones with class_recall;
                                                the shared server context stays in Hindsight.
                                            </p>`
                                          : html`<ul>
                                                ${data.memory.map(
                                                    (note) => html`<li key=${note.id}>${note.text}</li>`,
                                                )}
                                            </ul>`
                                  }
                                  <div class="guild-row" style="margin-top:0.5rem">
                                      <button
                                          class="guild-button"
                                          disabled=${saving || (data.memory ?? []).length === 0}
                                          onClick=${clearMemory}
                                      >
                                          Forget all lessons
                                      </button>
                                  </div>
                              </details>
                              <label class="guild-label" for="guild-prompt"
                                  >Instructions for ${chosen.name}
                                  <textarea
                                      id="guild-prompt"
                                      rows="5"
                                      maxlength="8000"
                                      value=${drafts[data.selected] ?? ""}
                                      onInput=${(event) => {
                                          setSaved("");
                                          setDrafts((previous) => ({
                                              ...previous,
                                              [data.selected]: event.currentTarget.value,
                                          }));
                                      }}
                                      placeholder="Add instructions for this class"
                                  ></textarea>
                              </label>
                              <div class="guild-row">
                                  <button
                                      class="guild-button"
                                      data-primary="true"
                                      disabled=${saving}
                                      onClick=${savePrompt}
                                  >
                                      Save instructions
                                  </button>
                                  <button
                                      class="guild-button"
                                      disabled=${saving}
                                      onClick=${() => select("")}
                                  >
                                      Clear class
                                  </button>
                                  ${saved ? html`<span class="guild-status" role="status">${saved}</span>` : null}
                              </div>
                          `
                        : html`
                              <div class="guild-head">
                                  <span class="guild-eyebrow">No class</span>
                                  <h2>Unassigned</h2>
                                  <p class="guild-lead">
                                      This session has every tool, as before. Choose a class to hold it
                                      to one.
                                  </p>
                              </div>
                          `
                }
                ${error ? html`<p class="guild-error" role="alert">${error}</p>` : null}
            </div>
        `;
    }

    pocket.page({ id: "guild", title: "Guild", component: Guild });
    pocket.rail({ id: "guild", title: "Guild", icon: "grid", page: "guild" });
    pocket.sheet({ id: "classes", title: "Choose your class", component: Guild });
    const mobileClass = pocket.menu({
        id: "classes-mobile",
        label: "Class",
        hint: "Current class: loading · Switch class",
        group: "session",
        sheet: "classes",
    });
    const refreshClassLabel = (id) => {
        if (id === null) return;
        pocket.api(`c/${id}/class`).then(
            (value) => {
                const name = value.selected ? value.classes[value.selected]?.name ?? value.selected : "Unassigned";
                mobileClass.update({ label: `Class · ${name}`, hint: `Current class: ${name} · Switch class` });
            },
            () => mobileClass.update({ label: "Class", hint: "Class unavailable · Switch class" }),
        );
    };
    pocket.onConversation(refreshClassLabel);
    refreshClassLabel(pocket.conversationId());
    pocket.menu({
        id: "classes",
        label: "Class",
        hint: "Switch session class",
        group: "session",
        sheet: "classes",
    });
}
