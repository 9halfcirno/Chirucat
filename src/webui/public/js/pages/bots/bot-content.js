import { createIconButton } from "../../spa/components/icon-button.js";

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
		.then(() => addPage(botNav, botMain, bot, "./bot-pages/setting.js"))

	async function addPage(nav, main, bot, url) {
		/**
		 * @type {{ icon: string; title: string; render: (div: HTMLElement) => void }}
		 */
		const module = (await import(url)).default;
		let iconBtn = createIconButton(module.icon, () => {
			if (currentPage === module.title) return;

			buttons.get(currentPage)?.classList.remove("show");
			iconBtn.classList.add("show");

			currentPage = module.title;

			main.replaceChildren();
			module.render(main, bot);
		});
		iconBtn.title = module.title;

		if (currentPage === null) {
			iconBtn.click();
		}
		buttons.set(module.title, iconBtn);

		nav.append(iconBtn);
	}

	return div;
}
