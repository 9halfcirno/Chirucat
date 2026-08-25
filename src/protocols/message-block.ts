export type MessageBlock =
	| { type: "text"; text: string; }
	| { type: "image"; url: string; file?: string; }
	| { type: "mention"; id: string;  }
