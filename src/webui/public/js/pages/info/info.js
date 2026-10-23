/**
 * 关于页
 *
 * 布局: 品牌区 (Logo + 名称 + 简要描述) / 分隔线 / 左右两栏
 * 左栏放项目描述, 右栏放链接列表与技术栈 (排版参考 webui_about.md)。
 */

/** 链接列表: 图标沿用 img/icons 下的现成资源 (以 mask 渲染, 跟随主题色) */
const LINKS = [
	{
		icon: "/img/icons/cube.svg",
		label: "GitHub 仓库",
		url: "github.com/9halfcirno/Chirucat",
		href: "https://github.com/9halfcirno/Chirucat",
	},
	{
		icon: "/img/icons/plugin.svg",
		label: "插件开发指南",
		url: "github.com/9halfcirno/Chirucat/tree/main/docs/plugin",
		href: "https://github.com/9halfcirno/Chirucat/tree/main/docs/plugin",
	},
	{
		icon: "/img/icons/info.svg",
		label: "问题反馈",
		url: "github.com/9halfcirno/Chirucat/issues",
		href: "https://github.com/9halfcirno/Chirucat/issues",
	},
	{
		icon: "/img/icons/license.svg",
		label: "MIT 许可证",
		url: "github.com/9halfcirno/Chirucat/blob/main/LICENSE",
		href: "https://github.com/9halfcirno/Chirucat/blob/main/LICENSE",
	},
	{
		icon: "/img/icons/todo.svg",
		label: "更新计划",
		url: "github.com/9halfcirno/Chirucat/blob/main/TODO.md",
		href: "https://github.com/9halfcirno/Chirucat/blob/main/TODO.md",
	},
];

/** 技术栈 (与 package.json 的依赖及前端实现一致) */
const STACK = ["Node.js", "TypeScript", "Express", "better-sqlite3", "esbuild", "原生 SPA"];

/** 项目描述: 左栏的三段文字 */
const DESCRIPTIONS = [
	["跨平台", "Bot 可通过适配器在不同平台使用, 并关联用户。"],
	["多 Bot", "可创建多个 Bot 以搭载不同插件, 实现互相独立的功能内容。"],
	["插件即功能", "机器人的各自功能均由插件决定, 以及出现在不同平台。"],
	["Chirucat名字的由来", [
		"这个名字前半部分的\"Chiru\", 取自东方角色「琪露诺」的日文罗马音的前两个音",
		"后半部分的\"cat\", 继承自 9halfcirno 的旧Bot框架「Nodecat」"
	]],
	
];

export default {
	id: "info",
	title: "关于",
	styles: ["/js/pages/info/info.css"],

	render(container) {
		container.replaceChildren(createPage());
	},
};

/** 组装整页 */
function createPage() {
	const page = document.createElement("div");
	page.className = "info-page";

	const divider = document.createElement("hr");
	divider.className = "info-divider";

	const columns = document.createElement("div");
	columns.className = "info-columns";
	columns.append(createDescriptionSection(), createSideColumn());

	page.append(createHero(), divider, columns);
	return page;
}

/** 品牌区: Logo 左侧, 名称与简要描述在右 */
function createHero() {
	const hero = document.createElement("header");
	hero.className = "info-hero";

	const logo = document.createElement("img");
	logo.className = "info-logo";
	logo.src = "/favicon.png";
	logo.alt = "Chirucat";

	const heading = document.createElement("div");
	heading.className = "info-heading";

	const title = document.createElement("h1");
	title.className = "info-title";
	title.textContent = "Chirucat - ψ(｀∇´)ψ";

	const subtitle = document.createElement("p");
	subtitle.className = "info-subtitle";
	subtitle.textContent = "采用 Core + Adapter 架构的高性能跨平台多 Bot 框架";

	heading.append(title, subtitle);
	hero.append(logo, heading);
	return hero;
}

/** 左栏: 项目描述 */
function createDescriptionSection() {
	const section = document.createElement("section");
	section.className = "info-section";

	const head = document.createElement("h2");
	head.className = "info-section-title";
	head.textContent = "关于 Chirucat";

	const desc = document.createElement("div");
	desc.className = "info-desc";

	for (const [name, text] of DESCRIPTIONS) {
		const strong = document.createElement("strong");
		strong.textContent = name;

		if (!text) continue;
		if (!Array.isArray(text)) {
			const p = document.createElement("p");
			p.append(strong, document.createTextNode(` ${text}`));
			desc.appendChild(p);
		} else {
			const p = document.createElement("p");
			p.appendChild(strong);
			desc.appendChild(p);

			const ul = document.createElement("ul");
			for (const t of text) {
				const li = document.createElement("li");
				li.textContent = t;
				ul.appendChild(li);
			}
			desc.appendChild(ul);
		}
	}

	const note = document.createElement("p");
	note.className = "info-note";
	note.textContent = "目前仍在开发阶段, 功能尚不完善, 会持续更新。";
	desc.appendChild(note);

	section.append(head, desc);
	return section;
}

/** 右栏: 链接列表 + 技术栈 */
function createSideColumn() {
	const side = document.createElement("aside");
	side.className = "info-side";
	side.append(createLinksSection(), createStackSection());
	return side;
}

function createLinksSection() {
	const section = document.createElement("section");
	section.className = "info-section";

	const head = document.createElement("h2");
	head.className = "info-section-title";
	head.textContent = "链接";

	const list = document.createElement("ul");
	list.className = "info-links";
	for (const item of LINKS) list.appendChild(createLinkItem(item));

	section.append(head, list);
	return section;
}

function createLinkItem({ icon, label, url, href }) {
	const li = document.createElement("li");

	const link = document.createElement("a");
	link.className = "info-link";
	link.href = href;
	link.target = "_blank";
	link.rel = "noopener noreferrer";
	link.title = `${label} · ${url}`;

	const iconEl = document.createElement("span");
	iconEl.className = "icon";
	iconEl.setAttribute("aria-hidden", "true");
	iconEl.style.setProperty("--icon", `url("${icon}")`);

	const body = document.createElement("span");
	body.className = "info-link-body";

	const labelEl = document.createElement("span");
	labelEl.className = "info-link-label";
	labelEl.textContent = label;

	const urlEl = document.createElement("span");
	urlEl.className = "info-link-url";
	urlEl.textContent = url;

	body.append(labelEl, urlEl);
	link.append(iconEl, body);
	li.appendChild(link);
	return li;
}

function createStackSection() {
	const section = document.createElement("section");
	section.className = "info-section";

	const head = document.createElement("h2");
	head.className = "info-section-title";
	head.textContent = "技术栈";

	const list = document.createElement("ul");
	list.className = "info-stack";
	for (const name of STACK) {
		const li = document.createElement("li");
		li.className = "info-chip";
		li.textContent = name;
		list.appendChild(li);
	}

	section.append(head, list);
	return section;
}
