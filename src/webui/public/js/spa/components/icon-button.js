/**
 * 
 * @param {string} src 图标URL
 * @param {number} size 图标尺寸
 * @param {(event: MouseEvent) => void} oncilck 点击回调
 */
export function createIconButton(src, oncilck) {
	const btn = document.createElement("button");
	const image = document.createElement("img");
	image.src = src; // 设定图片url
	btn.append(image);

	btn.onclick = oncilck;

	btn.classList.add("icon-btn")

	return btn;
}