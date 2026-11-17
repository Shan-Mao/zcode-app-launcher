/**
 * ZCode 外部程序启动器（注入到渲染层）
 * ==================================
 * 在左侧栏「插件市场」与任务列表之间插入一排按钮，点击后通过 preload 暴露的
 * IPC 桥调用 ZCode 主进程，执行预先配置的软件启动或启动链。
 *
 * 该文件由 patcher.mjs 注入为 out/renderer/zcode-app-launcher.js。
 * 没有任何常驻进程：链式命令在主进程内 spawn 后立即返回。
 *
 * 设计约束：
 * - React 拥有左侧栏的 DOM，注入节点随时可能被重渲染移除，所以用
 *   MutationObserver 检测并补挂；卸载时保持幂等。
 * - 按钮只发送「配置里的按钮 id」，不发送命令本身，服务端也只执行白名单；
 *   页面无法借这里执行任意命令。
 */
(() => {
  "use strict";
  if (window.__zcodeAppLauncher) return;
  window.__zcodeAppLauncher = true;

  const bridge = () => {
    const z = window.zcode;
    return z && typeof z.launcherLaunch === "function" ? z : null;
  };

  const requireBridge = () => {
    const b = bridge();
    if (!b) throw new Error("启动桥接未就绪：请完全退出并重新打开 ZCode");
    return b;
  };
  const BAR_ID = "zcode-app-launcher-bar";
  const STYLE_ID = "zcode-app-launcher-style";
  // 「插件市场」下方的导航区结束后，紧接着就是整个任务列表区域。
  // 插在它前面 = 插件市场与任务列表之间；旧版锚点作为兜底。
  const ANCHOR = '[data-testid="sidebar-task-list-region"]';
  const FALLBACK_ANCHOR = '[data-purpose-section-list="true"]';

  const state = { config: null, error: "", loading: true };
  const expanded = new Set();
  const clampFs = (n, d = 12) => {
    n = Number(n);
    return Number.isFinite(n) && n >= 11 && n <= 18 ? n : d;
  };
  const barFs = () => clampFs(state.config && state.config.ui && state.config.ui.barFontSize);
  const panelFs = () => clampFs(state.config && state.config.ui && state.config.ui.panelFontSize);
  const clampOp = (n, d = 100) => {
    n = Number(n);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : d;
  };
  const barOpacity = () => clampOp(state.config && state.config.ui && state.config.ui.barOpacity);
  const panelOpacity = () => clampOp(state.config && state.config.ui && state.config.ui.panelOpacity);
  const diag = (window.__zcodeAppLauncherDiag = { mounts: 0, errors: [] });

  // ---------------------------------------------------------------- utilities
  const h = (tag, props, ...kids) => {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
        else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
        else if (k === "text") el.textContent = v;
        else el.setAttribute(k, v === true ? "" : String(v));
      }
    }
    for (const kid of kids.flat()) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  };

  const loadConfig = async () => {
    state.loading = true;
    try {
      const cfg = await requireBridge().launcherGetConfig();
      state.config = cfg;
      state.error = "";
    } catch (err) {
      state.error = err.message || String(err);
      diag.errors.push(state.error);
    } finally {
      state.loading = false;
      renderBar();
    }
  };

  // ------------------------------------------------------------------ styles
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const css = `
      #${BAR_ID} {
        display: flex;
        flex-direction: column;
        align-items: stretch;
        gap: 1px;
        margin: 0 8px 8px;
        padding: 4px;
        box-sizing: border-box;
        border-radius: 10px;
        border: 1px solid rgba(127,127,127,.14);
        background: rgba(127,127,127, calc(.07 * var(--zl-bar-opacity, 1)));
        font-size: var(--zl-fs, 12px);
        line-height: calc(var(--zl-fs, 12px) + 6px);
        color: var(--vscode-foreground, inherit);
        user-select: none;
        overflow: hidden;
        flex: none;
      }
      #${BAR_ID} .zl-btn {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 8px;
        width: 100%;
        height: calc(var(--zl-fs, 12px) + 15px);
        padding: 0 7px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        white-space: nowrap;
        overflow: hidden;
        opacity: .88;
        transition: background-color .12s ease, opacity .12s ease;
        text-align: left;
      }
      #${BAR_ID} .zl-btn:hover { background: rgba(127,127,127,.18); opacity: 1; }
      #${BAR_ID} .zl-btn:active { background: rgba(127,127,127,.28); }
      #${BAR_ID} .zl-btn .zl-ico {
        width: 18px;
        flex: none;
        text-align: center;
        font-size: calc(var(--zl-fs, 12px) + 2px);
        line-height: 1;
      }
      #${BAR_ID} .zl-btn .zl-label {
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      #${BAR_ID} .zl-btn.zl-gear {
        opacity: .55;
        margin-top: 2px;
        border-top: 1px solid rgba(127,127,127,.12);
        border-radius: 0 0 6px 6px;
        padding-top: 3px;
        height: calc(var(--zl-fs, 12px) + 14px);
      }
      #${BAR_ID} .zl-btn.zl-gear:hover { opacity: 1; }
      #${BAR_ID} .zl-btn .zl-caret {
        margin-left: auto;
        width: 22px;
        height: 22px;
        flex: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border: 0;
        border-radius: 5px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 14px;
        line-height: 1;
        cursor: pointer;
        opacity: .65;
      }
      #${BAR_ID} .zl-btn .zl-caret:hover { background: rgba(127,127,127,.22); opacity: 1; }
      #${BAR_ID} .zl-sub {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        height: calc(var(--zl-fs, 12px) + 12px);
        padding: 0 7px 0 26px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: var(--zl-fs, 12px);
        text-align: left;
        cursor: pointer;
        opacity: .8;
        white-space: nowrap;
        overflow: hidden;
      }
      #${BAR_ID} .zl-sub:hover { background: rgba(127,127,127,.14); opacity: 1; }
      #${BAR_ID} .zl-sub .zl-ico { width: 18px; flex: none; text-align: center; font-size: var(--zl-fs, 12px); }
      #${BAR_ID} .zl-sub .zl-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
      #${BAR_ID} .zl-btn.zl-ok { color: #3fb950; }
      #${BAR_ID} .zl-btn.zl-err { color: #f85149; }
      #${BAR_ID} .zl-btn.zl-busy { opacity: .5; }
      #${BAR_ID} .zl-spacer { flex: 1; }
      #${BAR_ID} .zl-gear { opacity: .5; }
      #${BAR_ID} .zl-gear:hover { opacity: 1; }
      #${BAR_ID} .zl-warn { color: #d29922; }

      .zl-modal-mask {
        position: fixed; inset: 0; z-index: 2147483000;
        background: rgba(0,0,0,.45);
        display: flex; align-items: center; justify-content: center;
        font-size: var(--zl-fs-panel, 12px);
      }
      .zl-modal {
        width: min(620px, calc(100vw - 48px));
        max-height: min(560px, calc(100vh - 64px));
        display: flex; flex-direction: column;
        font-size: calc(var(--zl-fs-panel, 12px) + 1px);
        color-scheme: dark;
        background: var(--vscode-editor-background, #1f1f22);
        background: color-mix(in srgb, var(--vscode-editor-background, #1f1f22) calc(96% * var(--zl-panel-opacity, 1)), transparent);
        color: var(--vscode-foreground, #e6e6e6);
        border: 1px solid rgba(127,127,127,.28);
        border-radius: 10px;
        box-shadow: 0 18px 48px rgba(0,0,0,.45);
        overflow: hidden;
      }
      .zl-modal-head, .zl-modal-foot {
        display: flex; align-items: center; gap: 8px;
        padding: 12px 16px;
        border-bottom: 1px solid rgba(127,127,127,.18);
      }
      .zl-modal-foot { border-bottom: 0; border-top: 1px solid rgba(127,127,127,.18); justify-content: flex-end; }
      .zl-modal-title { font-weight: 600; flex: 1; }
      .zl-head-tabs { display: flex; gap: 2px; flex: none; }
      .zl-modal-body { display: flex; gap: 0; flex: 1; min-height: 0; }
      .zl-prefs { flex: 1; overflow: auto; padding: 18px 20px; display: flex; flex-direction: column; gap: 14px; }
      .zl-pref-title { font-weight: 600; opacity: .85; margin-top: 4px; }
      .zl-range { flex: 1; accent-color: #2f6feb; }
      .zl-list { width: 180px; border-right: 1px solid rgba(127,127,127,.18); overflow: auto; padding: 8px; }
      .zl-list-item {
        display: flex; align-items: center; gap: 6px;
        width: 100%; padding: 7px 8px; margin-bottom: 2px;
        border: 0; border-radius: 6px; background: transparent;
        color: inherit; font: inherit; text-align: left; cursor: pointer;
      }
      .zl-list-item:hover { background: rgba(127,127,127,.14); }
      .zl-list-item.zl-active { background: rgba(127,127,127,.22); }
      .zl-list-name { display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; }
      .zl-list-ops { display: flex; gap: 2px; flex: none; }
      .zl-mini {
        width: 20px; height: 20px; padding: 0;
        border: 0; border-radius: 4px; background: transparent;
        color: inherit; font: inherit; font-size: 12px; line-height: 1;
        cursor: pointer; opacity: .55;
      }
      .zl-mini:hover:not(:disabled) { background: rgba(127,127,127,.2); opacity: 1; }
      .zl-mini:disabled { opacity: .2; cursor: default; }
      .zl-form { flex: 1; overflow: auto; padding: 14px 16px; display: flex; flex-direction: column; gap: 10px; }
      .zl-row { display: flex; align-items: center; gap: 8px; }
      .zl-row > label { width: 68px; flex: none; opacity: .75; }
      .zl-input {
        flex: 1; min-width: 0; height: calc(var(--zl-fs-panel, 12px) + 16px); padding: 0 8px;
        border: 1px solid rgba(127,127,127,.3); border-radius: 6px;
        background: rgba(127,127,127,.08); color: inherit; font: inherit;
      }
      .zl-input:focus { outline: 1px solid rgba(90,160,255,.7); border-color: transparent; }
      .zl-size {
        width: 96px;
        flex: none;
        color-scheme: dark;
        background: rgba(127,127,127,.12);
      }
      .zl-size option { background: #1f1f22; color: #e6e6e6; }
      .zl-steps { display: flex; flex-direction: column; gap: 8px; }
      .zl-step-card {
        display: flex; flex-direction: column; gap: 7px;
        padding: 9px 10px;
        border: 1px solid rgba(127,127,127,.16);
        border-radius: 8px;
        background: rgba(127,127,127,.04);
      }
      .zl-step-title {
        display: flex; align-items: center; justify-content: space-between;
        gap: 8px; opacity: .8;
      }
      .zl-tabs { display: flex; gap: 2px; margin-left: auto; }
      .zl-tab {
        height: calc(var(--zl-fs-panel, 12px) + 10px); padding: 0 8px; border: 0; border-radius: 5px;
        background: transparent; color: inherit; font: inherit;
        font-size: inherit; cursor: pointer; opacity: .55;
      }
      .zl-tab:hover { background: rgba(127,127,127,.14); opacity: .85; }
      .zl-tab.zl-active { background: rgba(127,127,127,.22); opacity: 1; }
      .zl-step { display: flex; align-items: center; gap: 6px; }
      .zl-step .zl-input.zl-cmd { flex: 1; }
      .zl-step .zl-input.zl-delay { width: 76px; flex: none; text-align: right; }
      .zl-btn2 {
        height: calc(var(--zl-fs-panel, 12px) + 16px); padding: 0 12px; border-radius: 6px; cursor: pointer;
        border: 1px solid rgba(127,127,127,.3); background: transparent;
        color: inherit; font: inherit;
      }
      .zl-btn2:hover { background: rgba(127,127,127,.14); }
      .zl-btn2.zl-primary { background: #2f6feb; border-color: #2f6feb; color: #fff; }
      .zl-btn2.zl-danger { color: #f85149; }
      .zl-btn2:disabled { opacity: .45; cursor: default; }
      .zl-hint { opacity: .55; font-size: inherit; line-height: 1.5; }
      .zl-empty { opacity: .6; padding: 24px 0; text-align: center; }
      .zl-toast {
        position: fixed; z-index: 2147483200; right: 20px; bottom: 20px;
        max-width: 360px; padding: 10px 14px; border-radius: 8px;
        background: rgba(30,30,34,.96); color: #eee; font-size: var(--zl-fs-panel, 12px);
        border: 1px solid rgba(127,127,127,.3); box-shadow: 0 8px 24px rgba(0,0,0,.35);
      }

      @media (prefers-color-scheme: light) {
        #${BAR_ID} { background: rgba(0,0,0, calc(.04 * var(--zl-bar-opacity, 1))); border-color: rgba(0,0,0,.1); }
        #${BAR_ID} .zl-btn:hover { background: rgba(0,0,0,.06); }
        #${BAR_ID} .zl-btn:active { background: rgba(0,0,0,.1); }
        #${BAR_ID} .zl-btn.zl-gear { border-top-color: rgba(0,0,0,.08); }
        #${BAR_ID} .zl-btn .zl-caret:hover { background: rgba(0,0,0,.08); }
        #${BAR_ID} .zl-sub:hover { background: rgba(0,0,0,.05); }
        .zl-modal {
          background: var(--vscode-editor-background, #ffffff);
          background: color-mix(in srgb, var(--vscode-editor-background, #ffffff) calc(96% * var(--zl-panel-opacity, 1)), transparent);
          color: var(--vscode-foreground, #1f2328);
          border-color: rgba(0,0,0,.12);
          box-shadow: 0 18px 48px rgba(0,0,0,.18);
          color-scheme: light;
        }
        .zl-size { color-scheme: light; background: rgba(0,0,0,.03); }
        .zl-size option { background: #ffffff; color: #1f2328; }
        .zl-modal-head, .zl-modal-foot { border-color: rgba(0,0,0,.08); }
        .zl-list { border-color: rgba(0,0,0,.08); }
        .zl-list-item:hover { background: rgba(0,0,0,.05); }
        .zl-list-item.zl-active { background: rgba(0,0,0,.08); }
        .zl-input { background: rgba(0,0,0,.03); border-color: rgba(0,0,0,.16); }
        .zl-btn2 { border-color: rgba(0,0,0,.16); }
        .zl-btn2:hover { background: rgba(0,0,0,.05); }
        .zl-step-card { border-color: rgba(0,0,0,.1); background: rgba(0,0,0,.02); }
        .zl-tab:hover { background: rgba(0,0,0,.06); }
        .zl-tab.zl-active { background: rgba(0,0,0,.1); }
        .zl-toast {
          background: #ffffff; color: #1f2328;
          border-color: rgba(0,0,0,.12); box-shadow: 0 8px 24px rgba(0,0,0,.15);
        }
      }
    `;
    document.head.append(h("style", { id: STYLE_ID, text: css }));
  }

  // --------------------------------------------------------------- launch bar
  function launch(id, btn, stepIndex) {
    btn.classList.add("zl-busy");
    if ("disabled" in btn) btn.disabled = true;
    Promise.resolve()
      .then(() => requireBridge().launcherLaunch(id, stepIndex))
      .then((res) => {
        if (res && res.ok === false) throw new Error(res.error || "启动失败");
        btn.classList.add("zl-ok");
        setTimeout(() => btn.classList.remove("zl-ok"), 1200);
      })
      .catch((err) => {
        btn.classList.add("zl-err");
        btn.title = `启动失败：${err.message}`;
        setTimeout(() => btn.classList.remove("zl-err"), 2000);
        toast(`启动失败：${err.message}`);
      })
      .finally(() => {
        btn.classList.remove("zl-busy");
        if ("disabled" in btn) btn.disabled = false;
      });
  }

  const baseName = (p) =>
    String(p || "")
      .split(/[\\/]/)
      .pop()
      .replace(/\.(exe|bat|cmd|lnk)$/i, "");

  function stepLabel(step, i) {
    if (step.label) return step.label;
    const parsed = splitRun(step.run);
    if (parsed.program) return baseName(parsed.program) || `第 ${i + 1} 步`;
    const first = String(step.run || "").trim().split(/\s+/)[0] || "";
    return baseName(first) || `第 ${i + 1} 步`;
  }

  function groupEl(item) {
    const steps = item.steps || [];
    const isGroup = steps.length > 1;
    const open = expanded.has(item.id);
    const frag = document.createDocumentFragment();

    const row = h(
      "div",
      {
        class: "zl-btn",
        role: "button",
        tabindex: "0",
        "aria-label": item.label || item.id,
        title: `${item.label || item.id}${isGroup ? `：整组按顺序启动（${steps.length} 步）` : ""}\n${steps
          .map((s) => s.run)
          .join("\n")}`,
      },
      h("span", { class: "zl-ico", text: item.icon || "▸" }),
      h("span", { class: "zl-label", text: item.label || item.id })
    );

    row.addEventListener("click", () => launch(item.id, row));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        launch(item.id, row);
      }
    });

    if (isGroup) {
      const caret = h("button", {
        class: "zl-caret",
        type: "button",
        title: open ? "收起" : "展开，可单独启动每个程序",
        "aria-label": open ? "收起" : "展开",
        "aria-expanded": String(open),
        text: open ? "▾" : "▸",
      });
      caret.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (open) expanded.delete(item.id);
        else expanded.add(item.id);
        renderBar();
      });
      row.append(caret);
    }
    frag.append(row);

    if (isGroup && open) {
      steps.forEach((step, i) => {
        const sub = h(
          "button",
          { class: "zl-sub", type: "button", title: step.run, "aria-label": stepLabel(step, i) },
          h("span", { class: "zl-ico", text: "•" }),
          h("span", { class: "zl-label", text: stepLabel(step, i) })
        );
        sub.addEventListener("click", (e) => {
          e.preventDefault();
          e.stopPropagation();
          launch(item.id, sub, i);
        });
        frag.append(sub);
      });
    }
    return frag;
  }

  const findAnchor = () =>
    document.querySelector(ANCHOR) || document.querySelector(FALLBACK_ANCHOR);

  function renderBar() {
    const anchor = findAnchor();
    if (!anchor) return;
    ensureStyle();
    let bar = document.getElementById(BAR_ID);
    if (!bar) {
      bar = h("div", { id: BAR_ID, role: "toolbar", "aria-label": "外部程序启动器" });
      anchor.parentElement.insertBefore(bar, anchor);
      diag.mounts += 1;
    }
    bar.style.setProperty("--zl-fs", `${barFs()}px`);
    bar.style.setProperty("--zl-bar-opacity", String(barOpacity() / 100));
    bar.replaceChildren();
    if (state.loading) {
      bar.append(h("span", { class: "zl-btn zl-busy", text: "…" }));
      return;
    }
    if (state.error) {
      const warn = h("button", {
        class: "zl-btn zl-warn",
        style: { width: "auto", padding: "0 6px" },
        title: `桥接未就绪：${state.error}\n点击重试；若一直如此，请完全重启 ZCode`,
        text: "⚠ 启动器未就绪",
      });
      warn.addEventListener("click", loadConfig);
      bar.append(warn);
      return;
    }
    const items = (state.config && state.config.buttons) || [];
    for (const item of items) bar.append(groupEl(item));
    if (!items.length) {
      const hint = h("button", { class: "zl-btn", title: "还没有启动项，点这里添加", "aria-label": "添加启动项" });
      hint.append(
        h("span", { class: "zl-ico", text: "＋" }),
        h("span", { class: "zl-label", text: "添加启动项" })
      );
      hint.addEventListener("click", (e) => {
        e.stopPropagation();
        openEditor(true);
      });
      bar.append(hint);
    }
    const gear = h("button", { class: "zl-btn zl-gear", title: "配置启动项", "aria-label": "配置启动项" });
    gear.append(
      h("span", { class: "zl-ico", text: "⚙" }),
      h("span", { class: "zl-label", text: "配置" })
    );
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      openEditor();
    });
    bar.append(gear);
  }

  function toast(message) {
    document.querySelectorAll(".zl-toast").forEach((n) => n.remove());
    const el = h("div", { class: "zl-toast", text: message });
    document.body.append(el);
    setTimeout(() => el.remove(), 4000);
  }

  // ------------------------------------------------------------------ editor
  const splitRun = (run) => {
    const s = String(run || "").trim();
    if (s.startsWith('"')) {
      const end = s.indexOf('"', 1);
      if (end > 0) return { program: s.slice(1, end), args: s.slice(end + 1).trim() };
    }
    return { program: "", args: s };
  };

  const joinRun = (program, args) => {
    const p = String(program || "").trim();
    const a = String(args || "").trim();
    if (!p) return a;
    const quoted = /\s/.test(p) ? `"${p}"` : p;
    return a ? `${quoted} ${a}` : quoted;
  };

  const pick = async (kind) => {
    const b = bridge();
    if (!b) return null;
    try {
      return await (kind === "folder" ? b.launcherPickFolder() : b.launcherPickProgram());
    } catch {
      return null;
    }
  };

  function openEditor(startNew) {
    if (document.querySelector(".zl-modal-mask")) return;
    const draft = JSON.parse(JSON.stringify(state.config || { port: 0, buttons: [] }));
    draft.buttons = Array.isArray(draft.buttons) ? draft.buttons : [];
    const srcUi = draft.ui || {};
    draft.ui = {
      barFontSize: clampFs(srcUi.barFontSize, barFs()),
      panelFontSize: clampFs(srcUi.panelFontSize, panelFs()),
      barOpacity: clampOp(srcUi.barOpacity, barOpacity()),
      panelOpacity: clampOp(srcUi.panelOpacity, panelOpacity()),
    };
    let selected = draft.buttons.length ? 0 : -1;
    let page = "buttons";

    const sizeSelect = (value, onChange) => {
      const sel = h("select", { class: "zl-input zl-size" });
      for (const [label, v] of [
        ["小 11", 11],
        ["标准 12", 12],
        ["大 14", 14],
        ["特大 16", 16],
        ["极大 18", 18],
      ]) {
        const opt = h("option", { value: String(v), text: label });
        if (v === value) opt.selected = true;
        sel.append(opt);
      }
      sel.addEventListener("change", () => onChange(Number(sel.value)));
      return sel;
    };

    const opRange = (label, value, onChange) => {
      const out = h("span", {
        class: "zl-hint",
        style: { width: "44px", textAlign: "right", flex: "none" },
        text: `${value}%`,
      });
      const input = h("input", {
        class: "zl-range",
        type: "range",
        min: "0",
        max: "100",
        step: "1",
        value: String(value),
      });
      input.addEventListener("input", () => {
        const v = Number(input.value);
        out.textContent = `${v}%`;
        onChange(v);
      });
      return h("div", { class: "zl-row" }, h("label", { text: label }), input, out);
    };

    const list = h("div", { class: "zl-list" });
    const form = h("div", { class: "zl-form" });
    const body = h("div", { class: "zl-modal-body" });
    const tabsEl = h("div", { class: "zl-head-tabs" });
    const saveBtn = h("button", { class: "zl-btn2 zl-primary", text: "保存" });
    const cancelBtn = h("button", { class: "zl-btn2", text: "取消" });

    const prefsPage = () => {
      const wrap = h("div", { class: "zl-prefs" });
      wrap.append(
        h("div", { class: "zl-pref-title", text: "字号" }),
        h(
          "div",
          { class: "zl-row" },
          h("label", { text: "侧栏" }),
          sizeSelect(draft.ui.barFontSize, (v) => {
            draft.ui.barFontSize = v;
            const bar = document.getElementById(BAR_ID);
            if (bar) bar.style.setProperty("--zl-fs", `${v}px`);
          })
        ),
        h(
          "div",
          { class: "zl-row" },
          h("label", { text: "设置页" }),
          sizeSelect(draft.ui.panelFontSize, (v) => {
            draft.ui.panelFontSize = v;
            mask.style.setProperty("--zl-fs-panel", `${v}px`);
          })
        ),
        h("div", { class: "zl-pref-title", text: "背景不透明度" }),
        opRange("侧栏", draft.ui.barOpacity, (v) => {
          draft.ui.barOpacity = v;
          const bar = document.getElementById(BAR_ID);
          if (bar) bar.style.setProperty("--zl-bar-opacity", String(v / 100));
        }),
        opRange("设置页", draft.ui.panelOpacity, (v) => {
          draft.ui.panelOpacity = v;
          mask.style.setProperty("--zl-panel-opacity", String(v / 100));
        }),
        h("div", {
          class: "zl-hint",
          text: "调低后可以透出 ZCode 的背景/壁纸；0% 完全透明，100% 不透明。",
        })
      );
      return wrap;
    };

    const paintTabs = () => {
      tabsEl.replaceChildren();
      for (const [text, value] of [
        ["启动项", "buttons"],
        ["个性化", "prefs"],
      ]) {
        const b = h("button", {
          class: `zl-tab${page === value ? " zl-active" : ""}`,
          type: "button",
          text,
        });
        b.addEventListener("click", () => {
          page = value;
          renderBody();
        });
        tabsEl.append(b);
      }
    };

    const renderBody = () => {
      paintTabs();
      body.replaceChildren();
      if (page === "buttons") body.append(list, form);
      else body.append(prefsPage());
    };

    const mask = h(
      "div",
      { class: "zl-modal-mask" },
      h(
        "div",
        { class: "zl-modal" },
        h(
          "div",
          { class: "zl-modal-head" },
          h("div", { class: "zl-modal-title", text: "设置" }),
          tabsEl
        ),
        body,
        h(
          "div",
          { class: "zl-modal-foot" },
          cancelBtn,
          saveBtn
        )
      )
    );
    mask.style.setProperty("--zl-fs-panel", `${draft.ui.panelFontSize}px`);
    mask.style.setProperty("--zl-panel-opacity", String(draft.ui.panelOpacity / 100));

    const close = () => mask.remove();
    cancelBtn.addEventListener("click", close);
    mask.addEventListener("mousedown", (e) => {
      if (e.target === mask) close();
    });
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") close();
      },
      { once: true }
    );

    const newButton = () => {
      const n = draft.buttons.length + 1;
      draft.buttons.push({
        id: `button-${Date.now().toString(36)}`,
        label: `按钮 ${n}`,
        icon: "▸",
        cwd: "",
        steps: [{ run: "", delayMs: 800 }],
      });
      selected = draft.buttons.length - 1;
      paint();
    };

    const moveButton = (from, to) => {
      if (to < 0 || to >= draft.buttons.length || from === to) return;
      const [item] = draft.buttons.splice(from, 1);
      draft.buttons.splice(to, 0, item);
      selected = to;
      paint();
    };

    const paintList = () => {
      list.replaceChildren();
      draft.buttons.forEach((item, i) => {
        const up = h("button", {
          class: "zl-mini",
          type: "button",
          text: "↑",
          title: "上移",
          disabled: i === 0,
        });
        up.addEventListener("click", (e) => {
          e.stopPropagation();
          moveButton(i, i - 1);
        });
        const down = h("button", {
          class: "zl-mini",
          type: "button",
          text: "↓",
          title: "下移",
          disabled: i === draft.buttons.length - 1,
        });
        down.addEventListener("click", (e) => {
          e.stopPropagation();
          moveButton(i, i + 1);
        });

        const row = h(
          "div",
          {
            class: `zl-list-item${i === selected ? " zl-active" : ""}`,
            role: "button",
            tabindex: "0",
          },
          h(
            "span",
            { class: "zl-list-name" },
            h("span", { text: item.icon || "▸" }),
            h("span", {
              text: item.label || item.id,
              style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
            })
          ),
          h("span", { class: "zl-list-ops" }, up, down)
        );
        row.addEventListener("click", () => {
          selected = i;
          paint();
        });
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selected = i;
            paint();
          }
        });
        list.append(row);
      });
      const add = h("button", { class: "zl-btn2", style: { width: "100%", marginTop: "6px" }, text: "＋ 新增按钮" });
      add.addEventListener("click", newButton);
      list.append(add);
    };

    const paintForm = () => {
      form.replaceChildren();
      const item = draft.buttons[selected];
      if (!item) {
        form.append(h("div", { class: "zl-empty", text: "还没有按钮，点左侧「＋ 新增按钮」" }));
        return;
      }
      const label = h("input", { class: "zl-input", value: item.label || "" });
      label.addEventListener("input", () => {
        item.label = label.value;
        paintList();
      });
      const icon = h("input", { class: "zl-input", value: item.icon || "", style: { width: "64px", flex: "none" } });
      icon.addEventListener("input", () => {
        item.icon = icon.value;
        paintList();
      });
      const cwd = h("input", { class: "zl-input", value: item.cwd || "", placeholder: "可选，默认不用改" });
      cwd.addEventListener("input", () => {
        item.cwd = cwd.value;
      });
      const cwdPick = h("button", { class: "zl-btn2", text: "选择…" });
      cwdPick.addEventListener("click", async () => {
        const picked = await pick("folder");
        if (picked) {
          item.cwd = picked;
          cwd.value = picked;
        }
      });

      const steps = h("div", { class: "zl-steps" });
      const paintSteps = () => {
        steps.replaceChildren();
        (item.steps || []).forEach((step, si) => {
          const parsed = splitRun(step.run);
          const mode =
            step._mode ||
            (parsed.program ? "program" : String(step.run || "").trim() ? "command" : "program");

          const del = h("button", { class: "zl-btn2 zl-danger", text: "删除", title: "删除这一步" });
          del.addEventListener("click", () => {
            item.steps.splice(si, 1);
            paintSteps();
          });

          const moveStep = (to) => {
            if (to < 0 || to >= item.steps.length) return;
            const [s] = item.steps.splice(si, 1);
            item.steps.splice(to, 0, s);
            paintSteps();
          };
          const upStep = h("button", {
            class: "zl-mini",
            type: "button",
            text: "↑",
            title: "上移这一步",
            disabled: si === 0,
          });
          upStep.addEventListener("click", () => moveStep(si - 1));
          const downStep = h("button", {
            class: "zl-mini",
            type: "button",
            text: "↓",
            title: "下移这一步",
            disabled: si === item.steps.length - 1,
          });
          downStep.addEventListener("click", () => moveStep(si + 1));

          const tab = (text, value) => {
            const b = h("button", {
              class: `zl-tab${mode === value ? " zl-active" : ""}`,
              text,
              type: "button",
            });
            b.addEventListener("click", () => {
              step._mode = value;
              paintSteps();
            });
            return b;
          };

          const card = h(
            "div",
            { class: "zl-step-card" },
            h(
              "div",
              { class: "zl-step-title" },
              h("span", { text: `第 ${si + 1} 步` }),
              h("div", { class: "zl-tabs" }, tab("选择程序", "program"), tab("写命令", "command")),
              h("span", { class: "zl-list-ops" }, upStep, downStep, del)
            )
          );

          const stepName = h("input", {
            class: "zl-input",
            value: step.label || "",
            placeholder: `第 ${si + 1} 步的显示名（展开菜单里用）`,
          });
          stepName.addEventListener("input", () => {
            step.label = stepName.value;
          });
          card.append(h("div", { class: "zl-row" }, h("label", { text: "名称" }), stepName));

          if (mode === "command") {
            const cmd = h("input", {
              class: "zl-input",
              value: step.run || "",
              placeholder: '例如：code . 或 start "" "https://example.com"',
            });
            cmd.addEventListener("input", () => {
              step.run = cmd.value;
            });
            card.append(
              h("div", { class: "zl-row" }, h("label", { text: "命令" }), cmd),
              h("div", { class: "zl-hint", text: "按 cmd 命令行执行，适合 code . / start / 带参数的高级写法。" })
            );
          } else {
            if (parsed.program) {
              const pathInput = h("input", { class: "zl-input", value: parsed.program, readonly: true });
              const choose = h("button", { class: "zl-btn2", text: "更换…" });
              choose.addEventListener("click", async () => {
                const picked = await pick("program");
                if (picked) {
                  step.run = joinRun(picked, splitRun(step.run).args);
                  if (!step.label) step.label = baseName(picked);
                  step._mode = "program";
                  paintSteps();
                }
              });
              card.append(h("div", { class: "zl-row" }, h("label", { text: "程序" }), pathInput, choose));
            } else {
              const current = h("span", {
                class: "zl-hint",
                text: step.run ? `当前：${step.run}` : "还没有选择程序",
                style: { flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
              });
              const choose = h("button", { class: "zl-btn2 zl-primary", text: "选择程序…" });
              choose.addEventListener("click", async () => {
                const picked = await pick("program");
                if (picked) {
                  const args = splitRun(step.run).args;
                  step.run = joinRun(picked, args);
                  if (!step.label) step.label = baseName(picked);
                  step._mode = "program";
                  paintSteps();
                }
              });
              card.append(h("div", { class: "zl-row" }, h("label", { text: "程序" }), current, choose));
            }
            const argsInput = h("input", {
              class: "zl-input",
              value: parsed.args,
              placeholder: "可选，比如网址或文件参数",
            });
            argsInput.addEventListener("input", () => {
              const current = splitRun(step.run);
              step.run = joinRun(current.program, argsInput.value);
            });
            card.append(h("div", { class: "zl-row" }, h("label", { text: "参数" }), argsInput));
          }

          const delay = h("input", {
            class: "zl-input zl-delay",
            type: "number",
            min: "0",
            step: "100",
            value: String(step.delayMs ?? 0),
            title: "发出这一步后，隔多久执行下一步",
          });
          delay.addEventListener("input", () => {
            step.delayMs = Math.max(0, Number(delay.value) || 0);
          });
          card.append(
            h(
              "div",
              { class: "zl-row" },
              h("label", { text: "等待" }),
              delay,
              h("span", { class: "zl-hint", text: "毫秒" })
            )
          );
          steps.append(card);
        });
        const addStep = h("button", { class: "zl-btn2", text: "＋ 再加一个程序", style: { alignSelf: "flex-start" } });
        addStep.addEventListener("click", () => {
          item.steps = item.steps || [];
          item.steps.push({ run: "", delayMs: 800 });
          paintSteps();
        });
        steps.append(addStep);
      };
      paintSteps();

      const del = h("button", { class: "zl-btn2 zl-danger", text: "删除这个按钮" });
      del.addEventListener("click", () => {
        draft.buttons.splice(selected, 1);
        selected = Math.min(selected, draft.buttons.length - 1);
        paint();
      });

      form.append(
        h("div", { class: "zl-row" }, h("label", { text: "名称" }), label, icon),
        h("div", { class: "zl-row" }, h("label", { text: "工作目录" }), cwd, cwdPick),
        h("div", { class: "zl-hint", text: "点一级按钮 = 按顺序整组启动；点右侧箭头展开后，可单独启动其中某个程序。" }),
        steps,
        h("div", { class: "zl-row", style: { marginTop: "4px" } }, del)
      );
    };

    const paint = () => {
      paintList();
      paintForm();
    };

    saveBtn.addEventListener("click", async () => {
      saveBtn.disabled = true;
      try {
        const cleaned = {
          port: 0,
          ui: {
            barFontSize: clampFs(draft.ui && draft.ui.barFontSize, 12),
            panelFontSize: clampFs(draft.ui && draft.ui.panelFontSize, 12),
            barOpacity: clampOp(draft.ui && draft.ui.barOpacity, 100),
            panelOpacity: clampOp(draft.ui && draft.ui.panelOpacity, 100),
          },
          buttons: draft.buttons.map((b, i) => ({
            id: b.id || `button-${i}`,
            label: String(b.label || "").trim() || `按钮 ${i + 1}`,
            icon: String(b.icon || "▸").slice(0, 4),
            cwd: String(b.cwd || "").trim(),
            steps: (b.steps || [])
              .map((s) => ({
                run: String(s.run || "").trim(),
                delayMs: Math.max(0, Number(s.delayMs) || 0),
                label: String(s.label || "").trim().slice(0, 40),
              }))
              .filter((s) => s.run),
          })),
        };
        state.config = await requireBridge().launcherSetConfig(cleaned);
        close();
        renderBar();
        toast("已保存");
      } catch (err) {
        toast(`保存失败：${err.message}`);
      } finally {
        saveBtn.disabled = false;
      }
    });

    if (startNew) newButton();
    else paint();
    renderBody();
    document.body.append(mask);
  }

  // ------------------------------------------------------------------- mount
  function tryMount() {
    const anchor = findAnchor();
    if (!anchor) return;
    const bar = document.getElementById(BAR_ID);
    if (bar && bar.isConnected && bar.nextElementSibling === anchor) return;
    if (bar) bar.remove();
    renderBar();
  }

  ensureStyle();
  tryMount();
  if (!state.config) loadConfig();

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      tryMount();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
