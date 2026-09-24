/**
 * 测试页面: 插件配置链路的手动测试面板
 *
 * 把整条链路摊开给手动验:
 *   get_bot_list → get_plugin_list → get_plugin_config → (表单编辑) → update_plugin_config
 *
 * 每个请求与响应都会按时间倒序打到下方的输出区, 错误响应里的 details
 * (字段级校验错误) 也会单独列出来, 方便和后端对账。
 *
 * 建议试的用例:
 * - 展开分组填点东西 → 关掉分组(隐藏) → 保存 → 重新读取: 值应该还在
 *   (前端不提交隐藏项, 后端保留旧值)
 * - 清空必填项 → 保存: 后端返回 400, details 里点名出错字段
 * - 保存后用 [查看 getValues()] 对比表单值与后端回传的规范化值
 */
import { apiFetch } from "../../spa/auth.js";
import { createButton } from "../../spa/components/button.js";
import { createConfigList } from "../../spa/components/config-editor.js";
import toast from "../../spa/toast.js";

export default {
	id: "test",
	title: "测试页面",

	/**
	 * @param {HTMLDivElement} container
	 */
	render(container) {
		let head = document.createElement("h3");
		head.textContent = `欢迎来到Chirucat WebUI实验室!`;
		container.append(head);

		let rebootBtn = createButton("重启Chirucat Core", async () => {
			toast(`核心重启请求已发送!`);
			await apiFetch("/api/reboot_core").catch(e => void 0); // 忽略错误, 因为fetch会立即失败
		})

		container.append(rebootBtn);
	},


	sidebar: [
		{
			title: "项一",
			render(container) {
				container.innerHTML = `<h2>项一</h2><p class="muted">这里是项一的内容</p>`;
			},
		},
		{
			title: "项二",
			render(container) {
				container.innerHTML = `<h2>项二</h2><p class="muted">这里是项二的内容</p>`;
			},
		},
		{
			title: "项三",
			render(container) {
				container.innerHTML = `<h2>项三</h2><p class="muted">这里是项三的内容</p>`;
			},
		},
	],
};