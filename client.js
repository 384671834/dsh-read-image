window.__ModuleLoader__.load({
	id: "@local/dsh-vision-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");

		// ---- 样式：只用主题 token，跟随明暗主题 ----
		const css = [
			".dvb_wrap{align-items:center;gap:6px;display:inline-flex;font-size:13px;line-height:20px}",
			".dvb_toggle{display:inline-flex;align-items:center;gap:6px;border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:999px;padding:2px 10px;font-size:13px;font-weight:500;line-height:20px;cursor:pointer}",
			".dvb_toggle:hover:not(:disabled){color:var(--dsw-alias-label-primary)}",
			".dvb_toggle:disabled{opacity:.6;cursor:default}",
			".dvb_toggle[aria-checked=\"true\"]{color:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary)}",
			".dvb_dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;flex:none;opacity:.45}",
			".dvb_toggle[aria-checked=\"true\"] .dvb_dot{opacity:1}",
			".dvb_select{border:.5px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;padding:2px 6px;font-size:12px;line-height:18px;max-width:210px}",
			".dvb_err{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;max-width:240px}",
		].join("");
		const tagId = "@local/dsh-vision-bridge/VisionChip.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@local/dsh-vision-bridge";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const NS = "vision";
		const zh = {
			"label": "视觉",
			"aria.on": "视觉读图已启用，按下关闭",
			"aria.off": "视觉读图已关闭，按下启用",
			"title.on": "视觉读图已启用 — 图片会发给所选多模态模型，只把文字结论返回本会话",
			"title.off": "视觉读图已关闭 — 点击启用，会话模型无需切换",
			"model.aria": "选择读图用的多模态模型",
			"failed": "操作失败",
			"noImage": "（未声明图像）",
		};
		const en = {
			"label": "Vision",
			"aria.on": "Vision reading on, press to turn off",
			"aria.off": "Vision reading off, press to turn on",
			"title.on": "Vision reading on — images go to the selected multimodal model; only text comes back",
			"title.off": "Vision reading off — press to enable; the session model never changes",
			"model.aria": "Choose the multimodal model used for reading images",
			"failed": "Action failed",
			"noImage": " (no image declared)",
		};

		/** 从命令返回的文本里取出 @@VISION {...} 状态块。 */
		function parseStatus(result) {
			const text = result?.value?.result?.text;
			if (typeof text !== "string") return undefined;
			const at = text.indexOf("@@VISION ");
			if (at < 0) return undefined;
			try {
				const payload = JSON.parse(text.slice(at + "@@VISION ".length).trim());
				if (typeof payload?.enabled !== "boolean") return undefined;
				return payload;
			} catch {
				return undefined;
			}
		}

		function VisionChip({ run, t }) {
			const [status, setStatus] = react.useState(undefined);
			const [error, setError] = react.useState(null);
			const [busy, setBusy] = react.useState(false);
			const alive = react.useRef(true);
			react.useEffect(() => {
				alive.current = true;
				return () => { alive.current = false; };
			}, []);

			const refresh = react.useCallback(async () => {
				try {
					const res = await run("/vision");
					if (!alive.current) return;
					const parsed = parseStatus(res);
					if (parsed === undefined) {
						setError(res?.ok === false ? String(res?.error?.message ?? "command failed") : null);
						return;
					}
					setError(null);
					setStatus(parsed);
				} catch (reason) {
					if (!alive.current) return;
					setError(reason instanceof Error ? reason.message : String(reason));
				}
			}, [run]);

			react.useEffect(() => { refresh(); }, [refresh]);

			const send = react.useCallback(async (line) => {
				setBusy(true);
				try {
					await run(line);
					await refresh();
				} catch (reason) {
					if (alive.current) setError(reason instanceof Error ? reason.message : String(reason));
				} finally {
					if (alive.current) setBusy(false);
				}
			}, [run, refresh]);

			// 状态还没拿到就什么都不渲染，避免 slot 里出现空壳或崩溃。
			if (status === undefined) {
				return error === null ? null
					: (0, react_jsx_runtime.jsx)("span", { className: "dvb_err", role: "status", title: error, children: t("failed") });
			}

			const on = status.enabled === true;
			return (0, react_jsx_runtime.jsxs)("span", {
				className: "dvb_wrap",
				children: [
					(0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						role: "switch",
						"aria-checked": on ? "true" : "false",
						"aria-label": t(on ? "aria.on" : "aria.off"),
						title: t(on ? "title.on" : "title.off"),
						className: "dvb_toggle",
						disabled: busy,
						onClick: () => send(on ? "/vision off" : "/vision on"),
						children: [
							(0, react_jsx_runtime.jsx)("span", { className: "dvb_dot", "aria-hidden": true }),
							t("label"),
						],
					}),
					on
						? (0, react_jsx_runtime.jsx)("select", {
							className: "dvb_select",
							"aria-label": t("model.aria"),
							title: t("model.aria"),
							value: status.model,
							disabled: busy,
							onChange: (event) => send("/vision model " + event.target.value),
							children: status.models.map((m) => (0, react_jsx_runtime.jsx)("option", {
								value: m.key,
								children: m.hasImage ? m.label : m.label + t("noImage"),
							}, m.key)),
						})
						: null,
					error !== null
						? (0, react_jsx_runtime.jsx)("span", { className: "dvb_err", role: "status", title: error, children: t("failed") })
						: null,
				],
			});
		}

		const inject = ["slots", "remote", "remote.commands", "locale"];

		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, { zh, en }), "vision-bridge: dictionaries");
			ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
				name: "conversation.composer.dock",
				id: "vision-bridge",
				order: 10,
				locale: NS,
				inject: (sessionId) => ({
					run: (line) => ctx.remote.commands.execute(sessionId, line, []),
				}),
			}, VisionChip));
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
