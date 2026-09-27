import { createIconButton } from "../../spa/components/icon-button.js";
import { attachTooltip } from "../../spa/components/tooltip.js";

/**
 * 创建bot的弹窗内容
 * @param {{ name: string, id: string }} id Bot ID
 */
export function createBotContent(bot) {
	const div = document.createElement("div");
	div.classList.add("bot-div");

	const botNav = document.createElement("nav"); // bot侧边导航栏
	botNav.classList.add("bot-nav");
	div.append(botNav);

	const botMain = document.createElement("div");
	botMain.classList.add("bot-main");
	div.append(botMain);

	const buttons = new Map();
	let currentPage = null;

	Promise.resolve()
		.then(() => addPage(botNav, botMain, bot, "./bot-pages/info.js"))
		.then(() => addPage(botNav, botMain, bot, "./bot-pages/plugins.js"))
		.then(() => addPage(botNav, botMain, bot, "./bot-pages/filter.js"))
		.then(() => addPage(botNav, botMain, bot, "./bot-pages/setting.js"))

	async function addPage(nav, main, bot, url) {
		/**
		 * @type {{ icon: string; title: string; styles?: string[]; render: (div: HTMLElement, bot: any) => void }}
		 */
		const module = (await import(url)).default;
		// 子页声明的样式表
		ensureStyles(module.styles);

		let iconBtn = createIconButton(module.icon, () => {
			if (currentPage === module.title) return;

			buttons.get(currentPage)?.classList.remove("show");
			iconBtn.classList.add("show");

			currentPage = module.title;

			main.replaceChildren();
			module.render(main, bot);
		});
		iconBtn.setAttribute("aria-label", module.title);
		attachTooltip(iconBtn, module.title);

		if (currentPage === null) {
			iconBtn.click();
		}
		buttons.set(module.title, iconBtn);

		nav.append(iconBtn);
	}

	return div;
}

/**
 * 按需插入子页声明的样式表
 *
 * framework.js 里的页面样式会随导航卸载, 弹窗子页则只做一次幂等插入 ——
 * 弹窗生命周期短, 卸载回来还要重插, 收益不值当。
 * @param {string[]} [urls]
 */
function ensureStyles(urls) {
	for (const url of urls ?? []) {
		if (document.head.querySelector(`link[rel="stylesheet"][href="${url}"]`)) continue;

		const link = document.createElement("link");
		link.rel = "stylesheet";
		link.href = url;
		document.head.appendChild(link);
	}
}
