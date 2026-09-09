export default {
	icon: "/img/icons/info.svg",
	title: "信息",

	/**
	 * 
	 * @param {HTMLElement} div 
	 */
	render(div, bot) {
		div.innerHTML = `
		<div>id: ${bot.id}</div><div>name: ${bot.name}</div>
		`
	}
}