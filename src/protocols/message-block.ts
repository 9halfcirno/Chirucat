export type MessageBlock =
	| { type: "text"; text: string; }
	| { type: "mention"; id: string; name?: string; }
	| { type: "image"; url: string; file?: string; }
	| { type: "video", url: string, file?: string; }
	| { type: "audio", url: string; file?: string; }