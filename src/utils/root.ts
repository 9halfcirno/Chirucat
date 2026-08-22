import fs from "fs";
import path from "path";

const projectRoot = (() => {
	let now = import.meta.dirname;
	while (true) {
		if (fs.existsSync(path.resolve(now, "package.json")))
			return now;

		let parent = path.dirname(now);

		if (parent === now) throw new Error(`无法定位 package.json, 无法确定项目目录`)
		
		now = parent

	}
})()

export { projectRoot as root }