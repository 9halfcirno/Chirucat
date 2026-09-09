import { apiFetch } from "../../../spa/auth.js"
import { createDialogWindow } from "../../../spa/components/dialog-window.js"
import { createIconButton } from "../../../spa/components/icon-button.js"
import toast from "../../../spa/toast.js"

export default {
	icon: "/img/icons/setting.svg",
	title: "设置",

	/**
	 * 
	 * @param {HTMLElement} div 
	 */
	render(div, bot) {
		let delDes = document.createElement("div");
		delDes.style.color = "darkred";
		delDes.textContent = "删除Bot";

		let del = createIconButton("/img/icons/delete.svg", () => {
			let ensure = createDialogWindow("删除Bot确认?",
				`确定停用并删除Bot ${bot.id}? 此操作无法撤销!
</br></br>将删除的数据包括:
</br>- Bot配置, 状态文件, 数据文件
</br>- Bot独立插件, 插件配置, 插件数据
</br></br><strong>请认真考虑!</strong>`, [
				{
					name: "确定",
					onclick: async () => {
						try {
							ensure.closeDialog();
							let res = await apiFetch("/api/delete_bot", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
								},
								body: JSON.stringify({
									id: bot.id
								})
							})
							if (res.ok) {
								toast(`删除Bot ${bot.id}成功!`, {
									type: "info"
								})
								let base = div.closest(".dialog-window-base");
								
								base.closeDialog();
								document.body.querySelector(".bot-refresh-btn").click();
							}
							else throw new Error(`HTTP: ${res.status}`)

						} catch (e) {
							ensure.closeDialog();
							toast(`删除Bot失败: ${e.message}`, {
								type: "error"
							})
						}
					}
				},
				{
					name: "取消",
					onclick: () => {
						ensure.closeDialog();
					}
				}
			], true)

			document.body.append(ensure);
		})
		del.style.width = "2.75em";
		del.style.height = "2.75em";

		div.append(delDes, del)
	}
}
