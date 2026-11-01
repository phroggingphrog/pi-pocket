export const pocketApi = 2;

/** The Pi Pocket task manager. */
export default function setup(pocket) {
    const { html, useEffect, useState } = pocket;
    const statuses = ["open", "working", "review", "done"];
    const style = html`<style>
        .tm {
            display: grid;
            gap: 1rem;
            max-width: 56rem;
        }
        .tm h2,
        .tm h3,
        .tm p {
            margin: 0;
        }
        .tm-head,
        .tm-row,
        .tm-actions {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.6rem;
            flex-wrap: wrap;
        }
        .tm-list,
        .tm-group,
        .tm-form {
            display: grid;
            gap: 0.65rem;
        }
        .tm-task {
            display: grid;
            gap: 0.45rem;
            border: 1px solid var(--line);
            border-radius: 0.6rem;
            padding: 0.8rem;
            min-width: 0;
        }
        .tm-muted {
            opacity: 0.72;
            font-size: 0.86rem;
        }
        .tm button,
        .tm input,
        .tm textarea,
        .tm select {
            font: inherit;
            color: inherit;
        }
        .tm button {
            min-height: 2.75rem;
            padding: 0.45rem 0.8rem;
            border: 1px solid var(--line);
            border-radius: 0.5rem;
            background: transparent;
            cursor: pointer;
        }
        .tm button:focus-visible,
        .tm input:focus-visible,
        .tm textarea:focus-visible,
        .tm select:focus-visible {
            outline: 2px solid var(--accent);
            outline-offset: 2px;
        }
        .tm input,
        .tm textarea,
        .tm select {
            width: 100%;
            min-height: 2.75rem;
            padding: 0.55rem;
            border: 1px solid var(--line);
            border-radius: 0.45rem;
            background: var(--surface);
        }
        .tm textarea {
            min-height: 5rem;
            resize: vertical;
        }
        .tm label {
            display: grid;
            gap: 0.25rem;
        }
        .tm-error {
            border: 1px solid var(--danger, #b33);
            border-radius: 0.5rem;
            padding: 0.65rem;
        }
        .tm-success {
            color: var(--accent);
        }
        .tm-session {
            overflow-wrap: anywhere;
        }
        @media (max-width: 600px) {
            .tm-head {
                align-items: stretch;
            }
            .tm-head > * {
                width: 100%;
            }
            .tm-actions button {
                flex: 1 1 8rem;
            }
            .tm-task {
                padding: 0.7rem;
            }
        }
    </style>`;

    function Manager() {
        const [tasks, setTasks] = useState(null);
        const [sessions, setSessions] = useState([]);
        const [error, setError] = useState("");
        const [message, setMessage] = useState("");
        const [busy, setBusy] = useState(false);
        const [draft, setDraft] = useState(null);
        const [form, setForm] = useState({ title: "", goal: "", acceptance: "" });

        async function load() {
            setBusy(true);
            setError("");

            try {
                const data = await pocket.api("x/board/tasks");

                setTasks(data.tasks);
                setSessions(data.sessions ?? []);
            } catch (failure) {
                setError(failure.message || "Tasks could not load.");
            } finally {
                setBusy(false);
            }
        }

        useEffect(() => {
            void load();
        }, []);

        async function saveNew(event) {
            event.preventDefault();
            setBusy(true);
            setError("");
            setMessage("");

            try {
                const data = await pocket.api("x/board/tasks", {
                    title: form.title,
                    goal: form.goal,
                    acceptance: form.acceptance
                        .split("\n")
                        .map((x) => x.trim())
                        .filter(Boolean),
                });

                setMessage(`${data.task.id} created.`);
                setForm({ title: "", goal: "", acceptance: "" });
                await load();
            } catch (failure) {
                setError(failure.message || "Task could not be created.");
            } finally {
                setBusy(false);
            }
        }

        async function update(id, patch, success) {
            setBusy(true);
            setError("");
            setMessage("");

            try {
                await pocket.api(`x/board/tasks/${encodeURIComponent(id)}`, patch);
                setMessage(success);
                setDraft(null);
                await load();
            } catch (failure) {
                setError(failure.message || "Task could not be saved.");
            } finally {
                setBusy(false);
            }
        }

        async function link(id, sessionId) {
            if (!sessionId) {
                return;
            }

            setBusy(true);
            setError("");
            setMessage("");

            try {
                await pocket.api(`x/board/c/${sessionId}/tasks/${encodeURIComponent(id)}/link`, {});
                setMessage(`${id} linked to session.`);
                await load();
            } catch (failure) {
                setError(failure.message || "Session link could not be saved.");
            } finally {
                setBusy(false);
            }
        }

        const all = tasks ?? [];
        const grouped = statuses
            .map((status) => [status, all.filter((task) => task.status === status)])
            .filter(([, rows]) => rows.length);

        return html`<main class="tm">
            ${style}
            <header class="tm-head">
                <div>
                    <h2>Tasks</h2>
                    <p class="tm-muted">
                        ${tasks === null ? "Loading tasks…" : `${all.filter((x) => x.status !== "done").length} open of ${all.length}`}
                    </p>
                </div>
                <button disabled=${busy} onClick=${load}>${busy ? "Working…" : "Refresh"}</button>
            </header>
            ${error ? html`<p class="tm-error" role="alert">${error}</p>` : null}
            ${message ? html`<p class="tm-success" role="status">${message}</p>` : null}
            <form class="tm-form" onSubmit=${saveNew}>
                <h3>Create task</h3>
                <label
                    >Title<input
                        required
                        maxlength="200"
                        value=${form.title}
                        onInput=${(e) => setForm({ ...form, title: e.currentTarget.value })}
                /></label>
                <label
                    >Goal<textarea
                        required
                        maxlength="4000"
                        value=${form.goal}
                        onInput=${(e) => setForm({ ...form, goal: e.currentTarget.value })}
                    ></textarea>
                </label>
                <label
                    >Acceptance criteria <span class="tm-muted">One criterion per line.</span
                    ><textarea
                        value=${form.acceptance}
                        onInput=${(e) => setForm({ ...form, acceptance: e.currentTarget.value })}
                    ></textarea>
                </label>
                <button type="submit" disabled=${busy}>Create task</button>
            </form>
            ${
                tasks === null
                    ? html`<p role="status">Loading tasks…</p>`
                    : all.length === 0
                      ? html`<p>No tasks yet. Create the first task above.</p>`
                      : html`<div class="tm-list">
                            ${grouped.map(
                                ([status, rows]) =>
                                    html`<section class="tm-group">
                                        <h3>${status} · ${rows.length}</h3>
                                        ${rows.map(
                                            (task) =>
                                                html` <article class="tm-task">
                                                    <div class="tm-row">
                                                        <strong>${task.id} · ${task.title}</strong
                                                        ><span class="tm-muted"
                                                            >${task.heldBy}${task.age === "abandoned" ? " · claim expired" : ""}</span
                                                        >
                                                    </div>
                                                    <p>${task.goal}</p>
                                                    ${
                                                        task.acceptance.length
                                                            ? html`<ul>
                                                                  ${task.acceptance.map((x) => html`<li>${x}</li>`)}
                                                              </ul>`
                                                            : html`<p class="tm-muted">
                                                                  No acceptance criteria.
                                                              </p>`
                                                    }
                                                    ${task.note ? html`<p class="tm-muted">${task.note}</p>` : null}
                                                    ${task.claim ? html`<p class="tm-muted tm-session">Session ${task.claim.conversationId} · ${task.claim.by}</p>` : null}
                                                    ${
                                                        draft === task.id
                                                            ? html`<form
                                                                  class="tm-form"
                                                                  onSubmit=${(e) => {
                                                                      e.preventDefault();
                                                                      const f = new FormData(
                                                                          e.currentTarget,
                                                                      );

                                                                      void update(
                                                                          task.id,
                                                                          {
                                                                              title: f.get("title"),
                                                                              goal: f.get("goal"),
                                                                              acceptance: String(
                                                                                  f.get(
                                                                                      "acceptance",
                                                                                  ),
                                                                              )
                                                                                  .split("\n")
                                                                                  .map((x) =>
                                                                                      x.trim(),
                                                                                  )
                                                                                  .filter(Boolean),
                                                                              note: f.get("note"),
                                                                          },
                                                                          `${task.id} updated.`,
                                                                      );
                                                                  }}
                                                              >
                                                                  <label
                                                                      >Title<input
                                                                          name="title"
                                                                          required
                                                                          maxlength="200"
                                                                          value=${task.title} /></label
                                                                  ><label
                                                                      >Goal<textarea
                                                                          name="goal"
                                                                          required
                                                                          maxlength="4000"
                                                                      >
${task.goal}</textarea>
                                                                  </label>
                                                                  <label
                                                                      >Acceptance criteria<textarea
                                                                          name="acceptance"
                                                                      >
${task.acceptance.join("\n")}</textarea></label
                                                                  ><label
                                                                      >Note<input
                                                                          name="note"
                                                                          maxlength="1000"
                                                                          value=${task.note}
                                                                  /></label>
                                                                  <div class="tm-actions">
                                                                      <button
                                                                          type="submit"
                                                                          disabled=${busy}
                                                                      >
                                                                          Save</button
                                                                      ><button
                                                                          type="button"
                                                                          disabled=${busy}
                                                                          onClick=${() => setDraft(null)}
                                                                      >
                                                                          Cancel
                                                                      </button>
                                                                  </div>
                                                              </form>`
                                                            : html`<div class="tm-actions">
                                                                  <label
                                                                      >Status<select
                                                                          aria-label=${`Status for ${task.id}`}
                                                                          value=${task.status}
                                                                          disabled=${busy}
                                                                          onChange=${(e) => void update(task.id, { status: e.currentTarget.value }, `${task.id} moved to ${e.currentTarget.value}.`)}
                                                                      >
                                                                          ${statuses.map((s) => html`<option value=${s}>${s}</option>`)}
                                                                      </select></label
                                                                  ><button
                                                                      disabled=${busy}
                                                                      onClick=${() => setDraft(task.id)}
                                                                  >
                                                                      Edit
                                                                  </button>
                                                                  ${
                                                                      sessions.length
                                                                          ? html`<label
                                                                                >Link to
                                                                                session<select
                                                                                    aria-label=${`Session for ${task.id}`}
                                                                                    disabled=${busy}
                                                                                    value=""
                                                                                    onChange=${(e) => void link(task.id, e.currentTarget.value)}
                                                                                >
                                                                                    <option
                                                                                        value=""
                                                                                    >
                                                                                        Choose
                                                                                        session
                                                                                    </option>
                                                                                    ${sessions.filter((s) => !s.archived).map((s) => html`<option value=${s.id}>${s.title || `Session ${s.id}`}</option>`)}
                                                                                </select></label
                                                                            >`
                                                                          : null
                                                                  }
                                                              </div>`
                                                    }
                                                </article>`,
                                        )}
                                    </section>`,
                            )}
                        </div>`
            }
        </main>`;
    }

    pocket.page({ id: "tasks", title: "Tasks", component: Manager });
    pocket.rail({ id: "tasks", title: "Tasks", icon: "list", page: "tasks" });
    pocket.menu({
        id: "tasks",
        label: "Tasks",
        hint: "Create and manage tasks",
        group: "app",
        page: "tasks",
    });
}
