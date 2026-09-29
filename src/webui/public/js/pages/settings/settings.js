/**
 * 设置页面
 *
 * 页面骨架只做一件事: 拉取全部设置域, 然后**按域生成二级侧栏** —— 每个域一项,
 * 点哪一项就渲染哪个域的表单。
 *
 * 域列表与设置项全部来自后端 (`get_settings`): 这里既不硬编码设置项, 也不硬编码
 * 域名 —— 后端加一个域, 侧栏就多一项。
 *
 * 能在 render 里动态写 `this.sidebar` 是因为 framework 的导航顺序是先
 * `await page.render(view)`, 之后才 `await renderSideBar(page, view)`。
 */
import { callAPI } from "../../spa/api.js";
import { createButton } from "../../spa/components/button.js";
import { createConfigList } from "../../spa/components/config-editor.js";
import toast from "../../spa/toast.js";

/** 域 id → 侧栏展示名; 未列出的域直接显示 id */
const DOMAIN_TITLES = {
	core: "核心",
	webui: "WebUI",
	statistics: "统计",
	logging: "日志级别",
};

export default {
	title: "设置",
	styles: ["/js/pages/settings/setting.css"],
	/** 由 render 按后端返回的域填充 */
	sidebar: [],

	async render(container) {
		container.replaceChildren();

		const status = document.createElement("p");
		status.className = "muted";
		status.textContent = "加载中...";
		container.append(status);

		let domains;
		try {
			const payload = await callAPI("get_settings", null, "GET");
			domains = Array.isArray(payload?.domains) ? payload.domains : [];
		} catch (e) {
			this.sidebar = [];
			status.textContent = `读取设置失败: ${e.message}`;
			return;
		}

		if (domains.length === 0) {
			this.sidebar = [];
			status.textContent = "当前没有可设置的项";
			return;
		}

		status.remove();
		this.sidebar = domains.map((domain) => ({
			title: DOMAIN_TITLES[domain.id] ?? domain.id,
			render: (div) => { div.append(createDomainForm(domain)); },
		}));

		// 兜底: 二级侧栏由 framework 在 render **之后**接管。若它没接管(例如页面上没有
		// #side-bar), 菜单不会出现, 而本页的 render 本身不产内容 —— 那就是一张白页。
		// 这里退化成"全部域平铺", 保证设置项在任何情况下都看得见、改得了。
		setTimeout(() => {
			if (container.querySelector(".spa-sidebar-content")) return;
			for (const domain of domains) container.append(createDomainForm(domain));
		}, 60);
	},
};

/**
 * 一个设置域的表单: 控件树 + 保存
 *
 * @param {{ id: string, define: object, values: object }} domain
 * @returns {HTMLElement}
 */
function createDomainForm(domain) {
	const wrapper = document.createElement("div");
	wrapper.classList.add("settings-domain");

	const list = createConfigList(domain.define);
	list.setValues(domain.values ?? {});

	const save = createButton("保存", () => handleSave(domain, list));
	wrapper.append(list.el, save);
	return wrapper;
}

/**
 * 提交该域的改动
 *
 * 提交整份 getValues() 而不是自己算差集: 后端按 patch 语义合并, 未提交的字段
 * 保留原值, 隐藏项(visible 为假)本来就不参与校验 —— 前端再算一份差集只会多一份
 * 可能与后端不一致的规则。
 *
 * @param {{ id: string }} domain
 * @param {ReturnType<typeof createConfigList>} list
 */
async function handleSave(domain, list) {
	const localErrors = list.validate();
	if (localErrors.length > 0) {
		toast(`有 ${localErrors.length} 项未填完整, 请先修正`, { type: "warn" });
		return;
	}

	const patch = list.getValues();

	let result;
	try {
		result = await callAPI("update_settings", {
			domain: domain.id,
			patch,
		});
	} catch (e) {
		toast(`保存失败: ${e.message}`, { type: "error" });
		return;
	}

	// 需要重启的项如实提示, 不谎报"已生效"(机制保留, 当前没有域用到)
	const restart = Array.isArray(result?.restartRequired) ? result.restartRequired : [];
	if (restart.length > 0) {
		toast(`已保存; ${restart.join("、")} 需重启 Core 后生效`, { type: "warn", duration: 6000 });
	} else {
		toast("设置已保存", { type: "info" });
	}

	// 用后端回传的规范化值回填 (数字项可能已从字符串转成数字)
	if (result?.values) list.setValues(result.values);

	// 换监听端口: 服务器马上会先关旧监听再在新端口上重开, 这个页面所在的原址会失效
	const nextPort = Number(patch?.port);
	if (domain.id === "webui" && Number.isInteger(nextPort) && String(nextPort) !== location.port) {
		const url = `${location.protocol}//${location.hostname}:${nextPort}/`;
		toast(`监听端口已改为 ${nextPort}, 即将跳转到 ${url}`, { type: "warn", duration: 8000 });
		setTimeout(() => { location.href = url; }, 2000);
		return;
	}

	// 换密码: token 由密码派生密钥签发, 所有会话(含当前这条)立即失效
	if (domain.id === "webui" && typeof patch?.password === "string" && patch.password !== "") {
		toast("密码已更新, 所有会话已失效, 请重新登录", { type: "warn", duration: 8000 });
	}
}
